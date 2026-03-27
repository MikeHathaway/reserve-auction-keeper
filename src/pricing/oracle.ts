import type { CoingeckoClient } from "./coingecko.js";
import type { ChainConfig } from "../chains/index.js";
import { logger } from "../utils/logger.js";

export interface PriceData {
  ajnaPriceUsd: number;
  quoteTokenPriceUsd: number;
  source: "coingecko" | "coingecko+onchain";
  isStale: boolean;
}

export interface PriceOracle {
  getPrices(quoteTokenSymbol: string): Promise<PriceData | null>;
}

const DIVERGENCE_THRESHOLD = 0.05; // 5%

export function createPriceOracle(
  coingecko: CoingeckoClient,
  chainConfig: ChainConfig,
): PriceOracle {
  async function getPrices(quoteTokenSymbol: string): Promise<PriceData | null> {
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
      logger.alert("Price feed unavailable", {
        chain: chainConfig.name,
        ajnaPrice,
        quotePrice,
        quoteTokenSymbol,
      });
      return null;
    }

    const isStale =
      coingecko.isPriceStale(ajnaId) || coingecko.isPriceStale(quoteId);

    if (isStale) {
      logger.warn("Price data is stale, pausing execution", {
        chain: chainConfig.name,
        quoteTokenSymbol,
      });
    }

    return {
      ajnaPriceUsd: ajnaPrice,
      quoteTokenPriceUsd: quotePrice,
      source: "coingecko",
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
