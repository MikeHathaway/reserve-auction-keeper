import { describe, expect, it, vi } from "vitest";
import { parseEther, type Hex } from "viem";
import { createFlashArbStrategy } from "../../src/strategies/flash-arb.js";
import type { MevSubmitter } from "../../src/execution/mev-submitter.js";
import { BASE_CONFIG } from "../../src/chains/index.js";
import type { AuctionContext } from "../../src/strategies/interface.js";

const WALLET_ADDRESS = "0x3333333333333333333333333333333333333333";
const EXECUTOR_ADDRESS = "0x4444444444444444444444444444444444444444";
const FLASH_POOL_ADDRESS = "0x5555555555555555555555555555555555555555";
const QUOTE_TOKEN_ADDRESS = "0x2222222222222222222222222222222222222222";
const FLASH_POOL_FEE = 3000;
const DISJOINT_SWAP_FEE = 500;

function encodeUniswapV3Path(tokenIn: string, fee: number, tokenOut: string): Hex {
  return `0x${tokenIn.slice(2)}${fee.toString(16).padStart(6, "0")}${tokenOut.slice(2)}` as Hex;
}

const PATH = encodeUniswapV3Path(QUOTE_TOKEN_ADDRESS, DISJOINT_SWAP_FEE, BASE_CONFIG.ajnaToken);
const REUSED_FLASH_POOL_PATH = encodeUniswapV3Path(
  QUOTE_TOKEN_ADDRESS,
  FLASH_POOL_FEE,
  BASE_CONFIG.ajnaToken,
);

function makeContext(overrides: Partial<AuctionContext> = {}): AuctionContext {
  return {
      poolState: {
        pool: "0x1111111111111111111111111111111111111111",
        quoteToken: QUOTE_TOKEN_ADDRESS,
      quoteTokenScale: 1_000_000_000_000n,
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
    ...overrides,
  };
}

function makeSubmitter(): MevSubmitter {
  return {
    name: "private-rpc",
    supportsLiveSubmission: true,
    submit: vi.fn().mockResolvedValue({
      mode: "private-rpc",
      txHash: `0x${"ab".repeat(32)}`,
      privateSubmission: true,
    }),
    isHealthy: vi.fn().mockResolvedValue(true),
  };
}

function makeStrategy({
  dryRun = true,
  amountOut = parseEther("60"),
  slippagePercent = 0.5,
  minLiquidityUsd = 10,
  minProfitUsd = 0.1,
  swapPath = PATH,
} = {}) {
  const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
    if (functionName === "token0") return QUOTE_TOKEN_ADDRESS;
    if (functionName === "token1") return BASE_CONFIG.ajnaToken;
    if (functionName === "fee") return BigInt(FLASH_POOL_FEE);
    throw new Error(`Unexpected readContract function ${functionName}`);
  });
  const publicClient = {
    chain: BASE_CONFIG.chain,
    readContract,
    getBalance: vi.fn(),
    simulateContract: vi.fn().mockResolvedValue({}),
    waitForTransactionReceipt: vi.fn(),
  };
  const walletClient = {
    account: { address: WALLET_ADDRESS },
  };
  const submitter = makeSubmitter();
  const dexQuoter = {
    quoteQuoteToAjna: vi.fn(async (_symbol: string, _amountInWad: bigint, _quoteTokenScale: bigint) => ({
      amountOut,
      gasEstimate: 100000n,
      idealAmountOut: 62,
      actualAmountOut: Number(amountOut) / 1e18,
      slippagePercent,
    })),
  };

  const strategy = createFlashArbStrategy(
    publicClient as never,
    walletClient as never,
    submitter,
    {
      maxSlippagePercent: 1,
      minLiquidityUsd,
      minProfitUsd,
      ajnaToken: BASE_CONFIG.ajnaToken,
      nativeTokenPriceUsd: BASE_CONFIG.nativeTokenPriceUsd,
      executorAddress: EXECUTOR_ADDRESS,
      dryRun,
      route: {
        flashLoanPools: {
          USDC: FLASH_POOL_ADDRESS,
        },
        quoteToAjnaPaths: {
          USDC: swapPath,
        },
      },
      dexQuoter,
    },
  );

  return { strategy, publicClient, submitter, dexQuoter };
}

describe("flash-arb strategy", () => {
  it("estimates total profit after flash fee and slippage floor", async () => {
    const { strategy } = makeStrategy();

    await expect(strategy.estimateProfit(makeContext())).resolves.toBeCloseTo(1.85, 6);
  });

  it("reports executability when the route is configured and profitable", async () => {
    const { strategy, dexQuoter } = makeStrategy();

    await expect(strategy.canExecute(makeContext())).resolves.toBe(true);
    expect(dexQuoter.quoteQuoteToAjna).toHaveBeenCalledWith(
      "USDC",
      parseEther("25"),
      1_000_000_000_000n,
      expect.any(Object),
    );
  });

  it("rejects candidates when quoted slippage exceeds the configured limit", async () => {
    const { strategy } = makeStrategy({ slippagePercent: 20 });

    await expect(strategy.canExecute(makeContext())).resolves.toBe(false);
  });

  it("rejects candidates when the swap path reuses the configured flash-loan pool", async () => {
    const { strategy, dexQuoter } = makeStrategy({ swapPath: REUSED_FLASH_POOL_PATH });

    await expect(strategy.canExecute(makeContext())).resolves.toBe(false);
    expect(dexQuoter.quoteQuoteToAjna).not.toHaveBeenCalled();
  });

  it("simulates executor execution during dry runs", async () => {
    const { strategy, publicClient } = makeStrategy();
    const ctx = makeContext();

    const result = await strategy.execute(ctx);

    expect(publicClient.simulateContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: EXECUTOR_ADDRESS,
        functionName: "executeFlashArb",
        account: WALLET_ADDRESS,
        args: [
          expect.objectContaining({
            flashPool: FLASH_POOL_ADDRESS,
            ajnaPool: ctx.poolState.pool,
            quoteAmount: parseEther("25"),
            borrowAmount: parseEther("50"),
            swapPath: PATH,
            profitRecipient: WALLET_ADDRESS,
          }),
        ],
      }),
    );
    expect(result.submissionMode).toBe("dry-run");
    expect(result.profitUsd).toBeCloseTo(1.85, 6);
  });

  it("submits executor transactions through the mev submitter in live mode", async () => {
    const { strategy, submitter, publicClient } = makeStrategy({ dryRun: false });
    vi.mocked(publicClient.getBalance)
      .mockResolvedValueOnce(parseEther("1"))
      .mockResolvedValueOnce(parseEther("0.99995"));
    let balanceReadCount = 0;
    vi.mocked(publicClient.readContract).mockImplementation(async ({ functionName }: { functionName: string }) => {
      if (functionName === "token0") return QUOTE_TOKEN_ADDRESS;
      if (functionName === "token1") return BASE_CONFIG.ajnaToken;
      if (functionName === "fee") return BigInt(FLASH_POOL_FEE);
      if (functionName === "balanceOf") {
        balanceReadCount += 1;
        if (balanceReadCount === 1) return parseEther("5");
        if (balanceReadCount === 2) return 0n;
        if (balanceReadCount === 3) return parseEther("8");
        if (balanceReadCount === 4) return 0n;
      }
      throw new Error(`Unexpected live readContract function ${functionName}`);
    });
    vi.mocked(publicClient.waitForTransactionReceipt).mockResolvedValue({
      status: "success",
      blockNumber: 55n,
      gasUsed: 40_000n,
      effectiveGasPrice: 1_250_000_000n,
    });
    const ctx = makeContext();

    const result = await strategy.execute(ctx);

    expect(submitter.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        to: EXECUTOR_ADDRESS,
        functionName: "executeFlashArb",
        account: WALLET_ADDRESS,
      }),
    );
    expect(result.submissionMode).toBe("private-rpc");
    expect(result.privateSubmission).toBe(true);
    expect(result.realized).toMatchObject({
      blockNumber: 55n,
      quoteTokenDelta: 0n,
      ajnaDelta: parseEther("3"),
    });
    expect(result.realized?.profitUsd).toBeCloseTo(0.5, 6);
  });

  it("rounds quote amounts to token scale and rounds borrowed AJNA up", async () => {
    const { strategy, publicClient } = makeStrategy({
      amountOut: 500n,
      slippagePercent: 0,
      minLiquidityUsd: 0,
      minProfitUsd: 0,
    });
    const ctx = makeContext({
      poolState: {
        ...makeContext().poolState,
        quoteTokenScale: 100n,
        claimableReservesRemaining: 123n,
      },
      auctionPrice: parseEther("1") + 1n,
      prices: {
        ajnaPriceUsd: 1,
        quoteTokenPriceUsd: 1,
        source: "coingecko",
        isStale: false,
      },
    });

    const result = await strategy.execute(ctx);
    const simulationCall = vi.mocked(publicClient.simulateContract).mock.calls[0]?.[0];

    expect(simulationCall).toBeDefined();
    expect(simulationCall?.args[0]).toMatchObject({
      quoteAmount: 100n,
      borrowAmount: 101n,
      minAjnaOut: 495n,
    });
    expect(result.amountQuoteReceived).toBe(100n);
    expect(result.ajnaCost).toBe(102n);
  });

  it("estimateKickProfit uses the configured minimum net profit once the route remains viable", async () => {
    const { strategy, dexQuoter } = makeStrategy({
      amountOut: parseEther("130"),
      minProfitUsd: 2,
    });

    await expect(strategy.estimateKickProfit({
      poolState: makeContext().poolState,
      prices: makeContext().prices,
      chainName: "base",
    })).resolves.toBe(2);
    expect(dexQuoter.quoteQuoteToAjna).toHaveBeenCalledWith(
      "USDC",
      parseEther("50"),
      1_000_000_000_000n,
      expect.any(Object),
    );
  });

  it("estimateKickProfit returns zero when no minimum net profit is configured", async () => {
    const { strategy } = makeStrategy({
      amountOut: parseEther("130"),
      minProfitUsd: 0,
    });

    await expect(strategy.estimateKickProfit({
      poolState: makeContext().poolState,
      prices: makeContext().prices,
      chainName: "base",
    })).resolves.toBe(0);
  });

  it("estimateKickProfit returns zero when the quoted route can never cover the profit floor", async () => {
    const { strategy } = makeStrategy({
      amountOut: parseEther("5"),
      minProfitUsd: 2,
    });

    await expect(strategy.estimateKickProfit({
      poolState: makeContext().poolState,
      prices: makeContext().prices,
      chainName: "base",
    })).resolves.toBe(0);
  });
});
