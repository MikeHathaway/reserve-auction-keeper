import { describe, expect, it } from "vitest";
import { parseEther } from "viem";
import { createFlashArbStrategy } from "../../src/strategies/flash-arb.js";

const ctx = {
  poolState: {
    pool: "0x1111111111111111111111111111111111111111",
    quoteToken: "0x2222222222222222222222222222222222222222",
    quoteTokenSymbol: "USDC",
    reserves: parseEther("100"),
    claimableReserves: parseEther("50"),
    claimableReservesRemaining: parseEther("25"),
    auctionPrice: parseEther("2"),
    timeRemaining: 3600n,
    hasActiveAuction: true,
    isKickable: false,
  },
  auctionPrice: parseEther("2"),
  prices: {
    ajnaPriceUsd: 0.2,
    quoteTokenPriceUsd: 1,
    source: "coingecko" as const,
    isStale: false,
  },
  chainName: "base",
};

describe("flash-arb strategy scaffold", () => {
  it("estimates profit using gross spread minus slippage", () => {
    const strategy = createFlashArbStrategy({
      maxSlippagePercent: 1,
      minLiquidityUsd: 100,
      minProfitUsd: 0,
      dryRun: true,
    });

    expect(strategy.estimateProfit(ctx)).toBeCloseTo(0.295, 6);
  });

  it("never reports live executability from the scaffold", async () => {
    const strategy = createFlashArbStrategy({
      maxSlippagePercent: 1,
      minLiquidityUsd: 100,
      minProfitUsd: 0.1,
      dexQuoter: {
        quoteQuoteToAjna: async () => ({
          amountOut: parseEther("13"),
          gasEstimate: 100000n,
          idealAmountOut: 12.5,
          actualAmountOut: 13,
          slippagePercent: 0,
        }),
      },
      dryRun: true,
    });

    await expect(strategy.canExecute(ctx)).resolves.toBe(false);
  });

  it("rejects candidates when quoted slippage exceeds the configured limit", async () => {
    const strategy = createFlashArbStrategy({
      maxSlippagePercent: 1,
      minLiquidityUsd: 10,
      minProfitUsd: 0,
      dexQuoter: {
        quoteQuoteToAjna: async () => ({
          amountOut: parseEther("10"),
          gasEstimate: 100000n,
          idealAmountOut: 12.5,
          actualAmountOut: 10,
          slippagePercent: 20,
        }),
      },
      dryRun: true,
    });

    await expect(strategy.canExecute(ctx)).resolves.toBe(false);
  });

  it("throws a clear error when execute is called", async () => {
    const strategy = createFlashArbStrategy({
      maxSlippagePercent: 1,
      minLiquidityUsd: 100,
      minProfitUsd: 0,
      dryRun: true,
    });

    await expect(strategy.execute(ctx)).rejects.toThrow(
      "Flash-arb execution is not implemented yet",
    );
  });
});
