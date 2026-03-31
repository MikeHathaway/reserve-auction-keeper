import type { Address } from "viem";
import { logger } from "../utils/logger.js";

interface CachedPrice {
  price: number;
  updatedAt: number;
}

interface AlchemyPricePoint {
  currency?: string;
  value?: string;
  lastUpdatedAt?: string;
}

interface AlchemyPriceEntry {
  network?: string;
  address?: string;
  prices?: AlchemyPricePoint[];
  error?: string | null;
}

interface AlchemyPricesResponse {
  data?: AlchemyPriceEntry[];
}

const cache = new Map<string, CachedPrice>();
const STALE_THRESHOLD_MS = 5 * 60 * 1000;
const MAX_DEVIATION_PERCENT = 20;

export interface AlchemyPricesClient {
  getPrices(network: string, addresses: Address[]): Promise<Map<Address, number | null>>;
  isPriceStale(network: string, address: Address): boolean;
}

function getCacheKey(network: string, address: Address): string {
  return `${network}:${address.toLowerCase()}`;
}

function getCachedPrice(network: string, address: Address): number | null {
  const cached = cache.get(getCacheKey(network, address));
  if (!cached) return null;
  return cached.price;
}

function parseUsdPrice(entry: AlchemyPriceEntry): { price: number; updatedAt: number } | null {
  const usdPrice = entry.prices?.find((price) => price.currency?.toUpperCase() === "USD");
  if (!usdPrice?.value) {
    return null;
  }

  const parsedPrice = Number(usdPrice.value);
  if (!Number.isFinite(parsedPrice) || parsedPrice <= 0) {
    return null;
  }

  const updatedAt = usdPrice.lastUpdatedAt ? Date.parse(usdPrice.lastUpdatedAt) : Date.now();
  return {
    price: parsedPrice,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
  };
}

export function createAlchemyPricesClient(apiKey: string): AlchemyPricesClient {
  const baseUrl = `https://api.g.alchemy.com/prices/v1/${apiKey}/tokens/by-address`;

  async function getPrices(
    network: string,
    addresses: Address[],
  ): Promise<Map<Address, number | null>> {
    const results = new Map<Address, number | null>();
    if (addresses.length === 0) return results;

    const freshCached = new Map<string, number>();
    const staleOrMissing: Address[] = [];

    for (const address of addresses) {
      const cached = cache.get(getCacheKey(network, address));
      if (cached && Date.now() - cached.updatedAt <= STALE_THRESHOLD_MS) {
        freshCached.set(address.toLowerCase(), cached.price);
        results.set(address, cached.price);
      } else {
        staleOrMissing.push(address);
      }
    }

    if (staleOrMissing.length === 0) {
      return results;
    }

    const requested = new Map(staleOrMissing.map((address) => [address.toLowerCase(), address]));

    try {
      const response = await fetch(baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          addresses: staleOrMissing.map((address) => ({
            network,
            address: address.toLowerCase(),
          })),
        }),
      });

      if (response.status === 429) {
        logger.warn("Alchemy price API rate limited, using cached prices", {
          network,
          addresses: staleOrMissing,
        });
        for (const address of staleOrMissing) {
          results.set(address, getCachedPrice(network, address));
        }
        return results;
      }

      if (!response.ok) {
        logger.error("Alchemy price API error", {
          network,
          status: response.status,
          addresses: staleOrMissing,
        });
        for (const address of staleOrMissing) {
          results.set(address, getCachedPrice(network, address));
        }
        return results;
      }

      const data = (await response.json()) as AlchemyPricesResponse;
      const seen = new Set<string>();

      for (const entry of data.data ?? []) {
        const normalizedAddress = entry.address?.toLowerCase();
        if (!normalizedAddress) continue;

        const requestedAddress = requested.get(normalizedAddress);
        if (!requestedAddress) continue;

        seen.add(normalizedAddress);

        if (entry.error) {
          logger.warn("Alchemy returned token price error, using cached price", {
            network,
            address: requestedAddress,
            error: entry.error,
          });
          results.set(requestedAddress, getCachedPrice(network, requestedAddress));
          continue;
        }

        const parsed = parseUsdPrice(entry);
        if (!parsed) {
          logger.warn("Alchemy returned no USD price, using cached price", {
            network,
            address: requestedAddress,
          });
          results.set(requestedAddress, getCachedPrice(network, requestedAddress));
          continue;
        }

        const cacheKey = getCacheKey(network, requestedAddress);
        const cached = cache.get(cacheKey);
        if (cached) {
          const deviation = Math.abs(parsed.price - cached.price) / cached.price;
          if (deviation > MAX_DEVIATION_PERCENT / 100) {
            logger.alert("Alchemy price deviation exceeds threshold", {
              network,
              address: requestedAddress,
              oldPrice: cached.price,
              newPrice: parsed.price,
              deviationPercent: (deviation * 100).toFixed(1),
            });
            results.set(requestedAddress, null);
            continue;
          }
        }

        cache.set(cacheKey, {
          price: parsed.price,
          updatedAt: parsed.updatedAt,
        });
        results.set(requestedAddress, parsed.price);
      }

      for (const address of staleOrMissing) {
        if (seen.has(address.toLowerCase())) continue;
        results.set(address, getCachedPrice(network, address));
      }

      return results;
    } catch (error) {
      logger.error("Alchemy price fetch failed", {
        network,
        addresses: staleOrMissing,
        error: error instanceof Error ? error.message : String(error),
      });
      for (const address of staleOrMissing) {
        results.set(address, getCachedPrice(network, address));
      }
      return results;
    }
  }

  function isPriceStale(network: string, address: Address): boolean {
    const cached = cache.get(getCacheKey(network, address));
    if (!cached) return true;
    return Date.now() - cached.updatedAt > STALE_THRESHOLD_MS;
  }

  return {
    getPrices,
    isPriceStale,
  };
}
