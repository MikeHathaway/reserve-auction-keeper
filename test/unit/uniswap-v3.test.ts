import { describe, expect, it, vi } from "vitest";
import { parseEther } from "viem";
import { createUniswapV3DexQuoter } from "../../src/pricing/uniswap-v3.js";

describe("uniswap v3 dex quoter", () => {
  it("quotes quote-token to AJNA output and computes oracle divergence", async () => {
    const publicClient = {
      readContract: vi.fn().mockResolvedValue([
        parseEther("12"),
        [],
        [],
        150000n,
      ]),
    };

    const quoter = createUniswapV3DexQuoter(publicClient as never, {
      quoterAddress: "0x1111111111111111111111111111111111111111",
      quoteToAjnaPaths: {
        USDC: "0x010203",
      },
      label: "base.flashArb",
    });

    const result = await quoter.quoteQuoteToAjna("USDC", parseEther("25"), 1_000_000_000_000n, {
      ajnaPriceUsd: 0.2,
      quoteTokenPriceUsd: 0.1,
      source: "coingecko",
      isStale: false,
    });

    expect(result).toMatchObject({
      amountOut: parseEther("12"),
      gasEstimate: 150000n,
      idealAmountOut: 12.5,
      actualAmountOut: 12,
    });
    expect(publicClient.readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ["0x010203", 25_000_000n],
      }),
    );
    expect(result?.oracleDivergencePercent).toBeCloseTo(4, 6);
  });

  it("converts Ajna internal quote amounts to raw token units before quoting", async () => {
    const publicClient = {
      readContract: vi.fn().mockResolvedValue([
        parseEther("12"),
        [],
        [],
        150000n,
      ]),
    };

    const quoter = createUniswapV3DexQuoter(publicClient as never, {
      quoterAddress: "0x1111111111111111111111111111111111111111",
      quoteToAjnaPaths: {
        USDC: "0x010203",
      },
      label: "base.flashArb",
    });

    await quoter.quoteQuoteToAjna("USDC", parseEther("25"), 1_000_000_000_000n, {
      ajnaPriceUsd: 0.2,
      quoteTokenPriceUsd: 0.1,
      source: "coingecko",
      isStale: false,
    });

    expect(publicClient.readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ["0x010203", 25_000_000n],
      }),
    );
  });

  it("returns null when no route is configured for the quote token", async () => {
    const publicClient = {
      readContract: vi.fn(),
    };

    const quoter = createUniswapV3DexQuoter(publicClient as never, {
      quoterAddress: "0x1111111111111111111111111111111111111111",
      quoteToAjnaPaths: {},
      label: "base.flashArb",
    });

    await expect(
      quoter.quoteQuoteToAjna("DAI", parseEther("1"), 1n, {
        ajnaPriceUsd: 0.2,
        quoteTokenPriceUsd: 1,
        source: "coingecko",
        isStale: false,
      }),
    ).resolves.toBeNull();
    expect(publicClient.readContract).not.toHaveBeenCalled();
  });
});
