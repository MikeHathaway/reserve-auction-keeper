import { describe, it, expect } from "vitest";
import { checkPriceDivergence } from "../../src/pricing/oracle.js";

describe("oracle", () => {
  describe("checkPriceDivergence", () => {
    it("returns false for prices within threshold", () => {
      expect(checkPriceDivergence(100, 103, "test")).toBe(false);
    });

    it("returns true for prices beyond 5% divergence", () => {
      expect(checkPriceDivergence(100, 106, "test")).toBe(true);
    });

    it("returns true when priceA is zero", () => {
      expect(checkPriceDivergence(0, 100, "test")).toBe(true);
    });

    it("returns true when priceB is zero", () => {
      expect(checkPriceDivergence(100, 0, "test")).toBe(true);
    });

    it("returns false for identical prices", () => {
      expect(checkPriceDivergence(50, 50, "test")).toBe(false);
    });

    it("handles divergence in either direction", () => {
      expect(checkPriceDivergence(100, 90, "test")).toBe(true);
      expect(checkPriceDivergence(90, 100, "test")).toBe(true);
    });

    it("handles very small prices", () => {
      expect(checkPriceDivergence(0.003, 0.0031, "test")).toBe(false);
      expect(checkPriceDivergence(0.003, 0.004, "test")).toBe(true);
    });
  });
});
