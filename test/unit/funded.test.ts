import { describe, expect, it, vi } from "vitest";
import { parseEther } from "viem";
import { createFundedStrategy } from "../../src/strategies/funded.js";
import { BASE_CONFIG } from "../../src/chains/index.js";
import type { AuctionContext } from "../../src/strategies/interface.js";
import type { MevSubmitter } from "../../src/execution/mev-submitter.js";

const WALLET_ADDRESS = "0x1111111111111111111111111111111111111111";
const POOL_ADDRESS = "0x2222222222222222222222222222222222222222";
const QUOTE_TOKEN = BASE_CONFIG.quoteTokens.USDC;

function makeContext(overrides: Partial<AuctionContext> = {}): AuctionContext {
  return {
    poolState: {
      pool: POOL_ADDRESS,
      quoteToken: QUOTE_TOKEN,
      quoteTokenSymbol: "USDC",
      reserves: parseEther("100"),
      claimableReserves: parseEther("100"),
      claimableReservesRemaining: parseEther("50"),
      auctionPrice: parseEther("2"),
      timeRemaining: 3600n,
      hasActiveAuction: true,
      isKickable: false,
    },
    auctionPrice: parseEther("2"),
    prices: {
      ajnaPriceUsd: 0.2,
      quoteTokenPriceUsd: 1,
      source: "coingecko",
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
    submit: vi.fn(),
    isHealthy: vi.fn().mockResolvedValue(true),
  };
}

describe("funded strategy", () => {
  it("canExecute returns true when the target exit price is met", async () => {
    const publicClient = {
      chain: BASE_CONFIG.chain,
      readContract: vi.fn().mockResolvedValue(parseEther("100")),
    };
    const walletClient = {
      account: { address: WALLET_ADDRESS },
    };

    const strategy = createFundedStrategy(
      publicClient as never,
      walletClient as never,
      BASE_CONFIG.ajnaToken,
      makeSubmitter(),
      {
        targetExitPriceUsd: 0.1,
        autoApprove: false,
        profitMarginPercent: 5,
        dryRun: true,
      },
    );

    await expect(strategy.canExecute(makeContext())).resolves.toBe(true);
  });

  it("canExecute returns false when the wallet has no AJNA", async () => {
    const publicClient = {
      chain: BASE_CONFIG.chain,
      readContract: vi.fn().mockResolvedValue(0n),
    };
    const walletClient = {
      account: { address: WALLET_ADDRESS },
    };

    const strategy = createFundedStrategy(
      publicClient as never,
      walletClient as never,
      BASE_CONFIG.ajnaToken,
      makeSubmitter(),
      {
        targetExitPriceUsd: 0.1,
        autoApprove: false,
        profitMarginPercent: 5,
        dryRun: true,
      },
    );

    await expect(strategy.canExecute(makeContext())).resolves.toBe(false);
  });

  it("execute uses the configured maxTakeAmount during dry runs", async () => {
    const publicClient = {
      chain: BASE_CONFIG.chain,
      readContract: vi.fn()
        .mockResolvedValueOnce(parseEther("1000"))
        .mockResolvedValueOnce(parseEther("1000")),
      simulateContract: vi.fn().mockResolvedValue({}),
    };
    const walletClient = {
      account: { address: WALLET_ADDRESS },
    };

    const strategy = createFundedStrategy(
      publicClient as never,
      walletClient as never,
      BASE_CONFIG.ajnaToken,
      makeSubmitter(),
      {
        targetExitPriceUsd: 0.1,
        maxTakeAmount: parseEther("30"),
        autoApprove: false,
        profitMarginPercent: 5,
        dryRun: true,
      },
    );

    const result = await strategy.execute(makeContext());

    expect(publicClient.simulateContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: POOL_ADDRESS,
        functionName: "takeReserves",
        args: [parseEther("30")],
        account: WALLET_ADDRESS,
      }),
    );
    expect(result.amountQuoteReceived).toBe(parseEther("30"));
    expect(result.ajnaCost).toBe(parseEther("60"));
  });

  it("execute fails fast when allowance is insufficient and autoApprove is disabled", async () => {
    const publicClient = {
      chain: BASE_CONFIG.chain,
      readContract: vi.fn()
        .mockResolvedValueOnce(parseEther("100"))
        .mockResolvedValueOnce(0n),
      simulateContract: vi.fn(),
    };
    const walletClient = {
      account: { address: WALLET_ADDRESS },
    };

    const strategy = createFundedStrategy(
      publicClient as never,
      walletClient as never,
      BASE_CONFIG.ajnaToken,
      makeSubmitter(),
      {
        targetExitPriceUsd: 0.1,
        autoApprove: false,
        profitMarginPercent: 5,
        dryRun: true,
      },
    );

    await expect(strategy.execute(makeContext())).rejects.toThrow(
      "Insufficient allowance",
    );
    expect(publicClient.simulateContract).not.toHaveBeenCalled();
  });

  it("submits approval through the mev submitter before live execution", async () => {
    const publicClient = {
      chain: BASE_CONFIG.chain,
      readContract: vi.fn()
        .mockResolvedValueOnce(parseEther("100"))
        .mockResolvedValueOnce(0n),
      waitForTransactionReceipt: vi.fn().mockResolvedValue({}),
    };
    const walletClient = {
      account: { address: WALLET_ADDRESS },
    };
    const submitter = makeSubmitter();
    vi.mocked(submitter.submit)
      .mockResolvedValueOnce({
        mode: "private-rpc",
        txHash: "0x" + "aa".repeat(32),
        privateSubmission: true,
      })
      .mockResolvedValueOnce({
        mode: "private-rpc",
        txHash: "0x" + "bb".repeat(32),
        privateSubmission: true,
      });

    const strategy = createFundedStrategy(
      publicClient as never,
      walletClient as never,
      BASE_CONFIG.ajnaToken,
      submitter,
      {
        targetExitPriceUsd: 0.1,
        autoApprove: true,
        profitMarginPercent: 5,
        dryRun: false,
      },
    );

    const result = await strategy.execute(makeContext());

    expect(submitter.submit).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        to: BASE_CONFIG.ajnaToken,
        functionName: "approve",
        args: [POOL_ADDRESS, parseEther("100")],
        account: WALLET_ADDRESS,
      }),
    );
    expect(publicClient.waitForTransactionReceipt).toHaveBeenCalledWith({
      hash: "0x" + "aa".repeat(32),
    });
    expect(submitter.submit).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        to: POOL_ADDRESS,
        functionName: "takeReserves",
        args: [parseEther("50")],
        account: WALLET_ADDRESS,
      }),
    );
    expect(result.txHash).toBe("0x" + "bb".repeat(32));
  });

  it("refuses to auto-approve during dry runs", async () => {
    const publicClient = {
      chain: BASE_CONFIG.chain,
      readContract: vi.fn()
        .mockResolvedValueOnce(parseEther("100"))
        .mockResolvedValueOnce(0n),
      simulateContract: vi.fn(),
    };
    const walletClient = {
      account: { address: WALLET_ADDRESS },
    };
    const submitter = makeSubmitter();

    const strategy = createFundedStrategy(
      publicClient as never,
      walletClient as never,
      BASE_CONFIG.ajnaToken,
      submitter,
      {
        targetExitPriceUsd: 0.1,
        autoApprove: true,
        profitMarginPercent: 5,
        dryRun: true,
      },
    );

    await expect(strategy.execute(makeContext())).rejects.toThrow(
      "Dry run cannot auto-approve",
    );
    expect(submitter.submit).not.toHaveBeenCalled();
    expect(publicClient.simulateContract).not.toHaveBeenCalled();
  });

  it("estimateProfit uses the total quote-token value minus AJNA cost", async () => {
    const publicClient = {
      chain: BASE_CONFIG.chain,
      readContract: vi.fn().mockResolvedValue(parseEther("100")),
    };
    const walletClient = {
      account: { address: WALLET_ADDRESS },
    };

    const strategy = createFundedStrategy(
      publicClient as never,
      walletClient as never,
      BASE_CONFIG.ajnaToken,
      makeSubmitter(),
      {
        targetExitPriceUsd: 0.1,
        autoApprove: false,
        profitMarginPercent: 5,
        dryRun: true,
      },
    );

    await expect(strategy.estimateProfit(makeContext())).resolves.toBe(30);
  });
});
