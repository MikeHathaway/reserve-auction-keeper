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
import { createFundedStrategy } from "./strategies/funded.js";
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

  const strategy = createFundedStrategy(
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

      // 4. Evaluate and execute on each active auction
      let anyNearProfitable = false;

      for (const poolState of activeAuctions) {
        const priceInfo = auctionPrices.get(poolState.pool);
        if (!priceInfo) continue;

        const prices = await oracle.getPrices(poolState.quoteTokenSymbol);
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

        const profit = strategy.estimateProfit(ctx);
        const gasCheck = await checkGasPrice(
          publicClient,
          config.gasPriceCeilingGwei,
        );

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
            hash: result.hash,
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Allow immediate wake on shutdown
    const check = setInterval(() => {
      if (shutdownRequested) {
        clearTimeout(timer);
        clearInterval(check);
        resolve();
      }
    }, 1000);
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
