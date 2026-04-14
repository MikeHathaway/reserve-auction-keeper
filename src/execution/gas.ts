import type { PublicClient } from "viem";
import { formatGwei } from "viem";
import { logger } from "../utils/logger.js";

const MAX_BASE_FEE_GROWTH_NUMERATOR = 9n;
const MAX_BASE_FEE_GROWTH_DENOMINATOR = 8n;

export interface GasCheck {
  currentGasPriceGwei: number;
  isAboveCeiling: boolean;
  estimatedCostUsd: number;
}

export interface FeeCapOverrides {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

export function getMaxNextBlockBaseFeePerGas(
  latestBaseFeePerGasWei?: bigint,
): bigint | undefined {
  if (!latestBaseFeePerGasWei || latestBaseFeePerGasWei <= 0n) {
    return undefined;
  }

  return (
    latestBaseFeePerGasWei * MAX_BASE_FEE_GROWTH_NUMERATOR +
    (MAX_BASE_FEE_GROWTH_DENOMINATOR - 1n)
  ) / MAX_BASE_FEE_GROWTH_DENOMINATOR;
}

export function getObservedPriorityFeePerGasWei(
  observedGasPriceWei: bigint,
  latestBaseFeePerGasWei?: bigint,
): bigint {
  const currentBaseFeePerGasWei = latestBaseFeePerGasWei ?? 0n;

  return observedGasPriceWei > currentBaseFeePerGasWei
    ? observedGasPriceWei - currentBaseFeePerGasWei
    : observedGasPriceWei;
}

export function getNextBlockSafeFeeCapOverrides(
  observedGasPriceWei: bigint,
  latestBaseFeePerGasWei?: bigint,
): FeeCapOverrides {
  const maxPriorityFeePerGas = getObservedPriorityFeePerGasWei(
    observedGasPriceWei,
    latestBaseFeePerGasWei,
  );
  const nextBlockBaseFeePerGasWei = getMaxNextBlockBaseFeePerGas(
    latestBaseFeePerGasWei,
  );

  const maxFeePerGas = nextBlockBaseFeePerGasWei == null
    ? observedGasPriceWei
    : (() => {
        const nextBlockTarget = nextBlockBaseFeePerGasWei + maxPriorityFeePerGas;
        return nextBlockTarget > observedGasPriceWei
          ? nextBlockTarget
          : observedGasPriceWei;
      })();

  return {
    maxFeePerGas,
    maxPriorityFeePerGas:
      maxPriorityFeePerGas > maxFeePerGas ? maxFeePerGas : maxPriorityFeePerGas,
  };
}

export function getNextBlockSafeGasPriceWei(
  observedGasPriceWei: bigint,
  latestBaseFeePerGasWei?: bigint,
): bigint {
  return getNextBlockSafeFeeCapOverrides(
    observedGasPriceWei,
    latestBaseFeePerGasWei,
  ).maxFeePerGas;
}

export function getRequiredProfitUsd(
  estimatedCostUsd: number,
  profitMarginPercent: number,
): number {
  return estimatedCostUsd * (1 + profitMarginPercent / 100);
}

export function sumEstimatedCostsUsd(...costs: number[]): number {
  return costs.reduce((sum, cost) => sum + cost, 0);
}

export function getEip1559FeeCapOverrides(
  maxGasPriceWei?: bigint,
  maxPriorityFeePerGasWei?: bigint,
): FeeCapOverrides | undefined {
  if (!maxGasPriceWei || maxGasPriceWei <= 0n) {
    return undefined;
  }

  return {
    maxFeePerGas: maxGasPriceWei,
    maxPriorityFeePerGas:
      maxPriorityFeePerGasWei == null || maxPriorityFeePerGasWei > maxGasPriceWei
        ? maxGasPriceWei
        : maxPriorityFeePerGasWei,
  };
}

export function evaluateGasCost(
  gasPrice: bigint,
  ceilingGwei: number,
  estimatedGasUnits: bigint = 200_000n,
  nativeTokenPriceUsd: number = 2000,
): GasCheck {
  const gasPriceGwei = Number(formatGwei(gasPrice));

  const estimatedCostWei = gasPrice * estimatedGasUnits;
  const estimatedCostEth = Number(estimatedCostWei) / 1e18;
  const estimatedCostUsd = estimatedCostEth * nativeTokenPriceUsd;

  const isAboveCeiling = gasPriceGwei > ceilingGwei;

  return {
    currentGasPriceGwei: gasPriceGwei,
    isAboveCeiling,
    estimatedCostUsd,
  };
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
  const result = evaluateGasCost(
    gasPrice,
    ceilingGwei,
    estimatedGasUnits,
    nativeTokenPriceUsd,
  );

  if (result.isAboveCeiling) {
    logger.warn("Gas price above ceiling, skipping execution", {
      currentGwei: result.currentGasPriceGwei.toFixed(1),
      ceilingGwei,
      estimatedCostUsd: result.estimatedCostUsd.toFixed(2),
    });
  }

  return result;
}

/**
 * Check if an opportunity is profitable after estimated costs.
 */
export function isProfitableAfterCosts(
  estimatedProfitUsd: number,
  estimatedCostUsd: number,
  profitMarginPercent: number,
): boolean {
  return estimatedProfitUsd > getRequiredProfitUsd(estimatedCostUsd, profitMarginPercent);
}

export function isNearProfitableAfterCosts(
  estimatedProfitUsd: number,
  estimatedCostUsd: number,
  profitMarginPercent: number,
  profitabilityThreshold: number,
): boolean {
  const minProfit = getRequiredProfitUsd(estimatedCostUsd, profitMarginPercent);

  if (minProfit === 0) {
    return estimatedProfitUsd > 0;
  }

  const thresholdFloor = Math.max(0, 1 - profitabilityThreshold);
  return estimatedProfitUsd >= minProfit * thresholdFloor;
}

export const isProfitableAfterGas = isProfitableAfterCosts;
export const isNearProfitableAfterGas = isNearProfitableAfterCosts;
