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
  getPrices(tokenIds: string[]): Promise<Map<string, number | null>>;
  isPriceStale(tokenId: string): boolean;
}

export function createCoingeckoClient(apiKey: string): CoingeckoClient {
  const baseUrl = "https://pro-api.coingecko.com/api/v3";

  function getCachedEntry(tokenId: string): CachedPrice | undefined {
    return cache.get(tokenId);
  }

  function getCachedPrice(tokenId: string): number | null {
    const cached = getCachedEntry(tokenId);
    if (!cached) return null;
    return cached.price;
  }

  async function getPrices(tokenIds: string[]): Promise<Map<string, number | null>> {
    const results = new Map<string, number | null>();
    const uniqueTokenIds = [...new Set(tokenIds)];
    if (uniqueTokenIds.length === 0) {
      return results;
    }

    const now = Date.now();
    const staleOrMissing: string[] = [];

    for (const tokenId of uniqueTokenIds) {
      const cached = getCachedEntry(tokenId);
      if (cached && now - cached.fetchedAt <= STALE_THRESHOLD_MS) {
        results.set(tokenId, cached.price);
      } else {
        staleOrMissing.push(tokenId);
      }
    }

    if (staleOrMissing.length === 0) {
      return results;
    }

    try {
      const response = await fetch(
        `${baseUrl}/simple/price?ids=${encodeURIComponent(staleOrMissing.join(","))}&vs_currencies=usd`,
        {
          headers: {
            "x-cg-pro-api-key": apiKey,
            Accept: "application/json",
          },
        },
      );

      if (response.status === 429) {
        logger.warn("Coingecko rate limited, using cached prices", { tokenIds: staleOrMissing });
        for (const tokenId of staleOrMissing) {
          results.set(tokenId, getCachedPrice(tokenId));
        }
        return results;
      }

      if (!response.ok) {
        logger.error("Coingecko API error", {
          tokenIds: staleOrMissing,
          status: response.status,
        });
        for (const tokenId of staleOrMissing) {
          results.set(tokenId, getCachedPrice(tokenId));
        }
        return results;
      }

      const data = (await response.json()) as Record<string, { usd: number }>;

      for (const tokenId of staleOrMissing) {
        const price = data[tokenId]?.usd;
        const cached = getCachedEntry(tokenId);

        if (price == null) {
          logger.warn("No price data from Coingecko", { tokenId });
          results.set(tokenId, getCachedPrice(tokenId));
          continue;
        }

        if (cached) {
          const deviation = Math.abs(price - cached.price) / cached.price;
          if (deviation > MAX_DEVIATION_PERCENT / 100) {
            logger.alert("Price deviation exceeds threshold", {
              tokenId,
              oldPrice: cached.price,
              newPrice: price,
              deviationPercent: (deviation * 100).toFixed(1),
            });
            results.set(tokenId, null);
            continue;
          }
        }

        cache.set(tokenId, { price, fetchedAt: now });
        results.set(tokenId, price);
      }

      return results;
    } catch (error) {
      logger.error("Coingecko fetch failed", {
        tokenIds: staleOrMissing,
        error: error instanceof Error ? error.message : String(error),
      });
      for (const tokenId of staleOrMissing) {
        results.set(tokenId, getCachedPrice(tokenId));
      }
      return results;
    }
  }

  async function getPrice(tokenId: string): Promise<number | null> {
    return (await getPrices([tokenId])).get(tokenId) ?? null;
  }

  function isPriceStale(tokenId: string): boolean {
    const cached = getCachedEntry(tokenId);
    if (!cached) return true;
    return Date.now() - cached.fetchedAt > STALE_THRESHOLD_MS;
  }

  return { getPrice, getPrices, isPriceStale };
}
