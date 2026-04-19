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
import {
  discoverPools,
  getPoolReserveStates,
  canKickReserveAuction,
  type PoolMetadata,
} from "./auction/discovery.js";
import {
  estimateKickClaimableValueUsd,
  kickReserveAuction,
} from "./auction/kick.js";
import { createCoingeckoClient } from "./pricing/coingecko.js";
import {
  createAlchemyPricesClient,
  type AlchemyPricesClient,
} from "./pricing/alchemy.js";
import { createPriceOracle } from "./pricing/oracle.js";
import { createFundedStrategy } from "./strategies/funded.js";
import { createFlashArbStrategy } from "./strategies/flash-arb.js";
import type { ExecutionStrategy, AuctionContext } from "./strategies/interface.js";
import { createFlashbotsSubmitter } from "./execution/flashbots.js";
import { createPrivateRpcSubmitter } from "./execution/private-rpc.js";
import type { MevSubmitter, PendingSubmission, SubmissionResult } from "./execution/mev-submitter.js";
import { PendingSubmissionError, waitForConfirmedReceipt } from "./execution/receipt.js";
import {
  clearPendingSubmission as clearPersistedPendingSubmission,
  loadPendingSubmission,
  savePendingSubmission,
  type PendingSubmissionRecord,
} from "./execution/pending-submission-store.js";
import {
  evaluateGasCost,
  getNextBlockSafeFeeCapOverrides,
  getNextBlockSafeGasPriceWei,
  isNearProfitableAfterCosts,
  isProfitableAfterCosts,
  sumEstimatedCostsUsd,
} from "./execution/gas.js";
import { getErrorMessage, isTransientRpcError } from "./utils/retry.js";
import {
  clearAllHealthDependencies,
  setHealthDependency,
  setHealthy,
} from "./utils/health.js";
import { logger } from "./utils/logger.js";

let shutdownRequested = false;

export function requestShutdown() {
  if (shutdownRequested) return;
  shutdownRequested = true;
  setHealthy(false);
  logger.info("Shutdown requested, finishing current cycle...");
}

interface ChainKeeper {
  chainConfig: ResolvedChainConfig;
  publicClient: PublicClient;
  walletClient: WalletClient;
  strategy: ExecutionStrategy;
  submitter: MevSubmitter;
  pools: PoolMetadata[];
}

type PendingSubmissionState = PendingSubmissionRecord;

const FLASHBOTS_PENDING_BLOCK_GRACE = 2n;
const PRIVATE_RPC_PENDING_EXPIRY_MS = 120_000;

function getSubmitterHealthDependencyKey(keeper: ChainKeeper): string {
  return `submitter:${keeper.chainConfig.chainConfig.name}:${keeper.submitter.name}`;
}

function getPricingHealthDependencyKey(chainName: string): string {
  return `pricing:${chainName}`;
}

function getRpcHealthDependencyKey(chainName: string): string {
  return `rpc:${chainName}`;
}

function getPendingSubmissionHealthDependencyKey(chainName: string): string {
  return `submission:${chainName}`;
}

function refreshPricingHealth(
  chainName: string,
  quoteTokenSymbols: string[],
  priceCache: Map<string, { isStale: boolean } | null>,
): void {
  const dependencyKey = getPricingHealthDependencyKey(chainName);
  if (quoteTokenSymbols.length === 0) {
    setHealthDependency(dependencyKey, true);
    return;
  }

  const missing: string[] = [];
  const stale: string[] = [];

  for (const symbol of quoteTokenSymbols) {
    const prices = priceCache.get(symbol) ?? null;
    if (!prices) {
      missing.push(symbol);
      continue;
    }
    if (prices.isStale) {
      stale.push(symbol);
    }
  }

  const healthy = missing.length === 0 && stale.length === 0;
  const reason = healthy
    ? undefined
    : [
        missing.length > 0 ? `missing prices: ${missing.join(",")}` : undefined,
        stale.length > 0 ? `stale prices: ${stale.join(",")}` : undefined,
      ].filter(Boolean).join("; ");

  setHealthDependency(dependencyKey, healthy, reason);
}

async function refreshSubmitterHealth(
  keeper: ChainKeeper,
  config: AppConfig,
): Promise<boolean> {
  const dependencyKey = getSubmitterHealthDependencyKey(keeper);

  if (config.dryRun) {
    setHealthDependency(dependencyKey, true, "dry-run");
    return true;
  }

  try {
    const isHealthy = await keeper.submitter.isHealthy();
    setHealthDependency(
      dependencyKey,
      isHealthy,
      isHealthy ? undefined : "submission endpoint unavailable",
    );
    return isHealthy;
  } catch (error) {
    const formattedError = getErrorMessage(error);
    setHealthDependency(
      dependencyKey,
      false,
      formattedError,
    );
    logger.warn("Submitter health check failed", {
      chain: keeper.chainConfig.chainConfig.name,
      submitter: keeper.submitter.name,
      error: formattedError,
    });
    return false;
  }
}

async function pauseIfSubmitterBecameUnhealthy(
  keeper: ChainKeeper,
  config: AppConfig,
  operation: "execution" | "reserve-auction kick",
  pool: Address,
): Promise<boolean> {
  if (config.dryRun) {
    return false;
  }

  const isHealthy = await refreshSubmitterHealth(keeper, config);
  if (isHealthy) {
    return false;
  }

  logger.warn("Submission endpoint became unhealthy mid-cycle, pausing further live submissions", {
    chain: keeper.chainConfig.chainConfig.name,
    submitter: keeper.submitter.name,
    operation,
    pool,
  });
  return true;
}

async function preflightLiveSubmitters(
  keepers: ChainKeeper[],
  config: AppConfig,
): Promise<void> {
  await Promise.all(keepers.map(async (keeper) => {
    if (config.dryRun) {
      await refreshSubmitterHealth(keeper, config);
      return;
    }

    const isReady = keeper.submitter.preflightLiveSubmissionReadiness
      ? await keeper.submitter.preflightLiveSubmissionReadiness()
      : await refreshSubmitterHealth(keeper, config);

    if (!isReady) {
      setHealthDependency(
        getSubmitterHealthDependencyKey(keeper),
        false,
        "startup live-submission preflight failed",
      );
      throw new Error(
        `Live ${keeper.submitter.name} submission is unhealthy for ${keeper.chainConfig.chainConfig.name}. Refusing startup.`,
      );
    }

    setHealthDependency(getSubmitterHealthDependencyKey(keeper), true);
  }));
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
      ajnaToken: resolved.chainConfig.ajnaToken,
      nativeTokenPriceUsd: resolved.chainConfig.nativeTokenPriceUsd,
      dryRun: config.dryRun,
      route,
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
        nativeTokenPriceUsd: resolved.chainConfig.nativeTokenPriceUsd,
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
    transport: http(resolved.rpcUrl, { batch: true }),
    batch: { multicall: true },
  });

  // For MEV-protected submission, use private RPC transport if available
  const walletTransportUrl =
    resolved.chainConfig.mevMethod === "flashbots"
      ? resolved.rpcUrl // Flashbots submitter handles bundle separately
      : resolved.privateRpcUrl || resolved.rpcUrl;

  const walletClient = createWalletClient({
    account,
    chain: resolved.chainConfig.chain,
    transport: http(walletTransportUrl, { batch: true }),
  });

  const submitter: MevSubmitter =
    resolved.chainConfig.mevMethod === "flashbots"
      ? createFlashbotsSubmitter(publicClient, walletClient, config.secrets.flashbotsAuthKey)
      : createPrivateRpcSubmitter(
          publicClient,
          walletClient,
          resolved.privateRpcUrl,
          resolved.privateRpcTrusted,
        );

  if (!config.dryRun && !submitter.supportsLiveSubmission) {
    throw new Error(
      `Live ${submitter.name} submission is not implemented for ${resolved.chainConfig.name}. Refusing unsafe execution.`,
    );
  }

  if (!config.dryRun && config.strategy === "flash-arb") {
    const route = getFlashArbRoute(resolved, config);

    if (!route) {
      throw new Error(
        `Flash-arb route config is required for live ${resolved.chainConfig.name} execution.`,
      );
    }

    if (!route.executors.v3v3 && !route.executors.v2v3 && !route.executors.v3v2) {
      throw new Error(
        `At least one flash-arb executor is required for live ${resolved.chainConfig.name} execution.`,
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

async function validateStandaloneAlchemyPricingSupport(
  provider: AppConfig["pricing"]["provider"],
  resolved: ResolvedChainConfig,
  alchemy?: AlchemyPricesClient,
): Promise<void> {
  if (provider !== "alchemy") return;
  if (!alchemy) {
    throw new Error("Alchemy client is required for alchemy-only pricing.");
  }

  const slug = resolved.chainConfig.alchemySlug;
  if (!slug) {
    throw new Error(
      `Alchemy-only pricing is not configured for ${resolved.chainConfig.name}.`,
    );
  }

  const ajnaToken = resolved.chainConfig.ajnaToken;
  const ajnaPrice = (await alchemy.getPrices(slug, [ajnaToken])).get(ajnaToken) ?? null;
  if (ajnaPrice == null) {
    throw new Error(
      `Alchemy-only pricing cannot price AJNA token ${ajnaToken} on ${resolved.chainConfig.name}. Use coingecko or hybrid instead.`,
    );
  }
}

function getTransientRetryDelayMs(
  config: AppConfig,
  consecutiveTransientErrors: number,
): number {
  const baseDelayMs = Math.max(250, config.polling.idleIntervalMs);
  return Math.min(5_000, baseDelayMs * 2 ** Math.max(0, consecutiveTransientErrors - 1));
}

function refreshRpcHealth(
  chainName: string,
  consecutiveTransientErrors: number,
  lastError?: unknown,
): void {
  const dependencyKey = getRpcHealthDependencyKey(chainName);
  const RPC_HEALTH_DEGRADATION_THRESHOLD = 2;

  if (consecutiveTransientErrors < RPC_HEALTH_DEGRADATION_THRESHOLD) {
    if (consecutiveTransientErrors === 0) {
      setHealthDependency(dependencyKey, true);
    }
    return;
  }

  const reason = [
    `public RPC transient failures: ${consecutiveTransientErrors}`,
    lastError ? `last error: ${getErrorMessage(lastError)}` : undefined,
  ].filter(Boolean).join("; ");

  setHealthDependency(dependencyKey, false, reason);
}

function getReceiptConfirmationRetryTimeoutMs(publicClient: PublicClient): number {
  const blockTimeMs = publicClient.chain?.blockTime ?? 12_000;
  return Math.max(5_000, Math.min(30_000, blockTimeMs * 2));
}

function toSubmissionResult(
  pendingSubmission: PendingSubmission,
): SubmissionResult | undefined {
  if (!pendingSubmission.mode) {
    return undefined;
  }

  return {
    mode: pendingSubmission.mode,
    txHash: pendingSubmission.txHash,
    bundleHash: pendingSubmission.bundleHash,
    targetBlock: pendingSubmission.targetBlock,
    privateSubmission: pendingSubmission.privateSubmission ?? false,
    account: pendingSubmission.account,
    nonce: pendingSubmission.nonce,
    submittedAtMs: pendingSubmission.submittedAtMs,
  };
}

function capturePendingSubmission(
  chainName: string,
  operation: "execution" | "reserve-auction kick",
  pool: Address,
  error: unknown,
): PendingSubmissionState | null {
  if (!(error instanceof PendingSubmissionError)) {
    return null;
  }

  const { pendingSubmission } = error;

  setHealthDependency(
    getPendingSubmissionHealthDependencyKey(chainName),
    false,
    `awaiting resolution for ${pendingSubmission.label} submission ${pendingSubmission.txHash}`,
  );

  logger.warn("Submitted transaction outcome is unresolved, pausing further live submissions", {
    chain: chainName,
    operation,
    pool,
    txHash: pendingSubmission.txHash,
    label: pendingSubmission.label,
    submissionMode: pendingSubmission.mode,
    bundleHash: pendingSubmission.bundleHash,
    targetBlock: pendingSubmission.targetBlock?.toString(),
    privateSubmission: pendingSubmission.privateSubmission,
    error: error.message,
  });

  return {
    ...pendingSubmission,
    operation,
    pool,
  };
}

async function resolvePendingSubmission(
  publicClient: PublicClient,
  chainName: string,
  pendingSubmission: PendingSubmissionState,
): Promise<boolean> {
  if (pendingSubmission.mode === "flashbots" && pendingSubmission.targetBlock != null) {
    try {
      const receipt = await publicClient.getTransactionReceipt({
        hash: pendingSubmission.txHash,
      });

      setHealthDependency(getPendingSubmissionHealthDependencyKey(chainName), true);
      logger.info("Previously submitted transaction outcome resolved", {
        chain: chainName,
        operation: pendingSubmission.operation,
        pool: pendingSubmission.pool,
        txHash: pendingSubmission.txHash,
        label: pendingSubmission.label,
        submissionMode: pendingSubmission.mode,
        bundleHash: pendingSubmission.bundleHash,
        targetBlock: pendingSubmission.targetBlock?.toString(),
        status: receipt.status,
        blockNumber: receipt.blockNumber.toString(),
      });
      return true;
    } catch (error) {
      const message = getErrorMessage(error).toLowerCase();
      const receiptNotFound =
        message.includes("receipt") && message.includes("not found");

      if (!receiptNotFound) {
        setHealthDependency(
          getPendingSubmissionHealthDependencyKey(chainName),
          false,
          `awaiting resolution for ${pendingSubmission.label} submission ${pendingSubmission.txHash}`,
        );
        logger.warn(
          "Waiting for previously submitted transaction resolution before allowing new live submissions",
          {
            chain: chainName,
            operation: pendingSubmission.operation,
            pool: pendingSubmission.pool,
            txHash: pendingSubmission.txHash,
            label: pendingSubmission.label,
            submissionMode: pendingSubmission.mode,
            bundleHash: pendingSubmission.bundleHash,
            targetBlock: pendingSubmission.targetBlock?.toString(),
            error: getErrorMessage(error),
          },
        );
        return false;
      }

      let currentBlock: bigint;
      try {
        currentBlock = await publicClient.getBlockNumber();
      } catch (blockError) {
        setHealthDependency(
          getPendingSubmissionHealthDependencyKey(chainName),
          false,
          `awaiting resolution for ${pendingSubmission.label} submission ${pendingSubmission.txHash}`,
        );
        logger.warn(
          "Waiting for previously submitted transaction resolution before allowing new live submissions",
          {
            chain: chainName,
            operation: pendingSubmission.operation,
            pool: pendingSubmission.pool,
            txHash: pendingSubmission.txHash,
            label: pendingSubmission.label,
            submissionMode: pendingSubmission.mode,
            bundleHash: pendingSubmission.bundleHash,
            targetBlock: pendingSubmission.targetBlock?.toString(),
            error: getErrorMessage(blockError),
          },
        );
        return false;
      }

      if (currentBlock > pendingSubmission.targetBlock + FLASHBOTS_PENDING_BLOCK_GRACE) {
        setHealthDependency(getPendingSubmissionHealthDependencyKey(chainName), true);
        logger.warn("Previously submitted Flashbots bundle missed its target block, clearing pending submission", {
          chain: chainName,
          operation: pendingSubmission.operation,
          pool: pendingSubmission.pool,
          txHash: pendingSubmission.txHash,
          label: pendingSubmission.label,
          bundleHash: pendingSubmission.bundleHash,
          targetBlock: pendingSubmission.targetBlock.toString(),
          currentBlock: currentBlock.toString(),
        });
        return true;
      }

      setHealthDependency(
        getPendingSubmissionHealthDependencyKey(chainName),
        false,
        `awaiting resolution for ${pendingSubmission.label} submission ${pendingSubmission.txHash}`,
      );
      logger.warn(
        "Waiting for previously submitted transaction resolution before allowing new live submissions",
        {
          chain: chainName,
          operation: pendingSubmission.operation,
          pool: pendingSubmission.pool,
          txHash: pendingSubmission.txHash,
          label: pendingSubmission.label,
          submissionMode: pendingSubmission.mode,
          bundleHash: pendingSubmission.bundleHash,
          targetBlock: pendingSubmission.targetBlock?.toString(),
          currentBlock: currentBlock.toString(),
          error: getErrorMessage(error),
        },
      );
      return false;
    }
  }

  try {
    const receipt = await waitForConfirmedReceipt(
      publicClient,
      pendingSubmission.txHash,
      pendingSubmission.label,
      {
        timeoutMs: getReceiptConfirmationRetryTimeoutMs(publicClient),
        submission: toSubmissionResult(pendingSubmission),
      },
    );

    setHealthDependency(getPendingSubmissionHealthDependencyKey(chainName), true);
    logger.info("Previously submitted transaction outcome resolved", {
      chain: chainName,
      operation: pendingSubmission.operation,
      pool: pendingSubmission.pool,
      txHash: pendingSubmission.txHash,
      label: pendingSubmission.label,
      submissionMode: pendingSubmission.mode,
      bundleHash: pendingSubmission.bundleHash,
      targetBlock: pendingSubmission.targetBlock?.toString(),
      status: receipt.status,
      blockNumber: receipt.blockNumber.toString(),
    });
    return true;
  } catch (error) {
    if (!(error instanceof PendingSubmissionError)) {
      throw error;
    }

    const refreshedPendingSubmission = {
      ...pendingSubmission,
      ...error.pendingSubmission,
    };

    if (
      refreshedPendingSubmission.mode === "private-rpc" &&
      refreshedPendingSubmission.account &&
      refreshedPendingSubmission.nonce !== undefined &&
      refreshedPendingSubmission.submittedAtMs !== undefined
    ) {
      const ageMs = Date.now() - refreshedPendingSubmission.submittedAtMs;

      if (ageMs >= PRIVATE_RPC_PENDING_EXPIRY_MS) {
        try {
          const [latestNonce, pendingNonce] = await Promise.all([
            publicClient.getTransactionCount({
              address: refreshedPendingSubmission.account,
              blockTag: "latest",
            }),
            publicClient.getTransactionCount({
              address: refreshedPendingSubmission.account,
              blockTag: "pending",
            }),
          ]);

          if (latestNonce > refreshedPendingSubmission.nonce) {
            setHealthDependency(getPendingSubmissionHealthDependencyKey(chainName), true);
            logger.warn(
              "Previously submitted private RPC transaction consumed its nonce without a visible receipt, clearing pending submission",
              {
                chain: chainName,
                operation: refreshedPendingSubmission.operation,
                pool: refreshedPendingSubmission.pool,
                txHash: refreshedPendingSubmission.txHash,
                label: refreshedPendingSubmission.label,
                account: refreshedPendingSubmission.account,
                nonce: refreshedPendingSubmission.nonce.toString(),
                latestNonce: latestNonce.toString(),
                pendingNonce: pendingNonce.toString(),
                ageMs,
              },
            );
            return true;
          }

          if (pendingNonce > refreshedPendingSubmission.nonce) {
            setHealthDependency(
              getPendingSubmissionHealthDependencyKey(chainName),
              false,
              `awaiting resolution for ${refreshedPendingSubmission.label} submission ${refreshedPendingSubmission.txHash}`,
            );
            logger.warn(
              "Waiting for previously submitted transaction resolution before allowing new live submissions",
              {
                chain: chainName,
                operation: refreshedPendingSubmission.operation,
                pool: refreshedPendingSubmission.pool,
                txHash: refreshedPendingSubmission.txHash,
                label: refreshedPendingSubmission.label,
                submissionMode: refreshedPendingSubmission.mode,
                account: refreshedPendingSubmission.account,
                nonce: refreshedPendingSubmission.nonce.toString(),
                latestNonce: latestNonce.toString(),
                pendingNonce: pendingNonce.toString(),
                ageMs,
                error: error.message,
              },
            );
            return false;
          }

          if (
            latestNonce < refreshedPendingSubmission.nonce ||
            pendingNonce < refreshedPendingSubmission.nonce
          ) {
            setHealthDependency(
              getPendingSubmissionHealthDependencyKey(chainName),
              false,
              `awaiting resolution for ${refreshedPendingSubmission.label} submission ${refreshedPendingSubmission.txHash}`,
            );
            logger.warn(
              "Waiting for previously submitted transaction resolution before allowing new live submissions",
              {
                chain: chainName,
                operation: refreshedPendingSubmission.operation,
                pool: refreshedPendingSubmission.pool,
                txHash: refreshedPendingSubmission.txHash,
                label: refreshedPendingSubmission.label,
                submissionMode: refreshedPendingSubmission.mode,
                account: refreshedPendingSubmission.account,
                nonce: refreshedPendingSubmission.nonce.toString(),
                latestNonce: latestNonce.toString(),
                pendingNonce: pendingNonce.toString(),
                ageMs,
                error: error.message,
              },
            );
            return false;
          }

          setHealthDependency(getPendingSubmissionHealthDependencyKey(chainName), true);
          logger.warn(
            "Previously submitted private RPC transaction exceeded its confirmation deadline without consuming its nonce, clearing pending submission as dropped",
            {
              chain: chainName,
              operation: refreshedPendingSubmission.operation,
              pool: refreshedPendingSubmission.pool,
              txHash: refreshedPendingSubmission.txHash,
              label: refreshedPendingSubmission.label,
              account: refreshedPendingSubmission.account,
              nonce: refreshedPendingSubmission.nonce.toString(),
              latestNonce: latestNonce.toString(),
              pendingNonce: pendingNonce.toString(),
              ageMs,
            },
          );
          return true;
        } catch (nonceError) {
          setHealthDependency(
            getPendingSubmissionHealthDependencyKey(chainName),
            false,
            `awaiting resolution for ${refreshedPendingSubmission.label} submission ${refreshedPendingSubmission.txHash}`,
          );
          logger.warn("Waiting for previously submitted transaction resolution before allowing new live submissions", {
            chain: chainName,
            operation: refreshedPendingSubmission.operation,
            pool: refreshedPendingSubmission.pool,
            txHash: refreshedPendingSubmission.txHash,
            label: refreshedPendingSubmission.label,
            submissionMode: refreshedPendingSubmission.mode,
            account: refreshedPendingSubmission.account,
            nonce: refreshedPendingSubmission.nonce.toString(),
            ageMs,
            error: getErrorMessage(nonceError),
          });
          return false;
        }
      }
    }

    setHealthDependency(
      getPendingSubmissionHealthDependencyKey(chainName),
      false,
      `awaiting resolution for ${refreshedPendingSubmission.label} submission ${refreshedPendingSubmission.txHash}`,
    );
    logger.warn("Waiting for previously submitted transaction resolution before allowing new live submissions", {
      chain: chainName,
      operation: refreshedPendingSubmission.operation,
      pool: refreshedPendingSubmission.pool,
      txHash: refreshedPendingSubmission.txHash,
      label: refreshedPendingSubmission.label,
      submissionMode: refreshedPendingSubmission.mode,
      bundleHash: refreshedPendingSubmission.bundleHash,
      targetBlock: refreshedPendingSubmission.targetBlock?.toString(),
      error: error.message,
    });
    return false;
  }
}

async function runChainLoop(keeper: ChainKeeper, config: AppConfig): Promise<void> {
  const { chainConfig, publicClient, strategy } = keeper;
  const chainName = chainConfig.chainConfig.name;
  const coingecko = config.secrets.coingeckoApiKey
    ? createCoingeckoClient(
      config.secrets.coingeckoApiKey,
      config.secrets.coingeckoApiPlan,
    )
    : undefined;
  const alchemy = config.secrets.alchemyApiKey
    ? createAlchemyPricesClient(config.secrets.alchemyApiKey)
    : undefined;
  const oracle = createPriceOracle(
    {
      provider: config.pricing.provider,
      coingecko,
      alchemy,
    },
    chainConfig.chainConfig,
  );
  logger.info("Starting keeper loop", { chain: chainName });

  let rediscoveryCounter = 0;
  const REDISCOVERY_INTERVAL = 200; // Re-discover pools every 200 cycles
  const kickSimulationCache = new Map<string, { result: boolean; expiresAt: number }>();
  const KICK_SIMULATION_CACHE_TTL_MS = 5 * 60_000;
  const EXECUTION_GAS_UNITS = 200_000n;
  const KICK_RESERVE_AUCTION_GAS_UNITS = 120_000n;
  const MAX_CONSECUTIVE_TRANSIENT_ERRORS = 5;
  let consecutiveTransientErrors = 0;
  let pendingSubmission = await loadPendingSubmission(chainName);

  if (pendingSubmission) {
    setHealthDependency(
      getPendingSubmissionHealthDependencyKey(chainName),
      false,
      `awaiting resolution for ${pendingSubmission.label} submission ${pendingSubmission.txHash}`,
    );
    logger.warn("Recovered unresolved submission from disk, pausing live submissions until it is resolved", {
      chain: chainName,
      operation: pendingSubmission.operation,
      pool: pendingSubmission.pool,
      txHash: pendingSubmission.txHash,
      label: pendingSubmission.label,
      submissionMode: pendingSubmission.mode,
      bundleHash: pendingSubmission.bundleHash,
      targetBlock: pendingSubmission.targetBlock?.toString(),
    });
  }

  while (!shutdownRequested) {
    try {
      if (pendingSubmission) {
        const resolved = await resolvePendingSubmission(
          publicClient,
          chainName,
          pendingSubmission,
        );
        if (!resolved) {
          await sleep(config.polling.idleIntervalMs);
          continue;
        }
        await clearPersistedPendingSubmission(chainName);
        pendingSubmission = null;
      } else {
        setHealthDependency(getPendingSubmissionHealthDependencyKey(chainName), true);
      }

      const submitterHealthy = await refreshSubmitterHealth(keeper, config);
      if (!submitterHealthy) {
        logger.warn("Submission endpoint unhealthy, pausing chain loop", {
          chain: chainName,
          submitter: keeper.submitter.name,
          dryRun: config.dryRun,
        });
        await sleep(config.polling.idleIntervalMs);
        continue;
      }

      // Periodically re-discover pools, and always discover before the first cycle.
      if (keeper.pools.length === 0 || rediscoveryCounter >= REDISCOVERY_INTERVAL) {
        rediscoveryCounter = 0;
        keeper.pools = await discoverPools(
          publicClient,
          chainConfig.chainConfig,
          chainConfig.pools.length > 0 ? chainConfig.pools : undefined,
        );

        logger.info("Monitoring pools", {
          chain: chainName,
          count: keeper.pools.length,
        });
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

      // 3. Collect quote token symbols (auction prices are already in poolStates)
      const quoteTokenSymbols = [...new Set(
        [...activeAuctions, ...kickable].map((poolState) => poolState.quoteTokenSymbol),
      )];
      const priceCache = await (async () => {
        try {
          return quoteTokenSymbols.length > 0
            ? await oracle.getPricesForQuoteTokens(quoteTokenSymbols)
            : new Map<string, Awaited<ReturnType<typeof oracle.getPrices>>>();
        } catch (error) {
          setHealthDependency(
            getPricingHealthDependencyKey(chainName),
            false,
            getErrorMessage(error),
          );
          throw error;
        }
      })();
      refreshPricingHealth(chainName, quoteTokenSymbols, priceCache);
      const gasPriceSnapshot = activeAuctions.length > 0 || kickable.length > 0
        ? await Promise.all([
            publicClient.getGasPrice(),
            publicClient.getBlock({ blockTag: "latest" }),
          ])
        : null;
      const feeCapOverrides = gasPriceSnapshot
        ? getNextBlockSafeFeeCapOverrides(
            gasPriceSnapshot[0],
            gasPriceSnapshot[1].baseFeePerGas ?? undefined,
          )
        : undefined;
      const gasPrice = gasPriceSnapshot
        ? getNextBlockSafeGasPriceWei(
            gasPriceSnapshot[0],
            gasPriceSnapshot[1].baseFeePerGas ?? undefined,
          )
        : null;
      const kickGasCheck = gasPrice == null
        ? null
        : evaluateGasCost(
            gasPrice,
            config.gasPriceCeilingGwei,
            KICK_RESERVE_AUCTION_GAS_UNITS,
            chainConfig.chainConfig.nativeTokenPriceUsd,
          );

      // 4. Evaluate and execute on each active auction
      let anyNearProfitable = false;
      let pauseFurtherLiveSubmissions = false;

      for (const poolState of activeAuctions) {
        if (shutdownRequested || pauseFurtherLiveSubmissions) break;

        const prices = priceCache.get(poolState.quoteTokenSymbol) ?? null;
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
          auctionPrice: poolState.auctionPrice,
          prices,
          chainName,
          gasPriceWei: gasPrice!,
          feeCapOverrides,
        };

        const profit = await strategy.estimateProfit(ctx);
        const additionalExecutionGasUnits =
          await strategy.estimateAdditionalExecutionGasUnits?.(ctx) ?? 0n;
        const executionGasCheck = evaluateGasCost(
          gasPrice!,
          config.gasPriceCeilingGwei,
          EXECUTION_GAS_UNITS + additionalExecutionGasUnits,
          chainConfig.chainConfig.nativeTokenPriceUsd,
        );

        if (
          isNearProfitableAfterCosts(
            profit,
            executionGasCheck.estimatedCostUsd,
            config.profitMarginPercent,
            config.polling.profitabilityThreshold,
          )
        ) {
          anyNearProfitable = true;
        }

        if (executionGasCheck.isAboveCeiling) continue;

        if (!isProfitableAfterCosts(
          profit,
          executionGasCheck.estimatedCostUsd,
          config.profitMarginPercent,
        )) {
          logger.debug("Not yet profitable", {
            chain: chainName,
            pool: poolState.pool,
            estimatedProfitUsd: profit.toFixed(4),
            gasCostUsd: executionGasCheck.estimatedCostUsd.toFixed(4),
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
            strategy: strategy.name,
            quoteTokenSymbol: poolState.quoteTokenSymbol,
            priceSource: ctx.prices.source,
            submissionMode: result.submissionMode,
            txHash: result.txHash,
            bundleHash: result.bundleHash,
            targetBlock: result.targetBlock?.toString(),
            privateSubmission: result.privateSubmission,
            amountQuoteReceived: result.amountQuoteReceived.toString(),
            ajnaCost: result.ajnaCost.toString(),
            estimatedProfitUsd: result.profitUsd.toFixed(4),
            profitUsd: result.profitUsd.toFixed(4),
            realizedProfitUsd: result.realized?.profitUsd.toFixed(4),
            realizedQuoteDelta: result.realized?.quoteTokenDelta.toString(),
            realizedQuoteDeltaRaw: result.realized?.quoteTokenDeltaRaw.toString(),
            realizedAjnaDelta: result.realized?.ajnaDelta.toString(),
            realizedNativeDelta: result.realized?.nativeDelta.toString(),
            gasFeeNative: result.realized?.gasFeeNative.toString(),
            gasUsed: result.realized?.gasUsed.toString(),
            effectiveGasPrice: result.realized?.effectiveGasPrice.toString(),
            receiptBlockNumber: result.realized?.blockNumber.toString(),
          });
        } catch (error) {
          const pending = capturePendingSubmission(
            chainName,
            "execution",
            poolState.pool,
            error,
          );
          if (pending) {
            pendingSubmission = pending;
            await savePendingSubmission(chainName, pendingSubmission);
            pauseFurtherLiveSubmissions = true;
            continue;
          }

          logger.error("Execution failed", {
            chain: chainName,
            pool: poolState.pool,
            strategy: strategy.name,
            quoteTokenSymbol: poolState.quoteTokenSymbol,
            priceSource: ctx.prices.source,
            error: error instanceof Error ? error.message : String(error),
          });

          pauseFurtherLiveSubmissions = await pauseIfSubmitterBecameUnhealthy(
            keeper,
            config,
            "execution",
            poolState.pool,
          );
        }
      }

      // 5. Kick reserve auctions if eligible
      for (const poolState of kickable) {
        if (shutdownRequested || pauseFurtherLiveSubmissions) break;

        const prices = priceCache.get(poolState.quoteTokenSymbol) ?? null;
        if (!prices) continue;

        if (prices.isStale) {
          logger.warn("Skipping reserve-auction kick due to stale prices", {
            chain: chainName,
            pool: poolState.pool,
            quoteTokenSymbol: poolState.quoteTokenSymbol,
          });
          continue;
        }

        const kickCtx = {
          poolState,
          prices,
          chainName,
          gasPriceWei: gasPrice!,
          feeCapOverrides,
        };
        const additionalKickExecutionGasUnits =
          await strategy.estimateAdditionalKickExecutionGasUnits?.(kickCtx) ?? 0n;
        const executionGasCheck = evaluateGasCost(
          gasPrice!,
          config.gasPriceCeilingGwei,
          EXECUTION_GAS_UNITS + additionalKickExecutionGasUnits,
          chainConfig.chainConfig.nativeTokenPriceUsd,
        );
        const kickGasCheckResolved = kickGasCheck!;
        if (kickGasCheckResolved.isAboveCeiling) continue;
        if (executionGasCheck.isAboveCeiling) continue;

        const claimableValueUsd = estimateKickClaimableValueUsd(
          poolState.claimableReserves,
          prices.quoteTokenPriceUsd,
        );
        const estimatedKickProfitUsd = await strategy.estimateKickProfit(kickCtx);
        const totalExpectedCostUsd = sumEstimatedCostsUsd(
          kickGasCheckResolved.estimatedCostUsd,
          executionGasCheck.estimatedCostUsd,
        );
        if (
          !isProfitableAfterCosts(
            estimatedKickProfitUsd,
            totalExpectedCostUsd,
            config.profitMarginPercent,
          )
        ) {
          logger.debug("Skipping uneconomic reserve-auction kick", {
            chain: chainName,
            pool: poolState.pool,
            quoteTokenSymbol: poolState.quoteTokenSymbol,
            claimableReservesUsd: claimableValueUsd.toFixed(6),
            kickGasCostUsd: kickGasCheckResolved.estimatedCostUsd.toFixed(6),
            futureExecutionGasCostUsd: executionGasCheck.estimatedCostUsd.toFixed(6),
            estimatedKickProfitUsd: estimatedKickProfitUsd.toFixed(6),
          });
          continue;
        }

        const kickCacheKey = poolState.pool;
        const cachedKick = kickSimulationCache.get(kickCacheKey);
        const kickCheckNowMs = Date.now();
        let canKick: boolean;
        if (cachedKick && cachedKick.expiresAt > kickCheckNowMs) {
          canKick = cachedKick.result;
        } else {
          canKick = await canKickReserveAuction(publicClient, poolState.pool);
          kickSimulationCache.set(kickCacheKey, {
            result: canKick,
            expiresAt: kickCheckNowMs + KICK_SIMULATION_CACHE_TTL_MS,
          });
        }
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
            const submission = await kickReserveAuction(
              publicClient,
              keeper.submitter,
              keeper.walletClient.account!.address,
              poolState.pool,
              gasPrice ?? undefined,
              feeCapOverrides,
            );

            logger.info("Reserve auction kicked", {
              chain: chainName,
              pool: poolState.pool,
              hash: submission.txHash,
              submissionMode: submission.mode,
              bundleHash: submission.bundleHash,
              targetBlock: submission.targetBlock?.toString(),
              receiptBlockNumber: submission.receiptBlockNumber.toString(),
            });
          } catch (error) {
            const pending = capturePendingSubmission(
              chainName,
              "reserve-auction kick",
              poolState.pool,
              error,
            );
            if (pending) {
              pendingSubmission = pending;
              await savePendingSubmission(chainName, pendingSubmission);
              pauseFurtherLiveSubmissions = true;
              continue;
            }

            logger.error("Failed to kick reserve auction", {
              chain: chainName,
              pool: poolState.pool,
              error: error instanceof Error ? error.message : String(error),
            });

            pauseFurtherLiveSubmissions = await pauseIfSubmitterBecameUnhealthy(
              keeper,
              config,
              "reserve-auction kick",
              poolState.pool,
            );
          }
        }
      }

      consecutiveTransientErrors = 0;
      refreshRpcHealth(chainName, consecutiveTransientErrors);
      rediscoveryCounter++;

      // 6. Adaptive sleep
      const sleepMs = pauseFurtherLiveSubmissions
        ? config.polling.idleIntervalMs
        : anyNearProfitable
        ? config.polling.activeIntervalMs
        : config.polling.idleIntervalMs;

      await sleep(sleepMs);
    } catch (error) {
      if (!isTransientRpcError(error)) {
        throw error;
      }

      consecutiveTransientErrors++;
      const retryDelayMs = getTransientRetryDelayMs(config, consecutiveTransientErrors);
      refreshRpcHealth(chainName, consecutiveTransientErrors, error);
      logger.warn("Transient chain loop error, retrying", {
        chain: chainName,
        consecutiveTransientErrors,
        maxConsecutiveTransientErrors: MAX_CONSECUTIVE_TRANSIENT_ERRORS,
        retryDelayMs,
        error: getErrorMessage(error),
      });

      if (consecutiveTransientErrors >= MAX_CONSECUTIVE_TRANSIENT_ERRORS) {
        throw new Error(
          `Exceeded transient retry budget for ${chainName}: ${getErrorMessage(error)}`,
        );
      }

      await sleep(retryDelayMs);
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
  shutdownRequested = false;
  setHealthy(true);
  clearAllHealthDependencies();
  logger.info("Starting Ajna Reserve Auction Keeper", {
    strategy: config.strategy,
    chains: config.chains.map((c) => c.chainConfig.name),
    dryRun: config.dryRun,
  });

  const startupAlchemy = config.secrets.alchemyApiKey
    ? createAlchemyPricesClient(config.secrets.alchemyApiKey)
    : undefined;
  await Promise.all(
    config.chains.map((chain) =>
      validateStandaloneAlchemyPricingSupport(
        config.pricing.provider,
        chain,
        startupAlchemy,
      )),
  );

  const keepers = config.chains.map((chain) => createChainKeeper(chain, config));
  await preflightLiveSubmitters(keepers, config);

  // Run all chain loops concurrently, but fail the keeper if any loop crashes.
  const loops = keepers.map((keeper) =>
    runChainLoop(keeper, config).catch((error) => {
      logger.alert("Chain loop crashed", {
        chain: keeper.chainConfig.chainConfig.name,
        error: error instanceof Error ? error.message : String(error),
      });
      requestShutdown();
      throw error;
    }),
  );

  await Promise.all(loops);
  logger.info("All keeper loops stopped");
}
