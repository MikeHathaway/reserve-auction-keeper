import { describe, it, expect } from "vitest";
import { isProfitableAfterGas } from "../../src/execution/gas.js";

describe("gas", () => {
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
});
