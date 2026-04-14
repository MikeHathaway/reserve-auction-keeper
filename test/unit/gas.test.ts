import { describe, it, expect, vi } from "vitest";
import { parseGwei } from "viem";
import {
  checkGasPrice,
  getNextBlockSafeFeeCapOverrides,
  getNextBlockSafeGasPriceWei,
  getRequiredProfitUsd,
  isNearProfitableAfterGas,
  isProfitableAfterGas,
} from "../../src/execution/gas.js";

describe("gas", () => {
  describe("checkGasPrice", () => {
    it("uses the configured native token price for USD estimation", async () => {
      const client = {
        getGasPrice: vi.fn().mockResolvedValue(parseGwei("50")),
      };

      const gasCheck = await checkGasPrice(
        client as never,
        100,
        200_000n,
        1,
      );

      expect(gasCheck.estimatedCostUsd).toBeCloseTo(0.01, 6);
      expect(gasCheck.isAboveCeiling).toBe(false);
    });

    it("marks gas above the ceiling and scales cost with higher native token prices", async () => {
      const client = {
        getGasPrice: vi.fn().mockResolvedValue(parseGwei("150")),
      };

      const gasCheck = await checkGasPrice(
        client as never,
        100,
        200_000n,
        2000,
      );

      expect(gasCheck.estimatedCostUsd).toBeCloseTo(60, 6);
      expect(gasCheck.isAboveCeiling).toBe(true);
    });
  });

  describe("getRequiredProfitUsd", () => {
    it("calculates the profit floor including margin", () => {
      expect(getRequiredProfitUsd(2, 5)).toBe(2.1);
      expect(getRequiredProfitUsd(10, 20)).toBe(12);
    });
  });

  describe("getNextBlockSafeGasPriceWei", () => {
    it("keeps the observed gas price when no base fee is available", () => {
      expect(getNextBlockSafeGasPriceWei(parseGwei("10"))).toBe(parseGwei("10"));
    });

    it("pads the fee cap for worst-case next-block base fee growth", () => {
      expect(
        getNextBlockSafeGasPriceWei(parseGwei("30"), parseGwei("28")),
      ).toBe(parseGwei("33.5"));
    });
  });

  describe("getNextBlockSafeFeeCapOverrides", () => {
    it("preserves the observed priority fee instead of hard-clamping it", () => {
      expect(
        getNextBlockSafeFeeCapOverrides(parseGwei("30"), parseGwei("28")),
      ).toEqual({
        maxFeePerGas: parseGwei("33.5"),
        maxPriorityFeePerGas: parseGwei("2"),
      });
    });
  });

  describe("isProfitableAfterGas", () => {
    it("returns true when profit exceeds gas + margin", () => {
      expect(isProfitableAfterGas(10, 2, 5)).toBe(true);
    });

    it("returns false when profit is below gas + margin", () => {
      expect(isProfitableAfterGas(1, 2, 5)).toBe(false);
    });

    it("returns false when profit equals gas cost exactly", () => {
      // With 5% margin: minProfit = 2 * 1.05 = 2.1
      expect(isProfitableAfterGas(2.1, 2, 5)).toBe(false);
    });

    it("returns true when profit barely exceeds threshold", () => {
      // With 5% margin: minProfit = 2 * 1.05 = 2.1
      expect(isProfitableAfterGas(2.2, 2, 5)).toBe(true);
    });

    it("handles zero gas cost", () => {
      expect(isProfitableAfterGas(0.01, 0, 5)).toBe(true);
    });

    it("handles zero margin", () => {
      // With 0% margin: minProfit = gas cost
      expect(isProfitableAfterGas(3, 2, 0)).toBe(true);
      expect(isProfitableAfterGas(1, 2, 0)).toBe(false);
    });

    it("handles large margin", () => {
      // With 100% margin: minProfit = 2 * 2 = 4
      expect(isProfitableAfterGas(5, 2, 100)).toBe(true);
      expect(isProfitableAfterGas(3, 2, 100)).toBe(false);
    });
  });

  describe("isNearProfitableAfterGas", () => {
    it("returns true when profit is within the configured threshold window", () => {
      expect(isNearProfitableAfterGas(1.9, 2, 5, 0.1)).toBe(true);
    });

    it("returns false when profit is too far below the threshold", () => {
      expect(isNearProfitableAfterGas(1.5, 2, 5, 0.1)).toBe(false);
    });

    it("treats zero gas cost as near-profitable only when profit is positive", () => {
      expect(isNearProfitableAfterGas(0.01, 0, 5, 0.2)).toBe(true);
      expect(isNearProfitableAfterGas(0, 0, 5, 0.2)).toBe(false);
    });
  });
});
