import type { CoingeckoClient } from "./coingecko.js";
import type { AlchemyPricesClient } from "./alchemy.js";
import type { ChainConfig } from "../chains/index.js";
import type { Address } from "viem";
import { logger } from "../utils/logger.js";

export type PriceProvider = "coingecko" | "alchemy" | "hybrid";

export function requiresCoingeckoPricing(provider: PriceProvider): boolean {
  return provider === "coingecko" || provider === "hybrid";
}

export function requiresAlchemyPricing(provider: PriceProvider): boolean {
  return provider === "alchemy" || provider === "hybrid";
}

export interface PriceData {
  ajnaPriceUsd: number;
  quoteTokenPriceUsd: number;
  source: PriceProvider;
  isStale: boolean;
}

export interface PriceOracle {
  getPrices(quoteTokenSymbol: string): Promise<PriceData | null>;
  getPricesForQuoteTokens(quoteTokenSymbols: string[]): Promise<Map<string, PriceData | null>>;
}

const DIVERGENCE_THRESHOLD = 0.05; // 5%

interface SingleSourcePriceData {
  ajnaPriceUsd: number;
  quoteTokenPriceUsd: number;
  isStale: boolean;
}

interface AjnaSourcePriceData {
  ajnaPriceUsd: number;
  isStale: boolean;
}

interface QuoteSourcePriceData {
  quoteTokenPriceUsd: number;
  isStale: boolean;
}

interface PriceOracleOptions {
  provider: PriceProvider;
  coingecko?: CoingeckoClient;
  alchemy?: AlchemyPricesClient;
}

export function createPriceOracle(
  options: PriceOracleOptions,
  chainConfig: ChainConfig,
): PriceOracle {
  function dedupeQuoteTokenSymbols(quoteTokenSymbols: string[]): string[] {
    return [...new Set(quoteTokenSymbols)];
  }

  async function getCoingeckoPriceInputs(
    quoteTokenSymbols: string[],
  ): Promise<{
    ajnaPrice: AjnaSourcePriceData | null;
    quotePrices: Map<string, QuoteSourcePriceData | null>;
  }> {
    const quotePrices = new Map<string, QuoteSourcePriceData | null>();
    const uniqueQuoteTokenSymbols = dedupeQuoteTokenSymbols(quoteTokenSymbols);
    if (uniqueQuoteTokenSymbols.length === 0) {
      return { ajnaPrice: null, quotePrices };
    }

    const coingecko = options.coingecko;
    if (!coingecko) {
      throw new Error("Coingecko client is required for the selected pricing mode.");
    }

    const ajnaId = chainConfig.coingeckoIds.ajna;
    const quoteTokenIds = new Map<string, string>();

    for (const quoteTokenSymbol of uniqueQuoteTokenSymbols) {
      const quoteId = chainConfig.coingeckoIds.quoteTokens[quoteTokenSymbol];
      if (!quoteId) {
        logger.error("No Coingecko ID for quote token", {
          chain: chainConfig.name,
          quoteTokenSymbol,
        });
        quotePrices.set(quoteTokenSymbol, null);
        continue;
      }

      quoteTokenIds.set(quoteTokenSymbol, quoteId);
    }

    if (quoteTokenIds.size === 0) {
      return { ajnaPrice: null, quotePrices };
    }

    const fetchedPrices = await coingecko.getPrices([
      ajnaId,
      ...new Set(quoteTokenIds.values()),
    ]);
    const fetchedAjnaPrice = fetchedPrices.get(ajnaId) ?? null;
    const ajnaPrice = fetchedAjnaPrice == null
      ? null
      : {
          ajnaPriceUsd: fetchedAjnaPrice,
          isStale: coingecko.isPriceStale(ajnaId),
        };

    if (ajnaPrice == null) {
      logger.alert("Coingecko AJNA price feed unavailable", {
        chain: chainConfig.name,
        ajnaPrice: fetchedAjnaPrice,
        quoteTokenSymbols: uniqueQuoteTokenSymbols,
      });
    }

    for (const quoteTokenSymbol of uniqueQuoteTokenSymbols) {
      if (quotePrices.has(quoteTokenSymbol)) continue;

      const quoteId = quoteTokenIds.get(quoteTokenSymbol)!;
      const quotePrice = fetchedPrices.get(quoteId) ?? null;
      if (quotePrice == null) {
        logger.alert("Coingecko quote-token price feed unavailable", {
          chain: chainConfig.name,
          quoteTokenSymbol,
          quoteId,
        });
        quotePrices.set(quoteTokenSymbol, null);
        continue;
      }

      quotePrices.set(quoteTokenSymbol, {
        quoteTokenPriceUsd: quotePrice,
        isStale: coingecko.isPriceStale(quoteId),
      });
    }

    return { ajnaPrice, quotePrices };
  }

  async function getCoingeckoBatchPrices(
    quoteTokenSymbols: string[],
  ): Promise<Map<string, SingleSourcePriceData | null>> {
    const results = new Map<string, SingleSourcePriceData | null>();
    const uniqueQuoteTokenSymbols = dedupeQuoteTokenSymbols(quoteTokenSymbols);
    if (uniqueQuoteTokenSymbols.length === 0) {
      return results;
    }

    const { ajnaPrice, quotePrices } = await getCoingeckoPriceInputs(uniqueQuoteTokenSymbols);
    if (ajnaPrice == null) {
      for (const quoteTokenSymbol of uniqueQuoteTokenSymbols) {
        results.set(quoteTokenSymbol, null);
      }
      return results;
    }

    for (const quoteTokenSymbol of uniqueQuoteTokenSymbols) {
      const quotePrice = quotePrices.get(quoteTokenSymbol) ?? null;
      if (!quotePrice) {
        results.set(quoteTokenSymbol, null);
        continue;
      }

      results.set(quoteTokenSymbol, {
        ajnaPriceUsd: ajnaPrice.ajnaPriceUsd,
        quoteTokenPriceUsd: quotePrice.quoteTokenPriceUsd,
        isStale: ajnaPrice.isStale || quotePrice.isStale,
      });
    }

    return results;
  }

  async function getAlchemyBatchPrices(
    quoteTokenSymbols: string[],
  ): Promise<Map<string, SingleSourcePriceData | null>> {
    const results = new Map<string, SingleSourcePriceData | null>();
    const uniqueQuoteTokenSymbols = dedupeQuoteTokenSymbols(quoteTokenSymbols);
    if (uniqueQuoteTokenSymbols.length === 0) {
      return results;
    }

    const alchemy = options.alchemy;
    if (!alchemy) {
      throw new Error("Alchemy client is required for the selected pricing mode.");
    }

    if (!chainConfig.alchemySlug) {
      logger.error("No Alchemy network slug configured for chain", {
        chain: chainConfig.name,
      });
      for (const quoteTokenSymbol of uniqueQuoteTokenSymbols) {
        results.set(quoteTokenSymbol, null);
      }
      return results;
    }

    const quoteTokenAddresses = new Map<string, Address>();
    for (const quoteTokenSymbol of uniqueQuoteTokenSymbols) {
      const quoteTokenAddress = chainConfig.quoteTokens[quoteTokenSymbol];
      if (!quoteTokenAddress) {
        logger.error("No quote token address configured for Alchemy pricing", {
          chain: chainConfig.name,
          quoteTokenSymbol,
        });
        results.set(quoteTokenSymbol, null);
        continue;
      }

      quoteTokenAddresses.set(quoteTokenSymbol, quoteTokenAddress);
    }

    if (quoteTokenAddresses.size === 0) {
      return results;
    }

    const prices = await alchemy.getPrices(
      chainConfig.alchemySlug,
      [chainConfig.ajnaToken, ...new Set(quoteTokenAddresses.values())] as Address[],
    );
    const ajnaPrice = prices.get(chainConfig.ajnaToken) ?? null;

    if (ajnaPrice == null) {
      logger.alert("Alchemy AJNA price feed unavailable", {
        chain: chainConfig.name,
        ajnaPrice,
        quoteTokenSymbols: uniqueQuoteTokenSymbols,
      });
      for (const quoteTokenSymbol of uniqueQuoteTokenSymbols) {
        if (!results.has(quoteTokenSymbol)) {
          results.set(quoteTokenSymbol, null);
        }
      }
      return results;
    }

    for (const quoteTokenSymbol of uniqueQuoteTokenSymbols) {
      if (results.has(quoteTokenSymbol)) continue;

      const quoteTokenAddress = quoteTokenAddresses.get(quoteTokenSymbol)!;
      const quotePrice = prices.get(quoteTokenAddress) ?? null;
      if (quotePrice == null) {
        logger.alert("Alchemy quote-token price feed unavailable", {
          chain: chainConfig.name,
          quoteTokenSymbol,
          quoteTokenAddress,
        });
        results.set(quoteTokenSymbol, null);
        continue;
      }

      results.set(quoteTokenSymbol, {
        ajnaPriceUsd: ajnaPrice,
        quoteTokenPriceUsd: quotePrice,
        isStale:
          alchemy.isPriceStale(chainConfig.alchemySlug, chainConfig.ajnaToken) ||
          alchemy.isPriceStale(chainConfig.alchemySlug, quoteTokenAddress),
      });
    }

    return results;
  }

  async function getAlchemyQuoteBatchPrices(
    quoteTokenSymbols: string[],
  ): Promise<Map<string, QuoteSourcePriceData | null>> {
    const results = new Map<string, QuoteSourcePriceData | null>();
    const uniqueQuoteTokenSymbols = dedupeQuoteTokenSymbols(quoteTokenSymbols);
    if (uniqueQuoteTokenSymbols.length === 0) {
      return results;
    }

    const alchemy = options.alchemy;
    if (!alchemy) {
      throw new Error("Alchemy client is required for the selected pricing mode.");
    }

    if (!chainConfig.alchemySlug) {
      logger.error("No Alchemy network slug configured for chain", {
        chain: chainConfig.name,
      });
      for (const quoteTokenSymbol of uniqueQuoteTokenSymbols) {
        results.set(quoteTokenSymbol, null);
      }
      return results;
    }

    const quoteTokenAddresses = new Map<string, Address>();
    for (const quoteTokenSymbol of uniqueQuoteTokenSymbols) {
      const quoteTokenAddress = chainConfig.quoteTokens[quoteTokenSymbol];
      if (!quoteTokenAddress) {
        logger.error("No quote token address configured for Alchemy pricing", {
          chain: chainConfig.name,
          quoteTokenSymbol,
        });
        results.set(quoteTokenSymbol, null);
        continue;
      }

      quoteTokenAddresses.set(quoteTokenSymbol, quoteTokenAddress);
    }

    if (quoteTokenAddresses.size === 0) {
      return results;
    }

    const prices = await alchemy.getPrices(
      chainConfig.alchemySlug,
      [...new Set(quoteTokenAddresses.values())] as Address[],
    );

    for (const quoteTokenSymbol of uniqueQuoteTokenSymbols) {
      if (results.has(quoteTokenSymbol)) continue;

      const quoteTokenAddress = quoteTokenAddresses.get(quoteTokenSymbol)!;
      const quotePrice = prices.get(quoteTokenAddress) ?? null;
      if (quotePrice == null) {
        logger.alert("Alchemy quote-token price feed unavailable", {
          chain: chainConfig.name,
          quoteTokenSymbol,
          quoteTokenAddress,
        });
        results.set(quoteTokenSymbol, null);
        continue;
      }

      results.set(quoteTokenSymbol, {
        quoteTokenPriceUsd: quotePrice,
        isStale: alchemy.isPriceStale(chainConfig.alchemySlug, quoteTokenAddress),
      });
    }

    return results;
  }

  async function getPricesForQuoteTokens(
    quoteTokenSymbols: string[],
  ): Promise<Map<string, PriceData | null>> {
    const results = new Map<string, PriceData | null>();
    const uniqueQuoteTokenSymbols = dedupeQuoteTokenSymbols(quoteTokenSymbols);
    if (uniqueQuoteTokenSymbols.length === 0) {
      return results;
    }

    if (options.provider === "coingecko") {
      const sourcePrices = await getCoingeckoBatchPrices(uniqueQuoteTokenSymbols);
      for (const quoteTokenSymbol of uniqueQuoteTokenSymbols) {
        const prices = sourcePrices.get(quoteTokenSymbol) ?? null;
        if (!prices) {
          results.set(quoteTokenSymbol, null);
          continue;
        }

        if (prices.isStale) {
          logger.warn("Price data is stale, pausing execution", {
            chain: chainConfig.name,
            quoteTokenSymbol,
            source: "coingecko",
          });
        }

        results.set(quoteTokenSymbol, {
          ...prices,
          source: "coingecko",
        });
      }

      return results;
    }

    if (options.provider === "alchemy") {
      const sourcePrices = await getAlchemyBatchPrices(uniqueQuoteTokenSymbols);
      for (const quoteTokenSymbol of uniqueQuoteTokenSymbols) {
        const prices = sourcePrices.get(quoteTokenSymbol) ?? null;
        if (!prices) {
          results.set(quoteTokenSymbol, null);
          continue;
        }

        if (prices.isStale) {
          logger.warn("Price data is stale, pausing execution", {
            chain: chainConfig.name,
            quoteTokenSymbol,
            source: "alchemy",
          });
        }

        results.set(quoteTokenSymbol, {
          ...prices,
          source: "alchemy",
        });
      }

      return results;
    }

    const [coingeckoInputs, alchemyQuotePricesBySymbol] = await Promise.all([
      getCoingeckoPriceInputs(uniqueQuoteTokenSymbols),
      getAlchemyQuoteBatchPrices(uniqueQuoteTokenSymbols),
    ]);

    const coingeckoAjnaPrice = coingeckoInputs.ajnaPrice;
    if (!coingeckoAjnaPrice) {
      for (const quoteTokenSymbol of uniqueQuoteTokenSymbols) {
        results.set(quoteTokenSymbol, null);
      }
      return results;
    }

    for (const quoteTokenSymbol of uniqueQuoteTokenSymbols) {
      const coingeckoQuotePrice = coingeckoInputs.quotePrices.get(quoteTokenSymbol) ?? null;
      const alchemyQuotePrice = alchemyQuotePricesBySymbol.get(quoteTokenSymbol) ?? null;

      if (!coingeckoQuotePrice && !alchemyQuotePrice) {
        logger.alert("Hybrid quote price feed unavailable", {
          chain: chainConfig.name,
          quoteTokenSymbol,
          coingeckoAvailable: false,
          alchemyAvailable: false,
        });
        results.set(quoteTokenSymbol, null);
        continue;
      }

      if (coingeckoQuotePrice && alchemyQuotePrice) {
        const isStale =
          coingeckoAjnaPrice.isStale ||
          coingeckoQuotePrice.isStale ||
          alchemyQuotePrice.isStale;

        if (isStale) {
          logger.warn("Price data is stale, pausing execution", {
            chain: chainConfig.name,
            quoteTokenSymbol,
            source: "hybrid",
          });
        }

        const quoteDiverged = checkPriceDivergence(
          coingeckoQuotePrice.quoteTokenPriceUsd,
          alchemyQuotePrice.quoteTokenPriceUsd,
          `${chainConfig.name}.${quoteTokenSymbol}`,
        );

        if (quoteDiverged) {
          logger.alert("Hybrid quote price feeds diverged, pausing execution", {
            chain: chainConfig.name,
            quoteTokenSymbol,
            quote: {
              coingecko: coingeckoQuotePrice.quoteTokenPriceUsd,
              alchemy: alchemyQuotePrice.quoteTokenPriceUsd,
            },
          });
          results.set(quoteTokenSymbol, null);
          continue;
        }

        results.set(quoteTokenSymbol, {
          ajnaPriceUsd: coingeckoAjnaPrice.ajnaPriceUsd,
          quoteTokenPriceUsd: Math.min(
            coingeckoQuotePrice.quoteTokenPriceUsd,
            alchemyQuotePrice.quoteTokenPriceUsd,
          ),
          source: "hybrid",
          isStale,
        });
        continue;
      }

      if (coingeckoQuotePrice) {
        logger.warn("Hybrid price feed degraded, falling back to CoinGecko quote price", {
          chain: chainConfig.name,
          quoteTokenSymbol,
          missingSource: "alchemy",
        });

        const isStale = coingeckoAjnaPrice.isStale || coingeckoQuotePrice.isStale;
        if (isStale) {
          logger.warn("Price data is stale, pausing execution", {
            chain: chainConfig.name,
            quoteTokenSymbol,
            source: "hybrid",
          });
        }

        results.set(quoteTokenSymbol, {
          ajnaPriceUsd: coingeckoAjnaPrice.ajnaPriceUsd,
          quoteTokenPriceUsd: coingeckoQuotePrice.quoteTokenPriceUsd,
          source: "hybrid",
          isStale,
        });
        continue;
      }

      logger.warn("Hybrid price feed degraded, falling back to Alchemy quote price", {
        chain: chainConfig.name,
        quoteTokenSymbol,
        missingSource: "coingecko",
      });

      const isStale = coingeckoAjnaPrice.isStale || alchemyQuotePrice!.isStale;
      results.set(quoteTokenSymbol, {
        ajnaPriceUsd: coingeckoAjnaPrice.ajnaPriceUsd,
        quoteTokenPriceUsd: alchemyQuotePrice!.quoteTokenPriceUsd,
        source: "hybrid",
        isStale,
      });
    }

    return results;
  }

  async function getPrices(quoteTokenSymbol: string): Promise<PriceData | null> {
    return (await getPricesForQuoteTokens([quoteTokenSymbol])).get(quoteTokenSymbol) ?? null;
  }

  return { getPrices, getPricesForQuoteTokens };
}

/**
 * Check if two price sources diverge beyond the threshold.
 * Used when on-chain Uniswap price is available as a cross-check.
 */
export function checkPriceDivergence(
  priceA: number,
  priceB: number,
  label: string,
): boolean {
  if (priceA === 0 || priceB === 0) return true;
  const divergence = Math.abs(priceA - priceB) / Math.max(priceA, priceB);
  if (divergence > DIVERGENCE_THRESHOLD) {
    logger.alert("Price divergence detected", {
      label,
      priceA,
      priceB,
      divergencePercent: (divergence * 100).toFixed(1),
    });
    return true;
  }
  return false;
}
