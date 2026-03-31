import {
  type PublicClient,
  type Address,
  getContract,
  formatEther,
  isAddress,
} from "viem";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { POOL_FACTORY_ABI, POOL_ABI, POOL_INFO_UTILS_ABI } from "../contracts/abis/index.js";
import type { ChainConfig } from "../chains/index.js";
import { logger } from "../utils/logger.js";
import { retryAsync } from "../utils/retry.js";

export interface PoolReserveState {
  pool: Address;
  quoteToken: Address;
  quoteTokenScale: bigint;
  quoteTokenSymbol: string;
  reserves: bigint;
  claimableReserves: bigint;
  claimableReservesRemaining: bigint;
  auctionPrice: bigint;
  timeRemaining: bigint;
  hasActiveAuction: boolean;
  isKickable: boolean;
}

interface PoolDiscoveryCacheSnapshot {
  version: number;
  chain: string;
  factory: string;
  quoteTokens: string[];
  lastPoolCount: string;
  pools: string[];
  updatedAtBlock: string;
}

const DISCOVERY_CACHE_VERSION = 1;
const DEFAULT_DISCOVERY_CACHE_DIR = join(process.cwd(), ".cache", "pool-discovery");

function getWhitelistedQuoteTokens(chainConfig: ChainConfig): string[] {
  return Object.values(chainConfig.quoteTokens)
    .map((address) => address.toLowerCase())
    .sort();
}

function getDiscoveryCachePath(
  chainConfig: ChainConfig,
  cacheDir: string,
): string {
  return join(cacheDir, `${chainConfig.name}.json`);
}

function areSameStringArrays(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function dedupePools(pools: Address[]): Address[] {
  const seen = new Set<string>();
  const deduped: Address[] = [];

  for (const pool of pools) {
    const key = pool.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(pool);
  }

  return deduped;
}

async function loadDiscoveryCache(
  chainConfig: ChainConfig,
  cacheDir: string,
): Promise<{ lastPoolCount: bigint; pools: Address[] } | null> {
  const cachePath = getDiscoveryCachePath(chainConfig, cacheDir);

  try {
    const raw = await readFile(cachePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<PoolDiscoveryCacheSnapshot>;
    const expectedQuoteTokens = getWhitelistedQuoteTokens(chainConfig);

    if (parsed.version !== DISCOVERY_CACHE_VERSION) return null;
    if (parsed.chain !== chainConfig.name) return null;
    if (parsed.factory?.toLowerCase() !== chainConfig.poolFactory.toLowerCase()) return null;

    const cachedQuoteTokens = [...(parsed.quoteTokens || [])]
      .map((address) => address.toLowerCase())
      .sort();
    if (!areSameStringArrays(cachedQuoteTokens, expectedQuoteTokens)) return null;

    if (typeof parsed.lastPoolCount !== "string") return null;
    if (!Array.isArray(parsed.pools) || !parsed.pools.every((pool) => typeof pool === "string" && isAddress(pool))) {
      return null;
    }

    return {
      lastPoolCount: BigInt(parsed.lastPoolCount),
      pools: dedupePools(parsed.pools as Address[]),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return null;
    }

    logger.warn("Ignoring unreadable discovery cache", {
      chain: chainConfig.name,
      cachePath,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function saveDiscoveryCache(
  chainConfig: ChainConfig,
  cacheDir: string,
  pools: Address[],
  lastPoolCount: bigint,
  updatedAtBlock: bigint,
): Promise<void> {
  const cachePath = getDiscoveryCachePath(chainConfig, cacheDir);
  const tempPath = `${cachePath}.tmp-${process.pid}-${Date.now()}`;

  const snapshot: PoolDiscoveryCacheSnapshot = {
    version: DISCOVERY_CACHE_VERSION,
    chain: chainConfig.name,
    factory: chainConfig.poolFactory,
    quoteTokens: getWhitelistedQuoteTokens(chainConfig),
    lastPoolCount: lastPoolCount.toString(),
    pools,
    updatedAtBlock: updatedAtBlock.toString(),
  };

  try {
    await mkdir(cacheDir, { recursive: true });
    await writeFile(tempPath, JSON.stringify(snapshot, null, 2));
    await rename(tempPath, cachePath);
  } catch (error) {
    logger.warn("Failed to persist discovery cache", {
      chain: chainConfig.name,
      cachePath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function fetchDeployedPools(
  client: PublicClient,
  chainConfig: ChainConfig,
  startIndex: bigint,
  endIndex: bigint,
): Promise<Address[]> {
  if (endIndex <= startIndex) return [];

  const calls: Array<{
    address: Address;
    abi: typeof POOL_FACTORY_ABI;
    functionName: "deployedPoolsList";
    args: readonly [bigint];
  }> = [];

  for (let index = startIndex; index < endIndex; index++) {
    calls.push({
      address: chainConfig.poolFactory,
      abi: POOL_FACTORY_ABI,
      functionName: "deployedPoolsList" as const,
      args: [index] as const,
    });
  }

  const results = await retryAsync(
    () => client.multicall({ contracts: calls }),
    { label: `${chainConfig.name}.deployedPoolsList` },
  );

  return results.flatMap((result) =>
    result.status === "success" ? [result.result as Address] : []
  );
}

async function filterPoolsByQuoteToken(
  client: PublicClient,
  chainConfig: ChainConfig,
  pools: Address[],
): Promise<Address[]> {
  if (pools.length === 0) return [];

  const whitelistedQuoteTokens = new Set(getWhitelistedQuoteTokens(chainConfig));
  const quoteTokenCalls = pools.map((pool) => ({
    address: pool,
    abi: POOL_ABI,
    functionName: "quoteTokenAddress" as const,
  }));

  const quoteTokenResults = await retryAsync(
    () => client.multicall({ contracts: quoteTokenCalls }),
    { label: `${chainConfig.name}.quoteTokenAddress` },
  );

  const filteredPools: Address[] = [];
  for (let i = 0; i < pools.length; i++) {
    const result = quoteTokenResults[i];
    if (
      result.status === "success" &&
      whitelistedQuoteTokens.has((result.result as string).toLowerCase())
    ) {
      filteredPools.push(pools[i]);
    }
  }

  return filteredPools;
}

/**
 * Discover all pools deployed by the Ajna PoolFactory and check their reserve state.
 * Filters to pools with whitelisted quote tokens.
 */
export async function discoverPools(
  client: PublicClient,
  chainConfig: ChainConfig,
  configuredPools?: Address[],
  cacheDir: string = DEFAULT_DISCOVERY_CACHE_DIR,
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

  const cached = await loadDiscoveryCache(chainConfig, cacheDir);
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

  if (poolCount === 0n) {
    const updatedAtBlock = await client.getBlockNumber();
    await saveDiscoveryCache(chainConfig, cacheDir, [], 0n, updatedAtBlock);
    return [];
  }

  if (cached && cached.lastPoolCount === poolCount) {
    logger.info("Using persisted discovery cache", {
      chain: chainConfig.name,
      count: cached.pools.length,
      poolCount: poolCount.toString(),
    });
    return cached.pools;
  }

  const shouldIncrementallySync =
    cached && cached.lastPoolCount >= 0n && cached.lastPoolCount < poolCount;

  const startIndex = shouldIncrementallySync ? cached.lastPoolCount : 0n;
  const discoveredPools = await fetchDeployedPools(
    client,
    chainConfig,
    startIndex,
    poolCount,
  );
  const filteredDiscoveredPools = await filterPoolsByQuoteToken(
    client,
    chainConfig,
    discoveredPools,
  );
  const filteredPools = shouldIncrementallySync
    ? dedupePools([...cached.pools, ...filteredDiscoveredPools])
    : filteredDiscoveredPools;

  logger.info("Filtered to whitelisted quote token pools", {
    chain: chainConfig.name,
    total: poolCount.toString(),
    filtered: filteredPools.length,
    newPools: filteredDiscoveredPools.length,
    mode: shouldIncrementallySync ? "incremental" : "full",
  });

  const updatedAtBlock = await client.getBlockNumber();
  await saveDiscoveryCache(
    chainConfig,
    cacheDir,
    filteredPools,
    poolCount,
    updatedAtBlock,
  );

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

  // Multicall: PoolInfoUtils.poolReservesInfo(pool) + quoteTokenAddress
  const reservesCalls = pools.map((pool) => ({
    address: chainConfig.poolInfoUtils,
    abi: POOL_INFO_UTILS_ABI,
    functionName: "poolReservesInfo" as const,
    args: [pool] as const,
  }));

  const quoteTokenCalls = pools.map((pool) => ({
    address: pool,
    abi: POOL_ABI,
    functionName: "quoteTokenAddress" as const,
  }));

  const quoteScaleCalls = pools.map((pool) => ({
    address: pool,
    abi: POOL_ABI,
    functionName: "quoteTokenScale" as const,
  }));

  const [reservesResults, quoteTokenResults, quoteScaleResults] = await retryAsync(
    () =>
      Promise.all([
        client.multicall({ contracts: reservesCalls }),
        client.multicall({ contracts: quoteTokenCalls }),
        client.multicall({ contracts: quoteScaleCalls }),
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
    const quoteScaleResult = quoteScaleResults[i];

    if (
      reserveResult.status !== "success" ||
      quoteResult.status !== "success" ||
      quoteScaleResult.status !== "success"
    ) {
      logger.warn("Failed to read pool state", {
        pool: pools[i],
        chain: chainConfig.name,
      });
      continue;
    }

    const [reserves, claimableReserves, claimableReservesRemaining, auctionPrice, timeRemaining] =
      reserveResult.result as [bigint, bigint, bigint, bigint, bigint];

    const quoteToken = quoteResult.result as Address;
    const quoteTokenScale = quoteScaleResult.result as bigint;
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
      quoteTokenScale,
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
