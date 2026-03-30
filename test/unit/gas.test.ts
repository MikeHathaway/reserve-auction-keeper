import { describe, it, expect } from "vitest";
import {
  getRequiredProfitUsd,
  isNearProfitableAfterGas,
  isProfitableAfterGas,
} from "../../src/execution/gas.js";

describe("gas", () => {
  describe("getRequiredProfitUsd", () => {
    it("calculates the profit floor including margin", () => {
      expect(getRequiredProfitUsd(2, 5)).toBe(2.1);
      expect(getRequiredProfitUsd(10, 20)).toBe(12);
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
