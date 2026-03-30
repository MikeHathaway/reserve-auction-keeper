import { type PublicClient, type Address, formatEther } from "viem";
import { POOL_INFO_UTILS_ABI } from "../contracts/abis/index.js";
import type { ChainConfig } from "../chains/index.js";
import { logger } from "../utils/logger.js";
import { retryAsync } from "../utils/retry.js";

export interface AuctionPriceInfo {
  pool: Address;
  auctionPrice: bigint;
  auctionPriceFormatted: string;
  timeRemaining: bigint;
  timeRemainingHours: number;
}

/**
 * Fetch the current auction price for a pool from PoolInfoUtils.
 * The auctionPrice is in AJNA-per-quote-token terms (decays over 72h).
 * Lower price = more favorable for the bidder.
 */
export async function getAuctionPrice(
  client: PublicClient,
  chainConfig: ChainConfig,
  pool: Address,
): Promise<AuctionPriceInfo> {
  const result = await retryAsync(
    () =>
      client.readContract({
        address: chainConfig.poolInfoUtils,
        abi: POOL_INFO_UTILS_ABI,
        functionName: "poolReservesInfo",
        args: [pool],
      }),
    { label: `${chainConfig.name}.poolReservesInfo` },
  );

  const [, , , auctionPrice, timeRemaining] = result;

  const info: AuctionPriceInfo = {
    pool,
    auctionPrice,
    auctionPriceFormatted: formatEther(auctionPrice),
    timeRemaining,
    timeRemainingHours: Number(timeRemaining) / 3600,
  };

  logger.debug("Auction price fetched", {
    pool,
    chain: chainConfig.name,
    auctionPrice: info.auctionPriceFormatted,
    timeRemainingHours: info.timeRemainingHours.toFixed(1),
  });

  return info;
}

/**
 * Batch-fetch auction prices for multiple pools via multicall.
 */
export async function getAuctionPrices(
  client: PublicClient,
  chainConfig: ChainConfig,
  pools: Address[],
): Promise<Map<Address, AuctionPriceInfo>> {
  if (pools.length === 0) return new Map();

  const calls = pools.map((pool) => ({
    address: chainConfig.poolInfoUtils,
    abi: POOL_INFO_UTILS_ABI,
    functionName: "poolReservesInfo" as const,
    args: [pool] as const,
  }));

  const results = await retryAsync(
    () => client.multicall({ contracts: calls }),
    { label: `${chainConfig.name}.poolReservesInfo.multicall` },
  );
  const priceMap = new Map<Address, AuctionPriceInfo>();

  for (let i = 0; i < pools.length; i++) {
    const result = results[i];
    if (result.status !== "success") {
      logger.warn("Failed to fetch auction price", {
        pool: pools[i],
        chain: chainConfig.name,
      });
      continue;
    }

    const [, , , auctionPrice, timeRemaining] = result.result as [
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
    ];

    priceMap.set(pools[i], {
      pool: pools[i],
      auctionPrice,
      auctionPriceFormatted: formatEther(auctionPrice),
      timeRemaining,
      timeRemainingHours: Number(timeRemaining) / 3600,
    });
  }

  return priceMap;
}
