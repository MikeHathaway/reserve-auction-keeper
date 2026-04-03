import type { CoingeckoClient } from "./coingecko.js";
import type { AlchemyPricesClient } from "./alchemy.js";
import type { ChainConfig } from "../chains/index.js";
import type { Address } from "viem";
import { logger } from "../utils/logger.js";

export type PriceProvider = "coingecko" | "alchemy" | "dual";

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

  async function getCoingeckoBatchPrices(
    quoteTokenSymbols: string[],
  ): Promise<Map<string, SingleSourcePriceData | null>> {
    const results = new Map<string, SingleSourcePriceData | null>();
    const uniqueQuoteTokenSymbols = dedupeQuoteTokenSymbols(quoteTokenSymbols);
    if (uniqueQuoteTokenSymbols.length === 0) {
      return results;
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
        results.set(quoteTokenSymbol, null);
        continue;
      }

      quoteTokenIds.set(quoteTokenSymbol, quoteId);
    }

    if (quoteTokenIds.size === 0) {
      return results;
    }

    const fetchedPrices = await coingecko.getPrices([
      ajnaId,
      ...new Set(quoteTokenIds.values()),
    ]);
    const ajnaPrice = fetchedPrices.get(ajnaId) ?? null;

    if (ajnaPrice == null) {
      logger.alert("Coingecko AJNA price feed unavailable", {
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

      const quoteId = quoteTokenIds.get(quoteTokenSymbol)!;
      const quotePrice = fetchedPrices.get(quoteId) ?? null;
      if (quotePrice == null) {
        logger.alert("Coingecko quote-token price feed unavailable", {
          chain: chainConfig.name,
          quoteTokenSymbol,
          quoteId,
        });
        results.set(quoteTokenSymbol, null);
        continue;
      }

      results.set(quoteTokenSymbol, {
        ajnaPriceUsd: ajnaPrice,
        quoteTokenPriceUsd: quotePrice,
        isStale:
          coingecko.isPriceStale(ajnaId) || coingecko.isPriceStale(quoteId),
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

    const [coingeckoPricesBySymbol, alchemyPricesBySymbol] = await Promise.all([
      getCoingeckoBatchPrices(uniqueQuoteTokenSymbols),
      getAlchemyBatchPrices(uniqueQuoteTokenSymbols),
    ]);

    for (const quoteTokenSymbol of uniqueQuoteTokenSymbols) {
      const coingeckoPrices = coingeckoPricesBySymbol.get(quoteTokenSymbol) ?? null;
      const alchemyPrices = alchemyPricesBySymbol.get(quoteTokenSymbol) ?? null;

      if (!coingeckoPrices || !alchemyPrices) {
        logger.alert("Dual price feed unavailable", {
          chain: chainConfig.name,
          quoteTokenSymbol,
          coingeckoAvailable: !!coingeckoPrices,
          alchemyAvailable: !!alchemyPrices,
        });
        results.set(quoteTokenSymbol, null);
        continue;
      }

      const isStale = coingeckoPrices.isStale || alchemyPrices.isStale;

      if (isStale) {
        logger.warn("Price data is stale, pausing execution", {
          chain: chainConfig.name,
          quoteTokenSymbol,
          source: "dual",
        });
      }

      const ajnaDiverged = checkPriceDivergence(
        coingeckoPrices.ajnaPriceUsd,
        alchemyPrices.ajnaPriceUsd,
        `${chainConfig.name}.ajna`,
      );
      const quoteDiverged = checkPriceDivergence(
        coingeckoPrices.quoteTokenPriceUsd,
        alchemyPrices.quoteTokenPriceUsd,
        `${chainConfig.name}.${quoteTokenSymbol}`,
      );

      if (ajnaDiverged || quoteDiverged) {
        logger.alert("Dual price feeds diverged, pausing execution", {
          chain: chainConfig.name,
          quoteTokenSymbol,
          ajna: {
            coingecko: coingeckoPrices.ajnaPriceUsd,
            alchemy: alchemyPrices.ajnaPriceUsd,
          },
          quote: {
            coingecko: coingeckoPrices.quoteTokenPriceUsd,
            alchemy: alchemyPrices.quoteTokenPriceUsd,
          },
        });
        results.set(quoteTokenSymbol, null);
        continue;
      }

      results.set(quoteTokenSymbol, {
        ajnaPriceUsd: Math.max(
          coingeckoPrices.ajnaPriceUsd,
          alchemyPrices.ajnaPriceUsd,
        ),
        quoteTokenPriceUsd: Math.min(
          coingeckoPrices.quoteTokenPriceUsd,
          alchemyPrices.quoteTokenPriceUsd,
        ),
        source: "dual",
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
