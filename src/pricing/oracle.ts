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
  async function getCoingeckoPrices(
    quoteTokenSymbol: string,
  ): Promise<SingleSourcePriceData | null> {
    const coingecko = options.coingecko;
    if (!coingecko) {
      throw new Error("Coingecko client is required for the selected pricing mode.");
    }

    const ajnaId = chainConfig.coingeckoIds.ajna;
    const quoteId = chainConfig.coingeckoIds.quoteTokens[quoteTokenSymbol];

    if (!quoteId) {
      logger.error("No Coingecko ID for quote token", { quoteTokenSymbol });
      return null;
    }

    const [ajnaPrice, quotePrice] = await Promise.all([
      coingecko.getPrice(ajnaId),
      coingecko.getPrice(quoteId),
    ]);

    if (ajnaPrice == null || quotePrice == null) {
      logger.alert("Coingecko price feed unavailable", {
        chain: chainConfig.name,
        ajnaPrice,
        quotePrice,
        quoteTokenSymbol,
      });
      return null;
    }

    return {
      ajnaPriceUsd: ajnaPrice,
      quoteTokenPriceUsd: quotePrice,
      isStale:
        coingecko.isPriceStale(ajnaId) || coingecko.isPriceStale(quoteId),
    };
  }

  async function getAlchemyPrices(
    quoteTokenSymbol: string,
  ): Promise<SingleSourcePriceData | null> {
    const alchemy = options.alchemy;
    if (!alchemy) {
      throw new Error("Alchemy client is required for the selected pricing mode.");
    }

    if (!chainConfig.alchemySlug) {
      logger.error("No Alchemy network slug configured for chain", {
        chain: chainConfig.name,
      });
      return null;
    }

    const quoteTokenAddress = chainConfig.quoteTokens[quoteTokenSymbol];
    if (!quoteTokenAddress) {
      logger.error("No quote token address configured for Alchemy pricing", {
        chain: chainConfig.name,
        quoteTokenSymbol,
      });
      return null;
    }

    const prices = await alchemy.getPrices(
      chainConfig.alchemySlug,
      [chainConfig.ajnaToken, quoteTokenAddress] as Address[],
    );
    const ajnaPrice = prices.get(chainConfig.ajnaToken) ?? null;
    const quotePrice = prices.get(quoteTokenAddress) ?? null;

    if (ajnaPrice == null || quotePrice == null) {
      logger.alert("Alchemy price feed unavailable", {
        chain: chainConfig.name,
        ajnaPrice,
        quotePrice,
        quoteTokenSymbol,
      });
      return null;
    }

    return {
      ajnaPriceUsd: ajnaPrice,
      quoteTokenPriceUsd: quotePrice,
      isStale:
        alchemy.isPriceStale(chainConfig.alchemySlug, chainConfig.ajnaToken) ||
        alchemy.isPriceStale(chainConfig.alchemySlug, quoteTokenAddress),
    };
  }

  async function getPrices(quoteTokenSymbol: string): Promise<PriceData | null> {
    if (options.provider === "coingecko") {
      const prices = await getCoingeckoPrices(quoteTokenSymbol);
      if (!prices) return null;

      if (prices.isStale) {
        logger.warn("Price data is stale, pausing execution", {
          chain: chainConfig.name,
          quoteTokenSymbol,
          source: "coingecko",
        });
      }

      return {
        ...prices,
        source: "coingecko",
      };
    }

    if (options.provider === "alchemy") {
      const prices = await getAlchemyPrices(quoteTokenSymbol);
      if (!prices) return null;

      if (prices.isStale) {
        logger.warn("Price data is stale, pausing execution", {
          chain: chainConfig.name,
          quoteTokenSymbol,
          source: "alchemy",
        });
      }

      return {
        ...prices,
        source: "alchemy",
      };
    }

    const [coingeckoPrices, alchemyPrices] = await Promise.all([
      getCoingeckoPrices(quoteTokenSymbol),
      getAlchemyPrices(quoteTokenSymbol),
    ]);

    if (!coingeckoPrices || !alchemyPrices) {
      logger.alert("Dual price feed unavailable", {
        chain: chainConfig.name,
        quoteTokenSymbol,
        coingeckoAvailable: !!coingeckoPrices,
        alchemyAvailable: !!alchemyPrices,
      });
      return null;
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
      return null;
    }

    return {
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
    };
  }

  return { getPrices };
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
