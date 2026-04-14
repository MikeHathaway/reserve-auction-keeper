import { logger } from "../utils/logger.js";
import { fetchWithTimeout } from "../utils/http.js";

interface CachedPrice {
  price: number;
  fetchedAt: number;
}

interface PendingPriceConfirmation {
  price: number;
  observedAt: number;
}

interface CoingeckoErrorResponse {
  error_code?: number;
  status?: {
    error_code?: number;
    error_message?: string;
  };
  error?: string;
  message?: string;
}

interface CoingeckoRequestConfig {
  baseUrl: string;
  headerName: "x-cg-demo-api-key" | "x-cg-pro-api-key";
}

const cache = new Map<string, CachedPrice>();
const pendingPriceConfirmations = new Map<string, PendingPriceConfirmation>();
const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
const MAX_DEVIATION_PERCENT = 20;
const CONFIRMATION_MATCH_THRESHOLD_PERCENT = 5;
const CONFIRMATION_WINDOW_MS = 30 * 60 * 1000;

export type CoingeckoApiPlan = "auto" | "demo" | "pro";

export interface CoingeckoClient {
  getPrice(tokenId: string): Promise<number | null>;
  getPrices(tokenIds: string[]): Promise<Map<string, number | null>>;
  isPriceStale(tokenId: string): boolean;
}

function getRequestConfig(plan: Exclude<CoingeckoApiPlan, "auto">): CoingeckoRequestConfig {
  if (plan === "demo") {
    return {
      baseUrl: "https://api.coingecko.com/api/v3",
      headerName: "x-cg-demo-api-key",
    };
  }

  return {
    baseUrl: "https://pro-api.coingecko.com/api/v3",
    headerName: "x-cg-pro-api-key",
  };
}

function getErrorCode(errorBody: CoingeckoErrorResponse | null): number | undefined {
  return errorBody?.error_code ?? errorBody?.status?.error_code;
}

function getErrorMessage(errorBody: CoingeckoErrorResponse | null): string {
  return [
    errorBody?.message,
    errorBody?.error,
    errorBody?.status?.error_message,
  ].filter(Boolean).join(" ");
}

function inferRequiredPlan(errorBody: CoingeckoErrorResponse | null): Exclude<CoingeckoApiPlan, "auto"> | null {
  const errorCode = getErrorCode(errorBody);
  const errorMessage = getErrorMessage(errorBody).toLowerCase();

  if (errorCode === 10011 || (errorMessage.includes("demo") && errorMessage.includes("api.coingecko.com"))) {
    return "demo";
  }

  if (errorCode === 10010 || (errorMessage.includes("pro") && errorMessage.includes("pro-api.coingecko.com"))) {
    return "pro";
  }

  return null;
}

async function parseErrorBody(response: Response): Promise<CoingeckoErrorResponse | null> {
  try {
    return await response.json() as CoingeckoErrorResponse;
  } catch {
    return null;
  }
}

export function createCoingeckoClient(
  apiKey: string,
  plan: CoingeckoApiPlan = "auto",
): CoingeckoClient {
  let resolvedPlan: Exclude<CoingeckoApiPlan, "auto"> | null = plan === "auto" ? null : plan;

  function getCachedEntry(tokenId: string): CachedPrice | undefined {
    return cache.get(tokenId);
  }

  function getCachedPrice(tokenId: string): number | null {
    const cached = getCachedEntry(tokenId);
    if (!cached) return null;
    return cached.price;
  }

  function getPendingConfirmation(tokenId: string): PendingPriceConfirmation | null {
    const pending = pendingPriceConfirmations.get(tokenId);
    if (!pending) return null;
    if (Date.now() - pending.observedAt > CONFIRMATION_WINDOW_MS) {
      pendingPriceConfirmations.delete(tokenId);
      return null;
    }
    return pending;
  }

  function pricesAreCloseEnough(
    left: number,
    right: number,
    thresholdPercent: number,
  ): boolean {
    if (left <= 0 || right <= 0) return false;
    const divergence = Math.abs(left - right) / Math.max(left, right);
    return divergence <= thresholdPercent / 100;
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

    async function fetchBatch(
      activePlan: Exclude<CoingeckoApiPlan, "auto">,
      allowAutoRetry: boolean,
    ): Promise<Map<string, number | null>> {
      const requestConfig = getRequestConfig(activePlan);

      try {
        const response = await fetchWithTimeout(
          `${requestConfig.baseUrl}/simple/price?ids=${encodeURIComponent(staleOrMissing.join(","))}&vs_currencies=usd`,
          {
            headers: {
              [requestConfig.headerName]: apiKey,
              Accept: "application/json",
            },
            label: "coingecko.price-fetch",
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
          const errorBody = await parseErrorBody(response);
          const suggestedPlan = inferRequiredPlan(errorBody);
          if (allowAutoRetry && plan === "auto" && suggestedPlan && suggestedPlan !== activePlan) {
            resolvedPlan = suggestedPlan;
            logger.warn("Switching CoinGecko API plan after auth host mismatch", {
              fromPlan: activePlan,
              toPlan: suggestedPlan,
              errorCode: getErrorCode(errorBody),
              message: getErrorMessage(errorBody),
            });
            return fetchBatch(suggestedPlan, false);
          }

          logger.error("Coingecko API error", {
            tokenIds: staleOrMissing,
            status: response.status,
            errorCode: getErrorCode(errorBody),
            message: getErrorMessage(errorBody) || undefined,
            plan: activePlan,
          });
          for (const tokenId of staleOrMissing) {
            results.set(tokenId, getCachedPrice(tokenId));
          }
          return results;
        }

        const data = (await response.json()) as Record<string, { usd: number }>;
        resolvedPlan = activePlan;

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
              const pending = getPendingConfirmation(tokenId);
              if (
                pending &&
                pricesAreCloseEnough(
                  pending.price,
                  price,
                  CONFIRMATION_MATCH_THRESHOLD_PERCENT,
                )
              ) {
                cache.set(tokenId, { price, fetchedAt: now });
                pendingPriceConfirmations.delete(tokenId);
                logger.warn("Confirmed CoinGecko price jump after repeated observation", {
                  tokenId,
                  oldPrice: cached.price,
                  confirmedPrice: price,
                  deviationPercent: (deviation * 100).toFixed(1),
                });
                results.set(tokenId, price);
                continue;
              }

              pendingPriceConfirmations.set(tokenId, {
                price,
                observedAt: now,
              });
              logger.alert("Price deviation exceeds threshold; awaiting confirmation", {
                tokenId,
                oldPrice: cached.price,
                newPrice: price,
                deviationPercent: (deviation * 100).toFixed(1),
              });
              results.set(tokenId, null);
              continue;
            }
          }

          pendingPriceConfirmations.delete(tokenId);
          cache.set(tokenId, { price, fetchedAt: now });
          results.set(tokenId, price);
        }

        return results;
      } catch (error) {
        logger.error("Coingecko fetch failed", {
          tokenIds: staleOrMissing,
          error: error instanceof Error ? error.message : String(error),
          plan: activePlan,
        });
        for (const tokenId of staleOrMissing) {
          results.set(tokenId, getCachedPrice(tokenId));
        }
        return results;
      }
    }

    return fetchBatch(resolvedPlan ?? "pro", true);
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
