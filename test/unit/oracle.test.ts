import { describe, it, expect } from "vitest";
import { MAINNET_CONFIG } from "../../src/chains/index.js";
import { checkPriceDivergence, createPriceOracle } from "../../src/pricing/oracle.js";

describe("oracle", () => {
  describe("createPriceOracle", () => {
    it("returns alchemy prices when configured", async () => {
      const oracle = createPriceOracle(
        {
          provider: "alchemy",
          alchemy: {
            getPrices: async () =>
              new Map([
                [MAINNET_CONFIG.ajnaToken, 0.003],
                [MAINNET_CONFIG.quoteTokens.USDC, 1],
              ]),
            isPriceStale: () => false,
          },
        },
        MAINNET_CONFIG,
      );

      await expect(oracle.getPrices("USDC")).resolves.toEqual({
        ajnaPriceUsd: 0.003,
        quoteTokenPriceUsd: 1,
        source: "alchemy",
        isStale: false,
      });
    });

    it("returns conservative dual prices when feeds agree", async () => {
      const oracle = createPriceOracle(
        {
          provider: "dual",
          coingecko: {
            getPrice: async (tokenId: string) => tokenId === "ajna-protocol" ? 0.003 : 1.01,
            isPriceStale: () => false,
          },
          alchemy: {
            getPrices: async () =>
              new Map([
                [MAINNET_CONFIG.ajnaToken, 0.0031],
                [MAINNET_CONFIG.quoteTokens.USDC, 1],
              ]),
            isPriceStale: () => false,
          },
        },
        MAINNET_CONFIG,
      );

      await expect(oracle.getPrices("USDC")).resolves.toEqual({
        ajnaPriceUsd: 0.0031,
        quoteTokenPriceUsd: 1,
        source: "dual",
        isStale: false,
      });
    });

    it("returns null when dual feeds diverge beyond threshold", async () => {
      const oracle = createPriceOracle(
        {
          provider: "dual",
          coingecko: {
            getPrice: async (tokenId: string) => tokenId === "ajna-protocol" ? 0.003 : 1,
            isPriceStale: () => false,
          },
          alchemy: {
            getPrices: async () =>
              new Map([
                [MAINNET_CONFIG.ajnaToken, 0.004],
                [MAINNET_CONFIG.quoteTokens.USDC, 1],
              ]),
            isPriceStale: () => false,
          },
        },
        MAINNET_CONFIG,
      );

      await expect(oracle.getPrices("USDC")).resolves.toBeNull();
    });
  });

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
