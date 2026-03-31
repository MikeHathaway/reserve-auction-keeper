import { logger } from "../utils/logger.js";

interface CachedPrice {
  price: number;
  fetchedAt: number;
}

const cache = new Map<string, CachedPrice>();
const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
const MAX_DEVIATION_PERCENT = 20;

export interface CoingeckoClient {
  getPrice(tokenId: string): Promise<number | null>;
  isPriceStale(tokenId: string): boolean;
}

export function createCoingeckoClient(apiKey: string): CoingeckoClient {
  const baseUrl = "https://pro-api.coingecko.com/api/v3";

  function getCachedEntry(tokenId: string): CachedPrice | undefined {
    return cache.get(tokenId);
  }

  async function getPrice(tokenId: string): Promise<number | null> {
    const cached = getCachedEntry(tokenId);
    if (cached && Date.now() - cached.fetchedAt <= STALE_THRESHOLD_MS) {
      return cached.price;
    }

    try {
      const response = await fetch(
        `${baseUrl}/simple/price?ids=${tokenId}&vs_currencies=usd`,
        {
          headers: {
            "x-cg-pro-api-key": apiKey,
            Accept: "application/json",
          },
        },
      );

      if (response.status === 429) {
        logger.warn("Coingecko rate limited, using cached price", { tokenId });
        return getCachedPrice(tokenId);
      }

      if (!response.ok) {
        logger.error("Coingecko API error", {
          tokenId,
          status: response.status,
        });
        return getCachedPrice(tokenId);
      }

      const data = (await response.json()) as Record<string, { usd: number }>;
      const price = data[tokenId]?.usd;

      if (price == null) {
        logger.warn("No price data from Coingecko", { tokenId });
        return getCachedPrice(tokenId);
      }

      // Deviation check against last known price
      if (cached) {
        const deviation = Math.abs(price - cached.price) / cached.price;
        if (deviation > MAX_DEVIATION_PERCENT / 100) {
          logger.alert("Price deviation exceeds threshold", {
            tokenId,
            oldPrice: cached.price,
            newPrice: price,
            deviationPercent: (deviation * 100).toFixed(1),
          });
          return null;
        }
      }

      cache.set(tokenId, { price, fetchedAt: Date.now() });
      return price;
    } catch (error) {
      logger.error("Coingecko fetch failed", {
        tokenId,
        error: error instanceof Error ? error.message : String(error),
      });
      return getCachedPrice(tokenId);
    }
  }

  function getCachedPrice(tokenId: string): number | null {
    const cached = getCachedEntry(tokenId);
    if (!cached) return null;
    return cached.price;
  }

  function isPriceStale(tokenId: string): boolean {
    const cached = getCachedEntry(tokenId);
    if (!cached) return true;
    return Date.now() - cached.fetchedAt > STALE_THRESHOLD_MS;
  }

  return { getPrice, isPriceStale };
}
