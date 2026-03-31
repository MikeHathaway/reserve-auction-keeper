import {
  type PublicClient,
  type WalletClient,
  createPublicClient,
  createWalletClient,
  http,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { AppConfig, ResolvedChainConfig } from "./config.js";
import { discoverPools, getPoolReserveStates, canKickReserveAuction } from "./auction/discovery.js";
import { getAuctionPrices } from "./auction/auction-price.js";
import { createCoingeckoClient } from "./pricing/coingecko.js";
import { createPriceOracle } from "./pricing/oracle.js";
import { createUniswapV3DexQuoter } from "./pricing/uniswap-v3.js";
import { createFundedStrategy } from "./strategies/funded.js";
import { createFlashArbStrategy } from "./strategies/flash-arb.js";
import type { ExecutionStrategy, AuctionContext } from "./strategies/interface.js";
import { createFlashbotsSubmitter } from "./execution/flashbots.js";
import { createPrivateRpcSubmitter } from "./execution/private-rpc.js";
import type { MevSubmitter } from "./execution/mev-submitter.js";
import {
  checkGasPrice,
  isNearProfitableAfterGas,
  isProfitableAfterGas,
} from "./execution/gas.js";
import { POOL_ABI } from "./contracts/abis/index.js";
import { logger } from "./utils/logger.js";

let shutdownRequested = false;

export function requestShutdown() {
  shutdownRequested = true;
  logger.info("Shutdown requested, finishing current cycle...");
}

interface ChainKeeper {
  chainConfig: ResolvedChainConfig;
  publicClient: PublicClient;
  walletClient: WalletClient;
  strategy: ExecutionStrategy;
  submitter: MevSubmitter;
  pools: Address[];
}

function getFlashArbRoute(
  resolved: ResolvedChainConfig,
  config: AppConfig,
) {
  return config.flashArb.routes[
    resolved.chainConfig.name as keyof typeof config.flashArb.routes
  ];
}

function createStrategy(
  resolved: ResolvedChainConfig,
  config: AppConfig,
  publicClient: PublicClient,
  walletClient: WalletClient,
  submitter: MevSubmitter,
): ExecutionStrategy {
  if (config.strategy === "flash-arb") {
    const route = getFlashArbRoute(resolved, config);

    return createFlashArbStrategy(publicClient, walletClient, submitter, {
      maxSlippagePercent: config.flashArb.maxSlippagePercent,
      minLiquidityUsd: config.flashArb.minLiquidityUsd,
      minProfitUsd: config.flashArb.minProfitUsd,
      executorAddress: config.flashArb.executorAddress,
      dryRun: config.dryRun,
      route: route
        ? {
            executorAddress: route.executorAddress,
            flashLoanPools: route.flashLoanPools,
            quoteToAjnaPaths: route.quoteToAjnaPaths,
          }
        : undefined,
      dexQuoter: route
        ? createUniswapV3DexQuoter(publicClient, {
            quoterAddress: route.quoterAddress,
            quoteToAjnaPaths: route.quoteToAjnaPaths,
            label: `${resolved.chainConfig.name}.flashArb`,
          })
        : undefined,
    });
  }

  return createFundedStrategy(
    publicClient,
    walletClient,
    resolved.chainConfig.ajnaToken,
    submitter,
    {
      targetExitPriceUsd: config.funded.targetExitPriceUsd,
      maxTakeAmount: config.funded.maxTakeAmount,
      autoApprove: config.funded.autoApprove,
      profitMarginPercent: config.profitMarginPercent,
      dryRun: config.dryRun,
    },
  );
}

function createChainKeeper(
  resolved: ResolvedChainConfig,
  config: AppConfig,
): ChainKeeper {
  const account = privateKeyToAccount(config.secrets.privateKey);

  const publicClient = createPublicClient({
    chain: resolved.chainConfig.chain,
    transport: http(resolved.rpcUrl),
  });

  // For MEV-protected submission, use private RPC transport if available
  const walletTransportUrl =
    resolved.chainConfig.mevMethod === "flashbots"
      ? resolved.rpcUrl // Flashbots submitter handles bundle separately
      : resolved.privateRpcUrl || resolved.rpcUrl;

  const walletClient = createWalletClient({
    account,
    chain: resolved.chainConfig.chain,
    transport: http(walletTransportUrl),
  });

  const submitter: MevSubmitter =
    resolved.chainConfig.mevMethod === "flashbots"
      ? createFlashbotsSubmitter(publicClient, walletClient, config.secrets.flashbotsAuthKey)
      : createPrivateRpcSubmitter(publicClient, walletClient, resolved.privateRpcUrl);

  if (!config.dryRun && !submitter.supportsLiveSubmission) {
    throw new Error(
      `Live ${submitter.name} submission is not implemented for ${resolved.chainConfig.name}. Refusing unsafe execution.`,
    );
  }

  if (!config.dryRun && config.strategy === "flash-arb") {
    const route = getFlashArbRoute(resolved, config);
    const executorAddress = route?.executorAddress || config.flashArb.executorAddress;

    if (!route) {
      throw new Error(
        `Flash-arb route config is required for live ${resolved.chainConfig.name} execution.`,
      );
    }

    if (!executorAddress) {
      throw new Error(
        `Flash-arb executorAddress is required for live ${resolved.chainConfig.name} execution.`,
      );
    }
  }

  const strategy = createStrategy(
    resolved,
    config,
    publicClient,
    walletClient,
    submitter,
  );

  return {
    chainConfig: resolved,
    publicClient,
    walletClient,
    strategy,
    submitter,
    pools: [],
  };
}

async function runChainLoop(keeper: ChainKeeper, config: AppConfig): Promise<void> {
  const { chainConfig, publicClient, strategy } = keeper;
  const chainName = chainConfig.chainConfig.name;
  const coingecko = createCoingeckoClient(config.secrets.coingeckoApiKey);
  const oracle = createPriceOracle(coingecko, chainConfig.chainConfig);

  logger.info("Starting keeper loop", { chain: chainName });

  // Initial pool discovery
  keeper.pools = await discoverPools(
    publicClient,
    chainConfig.chainConfig,
    chainConfig.pools,
  );

  logger.info("Monitoring pools", {
    chain: chainName,
    count: keeper.pools.length,
  });

  let rediscoveryCounter = 0;
  const REDISCOVERY_INTERVAL = 50; // Re-discover pools every 50 cycles

  while (!shutdownRequested) {
    try {
      // Periodically re-discover pools
      rediscoveryCounter++;
      if (rediscoveryCounter >= REDISCOVERY_INTERVAL) {
        rediscoveryCounter = 0;
        keeper.pools = await discoverPools(
          publicClient,
          chainConfig.chainConfig,
          chainConfig.pools.length > 0 ? chainConfig.pools : undefined,
        );
      }

      // 1. Get reserve states for all pools
      const poolStates = await getPoolReserveStates(
        publicClient,
        chainConfig.chainConfig,
        keeper.pools,
      );

      // 2. Separate active auctions and kickable pools
      const activeAuctions = poolStates.filter((s) => s.hasActiveAuction);
      const kickable = poolStates.filter((s) => s.isKickable);

      // 3. Get auction prices for active auctions
      const activePools = activeAuctions.map((a) => a.pool);
      const auctionPrices = await getAuctionPrices(
        publicClient,
        chainConfig.chainConfig,
        activePools,
      );
      const priceCache = new Map<string, ReturnType<typeof oracle.getPrices>>();
      const gasCheckPromise = activeAuctions.length > 0
        ? checkGasPrice(
            publicClient,
            config.gasPriceCeilingGwei,
            200_000n,
            chainConfig.chainConfig.nativeTokenPriceUsd,
          )
        : null;

      // 4. Evaluate and execute on each active auction
      let anyNearProfitable = false;

      for (const poolState of activeAuctions) {
        const priceInfo = auctionPrices.get(poolState.pool);
        if (!priceInfo) continue;

        let pricesPromise = priceCache.get(poolState.quoteTokenSymbol);
        if (!pricesPromise) {
          pricesPromise = oracle.getPrices(poolState.quoteTokenSymbol);
          priceCache.set(poolState.quoteTokenSymbol, pricesPromise);
        }

        const prices = await pricesPromise;
        if (!prices) continue;

        if (prices.isStale) {
          logger.warn("Skipping execution due to stale prices", {
            chain: chainName,
            pool: poolState.pool,
          });
          continue;
        }

        const ctx: AuctionContext = {
          poolState,
          auctionPrice: priceInfo.auctionPrice,
          prices,
          chainName,
        };

        const profit = await strategy.estimateProfit(ctx);
        const gasCheck = await gasCheckPromise!;

        if (
          isNearProfitableAfterGas(
            profit,
            gasCheck.estimatedCostUsd,
            config.profitMarginPercent,
            config.polling.profitabilityThreshold,
          )
        ) {
          anyNearProfitable = true;
        }

        if (gasCheck.isAboveCeiling) continue;

        if (!isProfitableAfterGas(
          profit,
          gasCheck.estimatedCostUsd,
          config.profitMarginPercent,
        )) {
          logger.debug("Not yet profitable", {
            chain: chainName,
            pool: poolState.pool,
            estimatedProfitUsd: profit.toFixed(4),
            gasCostUsd: gasCheck.estimatedCostUsd.toFixed(4),
          });
          continue;
        }

        const canExec = await strategy.canExecute(ctx);
        if (!canExec) continue;

        try {
          const result = await strategy.execute(ctx);
          logger.info("Execution successful", {
            chain: chainName,
            pool: result.pool,
            submissionMode: result.submissionMode,
            txHash: result.txHash,
            bundleHash: result.bundleHash,
            targetBlock: result.targetBlock?.toString(),
            profitUsd: result.profitUsd.toFixed(4),
          });
        } catch (error) {
          logger.error("Execution failed", {
            chain: chainName,
            pool: poolState.pool,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // 5. Kick reserve auctions if eligible
      for (const poolState of kickable) {
        if (shutdownRequested) break;

        const canKick = await canKickReserveAuction(publicClient, poolState.pool);
        if (!canKick) {
          logger.debug("Cannot kick auction (unsettled liquidations or other reason)", {
            chain: chainName,
            pool: poolState.pool,
          });
          continue;
        }

        logger.info("Kicking reserve auction", {
          chain: chainName,
          pool: poolState.pool,
          dryRun: config.dryRun,
        });

        if (!config.dryRun) {
          try {
            const hash = await keeper.walletClient.writeContract({
              address: poolState.pool,
              abi: POOL_ABI,
              functionName: "kickReserveAuction",
              chain: publicClient.chain,
              account: keeper.walletClient.account!,
            });

            logger.info("Reserve auction kicked", {
              chain: chainName,
              pool: poolState.pool,
              hash,
            });
          } catch (error) {
            logger.error("Failed to kick reserve auction", {
              chain: chainName,
              pool: poolState.pool,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }

      // 6. Adaptive sleep
      const sleepMs = anyNearProfitable
        ? config.polling.activeIntervalMs
        : config.polling.idleIntervalMs;

      await sleep(sleepMs);
    } catch (error) {
      logger.error("Chain loop error, continuing to next cycle", {
        chain: chainName,
        error: error instanceof Error ? error.message : String(error),
      });
      await sleep(config.polling.idleIntervalMs);
    }
  }

  logger.info("Chain loop stopped", { chain: chainName });
}

export function sleep(
  ms: number,
  shouldWake: () => boolean = () => shutdownRequested,
  wakeCheckIntervalMs: number = 1000,
): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(check);
      resolve();
    };

    const timer = setTimeout(finish, ms);
    const check = setInterval(() => {
      if (shouldWake()) {
        finish();
      }
    }, wakeCheckIntervalMs);
  });
}

export async function startKeeper(config: AppConfig): Promise<void> {
  logger.info("Starting Ajna Reserve Auction Keeper", {
    strategy: config.strategy,
    chains: config.chains.map((c) => c.chainConfig.name),
    dryRun: config.dryRun,
  });

  const keepers = config.chains.map((chain) => createChainKeeper(chain, config));

  // Run all chain loops concurrently, with error isolation
  const loops = keepers.map((keeper) =>
    runChainLoop(keeper, config).catch((error) => {
      logger.alert("Chain loop crashed", {
        chain: keeper.chainConfig.chainConfig.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }),
  );

  await Promise.all(loops);
  logger.info("All keeper loops stopped");
}
