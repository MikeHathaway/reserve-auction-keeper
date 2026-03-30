import {
  type PublicClient,
  type Address,
  getContract,
  formatEther,
} from "viem";
import { POOL_FACTORY_ABI, POOL_ABI } from "../contracts/abis/index.js";
import type { ChainConfig } from "../chains/index.js";
import { logger } from "../utils/logger.js";
import { retryAsync } from "../utils/retry.js";

export interface PoolReserveState {
  pool: Address;
  quoteToken: Address;
  quoteTokenSymbol: string;
  reserves: bigint;
  claimableReserves: bigint;
  claimableReservesRemaining: bigint;
  auctionPrice: bigint;
  timeRemaining: bigint;
  hasActiveAuction: boolean;
  isKickable: boolean;
}

/**
 * Discover all pools deployed by the Ajna PoolFactory and check their reserve state.
 * Filters to pools with whitelisted quote tokens.
 */
export async function discoverPools(
  client: PublicClient,
  chainConfig: ChainConfig,
  configuredPools?: Address[],
): Promise<Address[]> {
  // If pools are explicitly configured, use those
  if (configuredPools && configuredPools.length > 0) {
    logger.info("Using configured pool list", {
      chain: chainConfig.name,
      count: configuredPools.length,
    });
    return configuredPools;
  }

  // Auto-discover from PoolFactory
  logger.info("Auto-discovering pools from PoolFactory", {
    chain: chainConfig.name,
    factory: chainConfig.poolFactory,
  });

  const factory = getContract({
    address: chainConfig.poolFactory,
    abi: POOL_FACTORY_ABI,
    client,
  });

  const poolCount = await retryAsync(
    () => factory.read.getNumberOfDeployedPools(),
    { label: `${chainConfig.name}.getNumberOfDeployedPools` },
  );
  logger.info("Found deployed pools", {
    chain: chainConfig.name,
    count: poolCount.toString(),
  });

  if (poolCount === 0n) return [];

  // Batch-read pool addresses via multicall
  const calls: Array<{
    address: Address;
    abi: typeof POOL_FACTORY_ABI;
    functionName: "deployedPoolsList";
    args: readonly [bigint];
  }> = [];
  for (let i = 0n; i < poolCount; i++) {
    calls.push({
      address: chainConfig.poolFactory,
      abi: POOL_FACTORY_ABI,
      functionName: "deployedPoolsList" as const,
      args: [i] as const,
    });
  }

  const results = await retryAsync(
    () => client.multicall({ contracts: calls }),
    { label: `${chainConfig.name}.deployedPoolsList` },
  );
  const allPools: Address[] = [];

  for (const result of results) {
    if (result.status === "success") {
      allPools.push(result.result as Address);
    }
  }

  // Filter to pools with whitelisted quote tokens
  const whitelistedQuoteTokens = new Set(
    Object.values(chainConfig.quoteTokens).map((a) => a.toLowerCase()),
  );

  const quoteTokenCalls = allPools.map((pool) => ({
    address: pool,
    abi: POOL_ABI,
    functionName: "quoteTokenAddress" as const,
  }));

  const quoteTokenResults = await retryAsync(
    () => client.multicall({ contracts: quoteTokenCalls }),
    { label: `${chainConfig.name}.quoteTokenAddress` },
  );

  const filteredPools: Address[] = [];
  for (let i = 0; i < allPools.length; i++) {
    const result = quoteTokenResults[i];
    if (
      result.status === "success" &&
      whitelistedQuoteTokens.has((result.result as string).toLowerCase())
    ) {
      filteredPools.push(allPools[i]);
    }
  }

  logger.info("Filtered to whitelisted quote token pools", {
    chain: chainConfig.name,
    total: allPools.length,
    filtered: filteredPools.length,
  });

  return filteredPools;
}

/**
 * Fetch reserve state for a list of pools via multicall.
 */
export async function getPoolReserveStates(
  client: PublicClient,
  chainConfig: ChainConfig,
  pools: Address[],
): Promise<PoolReserveState[]> {
  if (pools.length === 0) return [];

  // Multicall: reservesInfo for each pool + quoteTokenAddress
  const reservesCalls = pools.map((pool) => ({
    address: pool,
    abi: POOL_ABI,
    functionName: "reservesInfo" as const,
  }));

  const quoteTokenCalls = pools.map((pool) => ({
    address: pool,
    abi: POOL_ABI,
    functionName: "quoteTokenAddress" as const,
  }));

  const [reservesResults, quoteTokenResults] = await retryAsync(
    () =>
      Promise.all([
        client.multicall({ contracts: reservesCalls }),
        client.multicall({ contracts: quoteTokenCalls }),
      ]),
    { label: `${chainConfig.name}.getPoolReserveStates` },
  );

  // Build reverse lookup: address → symbol
  const addressToSymbol: Record<string, string> = {};
  for (const [symbol, addr] of Object.entries(chainConfig.quoteTokens)) {
    addressToSymbol[addr.toLowerCase()] = symbol;
  }

  const states: PoolReserveState[] = [];

  for (let i = 0; i < pools.length; i++) {
    const reserveResult = reservesResults[i];
    const quoteResult = quoteTokenResults[i];

    if (reserveResult.status !== "success" || quoteResult.status !== "success") {
      logger.warn("Failed to read pool state", {
        pool: pools[i],
        chain: chainConfig.name,
      });
      continue;
    }

    const [reserves, claimableReserves, claimableReservesRemaining, auctionPrice, timeRemaining] =
      reserveResult.result as [bigint, bigint, bigint, bigint, bigint];

    const quoteToken = quoteResult.result as Address;
    const quoteTokenSymbol = addressToSymbol[quoteToken.toLowerCase()] || "UNKNOWN";

    const hasActiveAuction = claimableReservesRemaining > 0n && timeRemaining > 0n;
    const isKickable = claimableReserves > 0n && !hasActiveAuction;

    if (hasActiveAuction) {
      logger.debug("Active auction found", {
        pool: pools[i],
        chain: chainConfig.name,
        quoteToken: quoteTokenSymbol,
        remaining: formatEther(claimableReservesRemaining),
        auctionPrice: formatEther(auctionPrice),
        timeRemainingHours: Number(timeRemaining) / 3600,
      });
    }

    states.push({
      pool: pools[i],
      quoteToken,
      quoteTokenSymbol,
      reserves,
      claimableReserves,
      claimableReservesRemaining,
      auctionPrice,
      timeRemaining,
      hasActiveAuction,
      isKickable,
    });
  }

  return states;
}

/**
 * Check if a pool has unsettled liquidations (reserve auctions can't be kicked if so).
 * Uses a try/catch on kickReserveAuction simulation to check.
 */
export async function canKickReserveAuction(
  client: PublicClient,
  pool: Address,
): Promise<boolean> {
  try {
    await client.simulateContract({
      address: pool,
      abi: POOL_ABI,
      functionName: "kickReserveAuction",
    });
    return true;
  } catch {
    return false;
  }
}
