import { describe, expect, it, vi } from "vitest";
import { parseEther, type Address, type Hex } from "viem";
import { createFlashArbStrategy } from "../../src/strategies/flash-arb.js";
import type { MevSubmitter } from "../../src/execution/mev-submitter.js";
import { BASE_CONFIG } from "../../src/chains/index.js";
import type { AuctionContext } from "../../src/strategies/interface.js";

const WALLET_ADDRESS = "0x3333333333333333333333333333333333333333";
const EXECUTOR_V3V3 = "0x4444444444444444444444444444444444444444";
const EXECUTOR_V2V3 = "0x5555555555555555555555555555555555555555";
const EXECUTOR_V3V2 = "0x6666666666666666666666666666666666666666";
const V3_FLASH_POOL_ADDRESS = "0x7777777777777777777777777777777777777777";
const V2_FLASH_PAIR_ADDRESS = "0x8888888888888888888888888888888888888888";
const V2_SWAP_PAIR_ADDRESS = "0x9999999999999999999999999999999999999999";
const V2_FACTORY_ADDRESS = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const QUOTER_ADDRESS = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const QUOTE_TOKEN_ADDRESS = "0x2222222222222222222222222222222222222222";
const FLASH_POOL_FEE = 3000;
const DISJOINT_SWAP_FEE = 500;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const V2_PATH = [QUOTE_TOKEN_ADDRESS, BASE_CONFIG.ajnaToken] as const;

function encodeUniswapV3Path(tokenIn: string, fee: number, tokenOut: string): Hex {
  return `0x${tokenIn.slice(2)}${fee.toString(16).padStart(6, "0")}${tokenOut.slice(2)}` as Hex;
}

const V3_PATH = encodeUniswapV3Path(
  QUOTE_TOKEN_ADDRESS,
  DISJOINT_SWAP_FEE,
  BASE_CONFIG.ajnaToken,
);
const REUSED_V3_PATH = encodeUniswapV3Path(
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

function makeRoute(overrides?: Record<string, unknown>) {
  return {
    quoterAddress: QUOTER_ADDRESS,
    uniswapV2FactoryAddress: V2_FACTORY_ADDRESS,
    executors: {
      v3v3: EXECUTOR_V3V3,
      v2v3: EXECUTOR_V2V3,
      v3v2: EXECUTOR_V3V2,
    },
    sources: {
      USDC: [
        {
          protocol: "uniswap-v3",
          address: V3_FLASH_POOL_ADDRESS,
        },
      ],
    },
    swapRoutes: {
      USDC: [
        {
          protocol: "uniswap-v3",
          path: V3_PATH,
        },
      ],
    },
    ...overrides,
  };
}

function makeStrategy({
  dryRun = true,
  route = makeRoute(),
  v3QuotedAmountOut = parseEther("130"),
  reusedPathAmountOut = parseEther("130"),
  v3FlashPoolLiquidity = 1n,
  v3FlashPoolAjnaBalance = parseEther("500"),
  v2FlashPairReserves = [25_000_000n, parseEther("500")] as const,
  v2SwapPairReserves = [100_000_000n, parseEther("500000")] as const,
} = {}) {
  const readContract = vi.fn(async (
    {
      address,
      functionName,
      args,
    }: { address: Address; functionName: string; args?: readonly unknown[] },
  ) => {
    if (address === V3_FLASH_POOL_ADDRESS && functionName === "token0") return QUOTE_TOKEN_ADDRESS;
    if (address === V3_FLASH_POOL_ADDRESS && functionName === "token1") return BASE_CONFIG.ajnaToken;
    if (address === V3_FLASH_POOL_ADDRESS && functionName === "fee") return BigInt(FLASH_POOL_FEE);
    if (address === V3_FLASH_POOL_ADDRESS && functionName === "liquidity") return v3FlashPoolLiquidity;

    if (address === V2_FLASH_PAIR_ADDRESS && functionName === "token0") return QUOTE_TOKEN_ADDRESS;
    if (address === V2_FLASH_PAIR_ADDRESS && functionName === "token1") return BASE_CONFIG.ajnaToken;
    if (address === V2_FLASH_PAIR_ADDRESS && functionName === "getReserves") {
      return [v2FlashPairReserves[0], v2FlashPairReserves[1], 0];
    }

    if (address === V2_SWAP_PAIR_ADDRESS && functionName === "token0") return QUOTE_TOKEN_ADDRESS;
    if (address === V2_SWAP_PAIR_ADDRESS && functionName === "token1") return BASE_CONFIG.ajnaToken;
    if (address === V2_SWAP_PAIR_ADDRESS && functionName === "getReserves") {
      return [v2SwapPairReserves[0], v2SwapPairReserves[1], 0];
    }

    if (address === V2_FACTORY_ADDRESS && functionName === "getPair") {
      const tokenA = args?.[0] as Address | undefined;
      const tokenB = args?.[1] as Address | undefined;
      const isUsdcAjnaPair =
        [tokenA?.toLowerCase(), tokenB?.toLowerCase()].sort().join(":") ===
        [QUOTE_TOKEN_ADDRESS.toLowerCase(), BASE_CONFIG.ajnaToken.toLowerCase()].sort().join(":");
      return isUsdcAjnaPair ? V2_SWAP_PAIR_ADDRESS : ZERO_ADDRESS;
    }

    if (address === QUOTER_ADDRESS && functionName === "quoteExactInput") {
      const path = args?.[0] as Hex;
      const amountOut = path === REUSED_V3_PATH ? reusedPathAmountOut : v3QuotedAmountOut;
      return [amountOut, [], [], 100000n];
    }

    if (
      address === BASE_CONFIG.ajnaToken &&
      functionName === "balanceOf" &&
      args?.[0] === V3_FLASH_POOL_ADDRESS
    ) {
      return v3FlashPoolAjnaBalance;
    }

    if (
      address === BASE_CONFIG.ajnaToken &&
      functionName === "balanceOf" &&
      args?.[0] === WALLET_ADDRESS
    ) {
      return parseEther("5");
    }

    if (
      address === QUOTE_TOKEN_ADDRESS &&
      functionName === "balanceOf" &&
      args?.[0] === WALLET_ADDRESS
    ) {
      return 0n;
    }

    throw new Error(`Unexpected readContract call ${address}.${functionName}`);
  });

  const publicClient = {
    chain: BASE_CONFIG.chain,
    readContract,
    getBalance: vi.fn().mockResolvedValue(parseEther("1")),
    simulateContract: vi.fn().mockResolvedValue({}),
    waitForTransactionReceipt: vi.fn().mockResolvedValue({
      status: "success",
      blockNumber: 55n,
      gasUsed: 40_000n,
      effectiveGasPrice: 1_250_000_000n,
    }),
  };
  const walletClient = {
    account: { address: WALLET_ADDRESS },
  };
  const submitter = makeSubmitter();

  const strategy = createFlashArbStrategy(
    publicClient as never,
    walletClient as never,
    submitter,
    {
      maxSlippagePercent: 1,
      minLiquidityUsd: 10,
      minProfitUsd: 0.1,
      ajnaToken: BASE_CONFIG.ajnaToken,
      nativeTokenPriceUsd: BASE_CONFIG.nativeTokenPriceUsd,
      dryRun,
      route: route as never,
    },
  );

  return { strategy, publicClient, submitter };
}

describe("flash-arb strategy", () => {
  it("estimates total profit after repayment and slippage floor for v3v3", async () => {
    const { strategy } = makeStrategy();

    await expect(strategy.estimateProfit(makeContext())).resolves.toBeCloseTo(15.71, 2);
  });

  it("reports executability when the v3v3 route is configured and profitable", async () => {
    const { strategy, publicClient } = makeStrategy();

    await expect(strategy.canExecute(makeContext())).resolves.toBe(true);
    expect(publicClient.readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: QUOTER_ADDRESS,
        functionName: "quoteExactInput",
      }),
    );
  });

  it("rejects candidates when the swap path reuses the configured v3 flash source", async () => {
    const { strategy, publicClient } = makeStrategy({
      route: makeRoute({
        swapRoutes: {
          USDC: [
            {
              protocol: "uniswap-v3",
              path: REUSED_V3_PATH,
            },
          ],
        },
      }),
    });

    await expect(strategy.canExecute(makeContext())).resolves.toBe(false);
    expect(publicClient.readContract).not.toHaveBeenCalledWith(
      expect.objectContaining({
        address: QUOTER_ADDRESS,
        functionName: "quoteExactInput",
      }),
    );
  });

  it("rejects candidates when the configured v3 flash source has zero liquidity", async () => {
    const { strategy, publicClient } = makeStrategy({ v3FlashPoolLiquidity: 0n });

    await expect(strategy.canExecute(makeContext())).resolves.toBe(false);
    expect(publicClient.readContract).not.toHaveBeenCalledWith(
      expect.objectContaining({
        address: QUOTER_ADDRESS,
        functionName: "quoteExactInput",
      }),
    );
  });

  it("rejects candidates when the v3 flash source cannot cover the required AJNA borrow", async () => {
    const { strategy } = makeStrategy({ v3FlashPoolAjnaBalance: parseEther("40") });

    await expect(strategy.canExecute(makeContext())).resolves.toBe(false);
  });

  it("simulates v3v3 executor execution during dry runs", async () => {
    const { strategy, publicClient } = makeStrategy();
    const ctx = makeContext();

    const result = await strategy.execute(ctx);

    expect(publicClient.simulateContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: EXECUTOR_V3V3,
        functionName: "executeFlashArb",
        account: WALLET_ADDRESS,
        args: [
          expect.objectContaining({
            flashPool: V3_FLASH_POOL_ADDRESS,
            ajnaPool: ctx.poolState.pool,
            quoteAmount: parseEther("25"),
            borrowAmount: parseEther("50"),
            swapPath: V3_PATH,
            profitRecipient: WALLET_ADDRESS,
          }),
        ],
      }),
    );
    expect(result.submissionMode).toBe("dry-run");
    expect(result.profitUsd).toBeGreaterThan(10);
  });

  it("submits v3v3 executor transactions through the mev submitter in live mode", async () => {
    const { strategy, submitter, publicClient } = makeStrategy({ dryRun: false });
    vi.mocked(publicClient.getBalance)
      .mockResolvedValueOnce(parseEther("1"))
      .mockResolvedValueOnce(parseEther("0.99995"));
    let walletAjnaReadCount = 0;
    vi.mocked(publicClient.readContract).mockImplementation(async (
      {
        address,
        functionName,
        args,
      }: { address: Address; functionName: string; args?: readonly unknown[] },
    ) => {
      if (address === V3_FLASH_POOL_ADDRESS && functionName === "token0") return QUOTE_TOKEN_ADDRESS;
      if (address === V3_FLASH_POOL_ADDRESS && functionName === "token1") return BASE_CONFIG.ajnaToken;
      if (address === V3_FLASH_POOL_ADDRESS && functionName === "fee") return BigInt(FLASH_POOL_FEE);
      if (address === V3_FLASH_POOL_ADDRESS && functionName === "liquidity") return 1n;
      if (address === QUOTER_ADDRESS && functionName === "quoteExactInput") {
        return [parseEther("130"), [], [], 100000n];
      }
      if (
        address === BASE_CONFIG.ajnaToken &&
        functionName === "balanceOf" &&
        args?.[0] === V3_FLASH_POOL_ADDRESS
      ) {
        return parseEther("500");
      }
      if (
        address === BASE_CONFIG.ajnaToken &&
        functionName === "balanceOf" &&
        args?.[0] === WALLET_ADDRESS
      ) {
        walletAjnaReadCount += 1;
        return walletAjnaReadCount === 1 ? parseEther("5") : parseEther("8");
      }
      if (
        address === QUOTE_TOKEN_ADDRESS &&
        functionName === "balanceOf" &&
        args?.[0] === WALLET_ADDRESS
      ) {
        return 0n;
      }
      throw new Error(`Unexpected readContract call ${address}.${functionName}`);
    });
    const ctx = makeContext();

    const result = await strategy.execute(ctx);

    expect(submitter.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        to: EXECUTOR_V3V3,
        functionName: "executeFlashArb",
        account: WALLET_ADDRESS,
      }),
    );
    expect(result.submissionMode).toBe("private-rpc");
    expect(result.privateSubmission).toBe(true);
    expect(result.realized?.profitUsd).toBeCloseTo(0.5, 6);
  });

  it("executes a v2v3 candidate when the flash source is a v2 pair", async () => {
    const route = makeRoute({
      sources: {
        USDC: [
          {
            protocol: "uniswap-v2",
            address: V2_FLASH_PAIR_ADDRESS,
          },
        ],
      },
      swapRoutes: {
        USDC: [
          {
            protocol: "uniswap-v3",
            path: V3_PATH,
          },
        ],
      },
    });
    const { strategy, publicClient } = makeStrategy({ route });
    const ctx = makeContext();

    await expect(strategy.canExecute(ctx)).resolves.toBe(true);
    await strategy.execute(ctx);

    expect(publicClient.simulateContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: EXECUTOR_V2V3,
        args: [
          expect.objectContaining({
            flashPair: V2_FLASH_PAIR_ADDRESS,
            swapPath: V3_PATH,
          }),
        ],
      }),
    );
  });

  it("selects the more profitable v3v2 route over v3v3 when both are available", async () => {
    const route = makeRoute({
      swapRoutes: {
        USDC: [
          {
            protocol: "uniswap-v3",
            path: V3_PATH,
          },
          {
            protocol: "uniswap-v2",
            path: [...V2_PATH],
          },
        ],
      },
    });
    const { strategy, publicClient } = makeStrategy({
      route,
      v3QuotedAmountOut: parseEther("115"),
    });
    const ctx = makeContext();

    await expect(strategy.canExecute(ctx)).resolves.toBe(true);
    await strategy.execute(ctx);

    expect(publicClient.simulateContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: EXECUTOR_V3V2,
        args: [
          expect.objectContaining({
            flashPool: V3_FLASH_POOL_ADDRESS,
            swapPath: [...V2_PATH],
          }),
        ],
      }),
    );
  });

  it("estimateKickProfit returns the best mixed-family profit estimate when the route remains viable", async () => {
    const route = makeRoute({
      sources: {
        USDC: [
          {
            protocol: "uniswap-v3",
            address: V3_FLASH_POOL_ADDRESS,
          },
          {
            protocol: "uniswap-v2",
            address: V2_FLASH_PAIR_ADDRESS,
          },
        ],
      },
      swapRoutes: {
        USDC: [
          {
            protocol: "uniswap-v3",
            path: V3_PATH,
          },
          {
            protocol: "uniswap-v2",
            path: [...V2_PATH],
          },
        ],
      },
    });
    const { strategy } = makeStrategy({ route });

    await expect(strategy.estimateKickProfit({
      poolState: makeContext().poolState,
      prices: makeContext().prices,
      chainName: "base",
    })).resolves.toBeGreaterThan(10);
  });

  it("estimateKickProfit returns zero when no minimum net profit is configured", async () => {
    const route = makeRoute();
    const { strategy } = createStrategyWithProfitFloor(route, 0);

    await expect(strategy.estimateKickProfit({
      poolState: makeContext().poolState,
      prices: makeContext().prices,
      chainName: "base",
    })).resolves.toBe(0);
  });
});

function createStrategyWithProfitFloor(route: ReturnType<typeof makeRoute>, minProfitUsd: number) {
  const publicClient = {
    chain: BASE_CONFIG.chain,
    readContract: vi.fn(async ({ address, functionName, args }: {
      address: Address;
      functionName: string;
      args?: readonly unknown[];
    }) => {
      if (address === V3_FLASH_POOL_ADDRESS && functionName === "token0") return QUOTE_TOKEN_ADDRESS;
      if (address === V3_FLASH_POOL_ADDRESS && functionName === "token1") return BASE_CONFIG.ajnaToken;
      if (address === V3_FLASH_POOL_ADDRESS && functionName === "fee") return BigInt(FLASH_POOL_FEE);
      if (address === V3_FLASH_POOL_ADDRESS && functionName === "liquidity") return 1n;
      if (address === QUOTER_ADDRESS && functionName === "quoteExactInput") {
        return [parseEther("130"), [], [], 100000n];
      }
      if (
        address === BASE_CONFIG.ajnaToken &&
        functionName === "balanceOf" &&
        args?.[0] === V3_FLASH_POOL_ADDRESS
      ) {
        return parseEther("500");
      }
      throw new Error(`Unexpected readContract call ${address}.${functionName}`);
    }),
    getBalance: vi.fn(),
    simulateContract: vi.fn(),
    waitForTransactionReceipt: vi.fn(),
  };

  const strategy = createFlashArbStrategy(
    publicClient as never,
    { account: { address: WALLET_ADDRESS } } as never,
    makeSubmitter(),
    {
      maxSlippagePercent: 1,
      minLiquidityUsd: 10,
      minProfitUsd,
      ajnaToken: BASE_CONFIG.ajnaToken,
      nativeTokenPriceUsd: BASE_CONFIG.nativeTokenPriceUsd,
      dryRun: true,
      route: route as never,
    },
  );

  return { strategy, publicClient };
}
