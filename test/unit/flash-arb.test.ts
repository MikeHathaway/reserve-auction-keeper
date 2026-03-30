import { describe, expect, it, vi } from "vitest";
import { parseEther } from "viem";
import { createFlashArbStrategy } from "../../src/strategies/flash-arb.js";
import type { MevSubmitter } from "../../src/execution/mev-submitter.js";
import { BASE_CONFIG } from "../../src/chains/index.js";

const WALLET_ADDRESS = "0x3333333333333333333333333333333333333333";
const EXECUTOR_ADDRESS = "0x4444444444444444444444444444444444444444";
const FLASH_POOL_ADDRESS = "0x5555555555555555555555555555555555555555";
const PATH = "0x01020304";

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
} = {}) {
  const publicClient = {
    chain: BASE_CONFIG.chain,
    readContract: vi.fn().mockResolvedValue(3000n),
    simulateContract: vi.fn().mockResolvedValue({}),
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
      executorAddress: EXECUTOR_ADDRESS,
      dryRun,
      route: {
        flashLoanPools: {
          USDC: FLASH_POOL_ADDRESS,
        },
        quoteToAjnaPaths: {
          USDC: PATH,
        },
      },
      dexQuoter: {
        quoteQuoteToAjna: async () => ({
          amountOut,
          gasEstimate: 100000n,
          idealAmountOut: 62,
          actualAmountOut: Number(amountOut) / 1e18,
          slippagePercent,
        }),
      },
    },
  );

  return { strategy, publicClient, submitter };
}

describe("flash-arb strategy", () => {
  it("estimates total profit after flash fee and slippage floor", async () => {
    const { strategy } = makeStrategy();

    await expect(strategy.estimateProfit(ctx)).resolves.toBeCloseTo(1.85, 6);
  });

  it("reports executability when the route is configured and profitable", async () => {
    const { strategy } = makeStrategy();

    await expect(strategy.canExecute(ctx)).resolves.toBe(true);
  });

  it("rejects candidates when quoted slippage exceeds the configured limit", async () => {
    const { strategy } = makeStrategy({ slippagePercent: 20 });

    await expect(strategy.canExecute(ctx)).resolves.toBe(false);
  });

  it("simulates executor execution during dry runs", async () => {
    const { strategy, publicClient } = makeStrategy();

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
    const { strategy, submitter } = makeStrategy({ dryRun: false });

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
  });
});
