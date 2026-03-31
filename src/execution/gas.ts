import type { PublicClient } from "viem";
import { formatGwei } from "viem";
import { logger } from "../utils/logger.js";

export interface GasCheck {
  currentGasPriceGwei: number;
  isAboveCeiling: boolean;
  estimatedCostUsd: number;
}

export function getRequiredProfitUsd(
  gasCostUsd: number,
  profitMarginPercent: number,
): number {
  return gasCostUsd * (1 + profitMarginPercent / 100);
}

/**
 * Check current gas price against the configured ceiling.
 */
export async function checkGasPrice(
  client: PublicClient,
  ceilingGwei: number,
  estimatedGasUnits: bigint = 200_000n,
  nativeTokenPriceUsd: number = 2000,
): Promise<GasCheck> {
  const gasPrice = await client.getGasPrice();
  const gasPriceGwei = Number(formatGwei(gasPrice));

  const estimatedCostWei = gasPrice * estimatedGasUnits;
  const estimatedCostEth = Number(estimatedCostWei) / 1e18;
  const estimatedCostUsd = estimatedCostEth * nativeTokenPriceUsd;

  const isAboveCeiling = gasPriceGwei > ceilingGwei;

  if (isAboveCeiling) {
    logger.warn("Gas price above ceiling, skipping execution", {
      currentGwei: gasPriceGwei.toFixed(1),
      ceilingGwei,
      estimatedCostUsd: estimatedCostUsd.toFixed(2),
    });
  }

  return {
    currentGasPriceGwei: gasPriceGwei,
    isAboveCeiling,
    estimatedCostUsd,
  };
}

/**
 * Check if an auction opportunity is profitable after gas costs.
 */
export function isProfitableAfterGas(
  estimatedProfitUsd: number,
  gasCostUsd: number,
  profitMarginPercent: number,
): boolean {
  return estimatedProfitUsd > getRequiredProfitUsd(gasCostUsd, profitMarginPercent);
}

export function isNearProfitableAfterGas(
  estimatedProfitUsd: number,
  gasCostUsd: number,
  profitMarginPercent: number,
  profitabilityThreshold: number,
): boolean {
  const minProfit = getRequiredProfitUsd(gasCostUsd, profitMarginPercent);

  if (minProfit === 0) {
    return estimatedProfitUsd > 0;
  }

  const thresholdFloor = Math.max(0, 1 - profitabilityThreshold);
  return estimatedProfitUsd >= minProfit * thresholdFloor;
}
