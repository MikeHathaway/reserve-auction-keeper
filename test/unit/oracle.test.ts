import { describe, it, expect, vi } from "vitest";
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

    it("returns conservative hybrid prices when feeds agree", async () => {
      const oracle = createPriceOracle(
        {
          provider: "hybrid",
          coingecko: {
            getPrice: async (tokenId: string) => tokenId === "ajna-protocol" ? 0.003 : 1.01,
            getPrices: async (tokenIds: string[]) =>
              new Map(tokenIds.map((tokenId) => [tokenId, tokenId === "ajna-protocol" ? 0.003 : 1.01])),
            isPriceStale: () => false,
          },
          alchemy: {
            getPrices: async () =>
              new Map([
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
        source: "hybrid",
        isStale: false,
      });
    });

    it("returns null when hybrid quote feeds diverge beyond threshold", async () => {
      const oracle = createPriceOracle(
        {
          provider: "hybrid",
          coingecko: {
            getPrice: async (tokenId: string) => tokenId === "ajna-protocol" ? 0.003 : 1,
            getPrices: async (tokenIds: string[]) =>
              new Map(tokenIds.map((tokenId) => [tokenId, tokenId === "ajna-protocol" ? 0.003 : 1])),
            isPriceStale: () => false,
          },
          alchemy: {
            getPrices: async () =>
              new Map([
                [MAINNET_CONFIG.quoteTokens.USDC, 1.2],
              ]),
            isPriceStale: () => false,
          },
        },
        MAINNET_CONFIG,
      );

      await expect(oracle.getPrices("USDC")).resolves.toBeNull();
    });

    it("falls back to CoinGecko quote price when Alchemy quote price is unavailable", async () => {
      const oracle = createPriceOracle(
        {
          provider: "hybrid",
          coingecko: {
            getPrice: async (tokenId: string) => tokenId === "ajna-protocol" ? 0.003 : 1,
            getPrices: async (tokenIds: string[]) =>
              new Map(tokenIds.map((tokenId) => [tokenId, tokenId === "ajna-protocol" ? 0.003 : 1])),
            isPriceStale: () => false,
          },
          alchemy: {
            getPrices: async () => new Map(),
            isPriceStale: () => false,
          },
        },
        MAINNET_CONFIG,
      );

      await expect(oracle.getPrices("USDC")).resolves.toEqual({
        ajnaPriceUsd: 0.003,
        quoteTokenPriceUsd: 1,
        source: "hybrid",
        isStale: false,
      });
    });

    it("falls back to Alchemy quote price when CoinGecko quote price is unavailable", async () => {
      const oracle = createPriceOracle(
        {
          provider: "hybrid",
          coingecko: {
            getPrice: async (tokenId: string) => tokenId === "ajna-protocol" ? 0.003 : null,
            getPrices: async () =>
              new Map([
                ["ajna-protocol", 0.003],
              ]),
            isPriceStale: () => false,
          },
          alchemy: {
            getPrices: async () =>
              new Map([
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
        source: "hybrid",
        isStale: false,
      });
    });

    it("returns null when CoinGecko AJNA price is unavailable in hybrid mode", async () => {
      const oracle = createPriceOracle(
        {
          provider: "hybrid",
          coingecko: {
            getPrice: async () => null,
            getPrices: async () => new Map(),
            isPriceStale: () => true,
          },
          alchemy: {
            getPrices: async () =>
              new Map([
                [MAINNET_CONFIG.quoteTokens.USDC, 1],
              ]),
            isPriceStale: () => false,
          },
        },
        MAINNET_CONFIG,
      );

      await expect(oracle.getPrices("USDC")).resolves.toBeNull();
    });

    it("batches source fetches across multiple quote tokens", async () => {
      const coingeckoGetPrices = vi.fn(async () =>
        new Map([
          ["ajna-protocol", 0.003],
          ["usd-coin", 1],
          ["weth", 2500],
        ]));
      const alchemyGetPrices = vi.fn(async () =>
        new Map([
          [MAINNET_CONFIG.quoteTokens.USDC, 1],
          [MAINNET_CONFIG.quoteTokens.WETH, 2495],
        ]));
      const oracle = createPriceOracle(
        {
          provider: "hybrid",
          coingecko: {
            getPrice: async () => null,
            getPrices: coingeckoGetPrices,
            isPriceStale: () => false,
          },
          alchemy: {
            getPrices: alchemyGetPrices,
            isPriceStale: () => false,
          },
        },
        MAINNET_CONFIG,
      );

      const pricesByToken = await oracle.getPricesForQuoteTokens(["USDC", "WETH"]);

      expect(coingeckoGetPrices).toHaveBeenCalledTimes(1);
      expect(alchemyGetPrices).toHaveBeenCalledTimes(1);
      expect(alchemyGetPrices).toHaveBeenCalledWith(
        MAINNET_CONFIG.alchemySlug,
        [MAINNET_CONFIG.quoteTokens.USDC, MAINNET_CONFIG.quoteTokens.WETH],
      );
      expect(pricesByToken.get("USDC")).toEqual({
        ajnaPriceUsd: 0.003,
        quoteTokenPriceUsd: 1,
        source: "hybrid",
        isStale: false,
      });
      expect(pricesByToken.get("WETH")).toEqual({
        ajnaPriceUsd: 0.003,
        quoteTokenPriceUsd: 2495,
        source: "hybrid",
        isStale: false,
      });
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
