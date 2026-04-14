import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseEther } from "viem";
import type * as ViemModule from "viem";
import type * as AccountsModule from "viem/accounts";
import type { AppConfig } from "../../src/config.js";

const WALLET_ADDRESS = "0x1111111111111111111111111111111111111111";
const PRIVATE_KEY = `0x${"11".repeat(32)}`;

const {
  mockDiscoverPools,
  mockGetPoolReserveStates,
  mockGetAuctionPrices,
  mockCanKickReserveAuction,
  mockEstimateKickClaimableValueUsd,
  mockKickReserveAuction,
  mockGetPricesForQuoteTokens,
  mockCreatePriceOracle,
  mockCreateCoingeckoClient,
  mockCreateAlchemyPricesClient,
  mockCreateUniswapV3DexQuoter,
  mockCreateFlashbotsSubmitter,
  mockCreatePrivateRpcSubmitter,
  mockFundedStrategy,
  mockCreateFundedStrategy,
  mockCreateFlashArbStrategy,
  mockEvaluateGasCost,
  mockGetNextBlockSafeFeeCapOverrides,
  mockGetNextBlockSafeGasPriceWei,
  mockIsNearProfitableAfterCosts,
  mockIsProfitableAfterCosts,
  mockSumEstimatedCostsUsd,
  mockSetHealthDependency,
  mockClearAllHealthDependencies,
  mockSetHealthy,
  mockLogger,
  mockCreatePublicClient,
  mockCreateWalletClient,
  mockHttp,
  mockPrivateKeyToAccount,
} = vi.hoisted(() => {
  const mockGetPricesForQuoteTokens = vi.fn();

  return {
    mockDiscoverPools: vi.fn(),
    mockGetPoolReserveStates: vi.fn(),
    mockGetAuctionPrices: vi.fn(),
    mockCanKickReserveAuction: vi.fn(),
    mockEstimateKickClaimableValueUsd: vi.fn(),
    mockKickReserveAuction: vi.fn(),
    mockGetPricesForQuoteTokens,
    mockCreatePriceOracle: vi.fn(() => ({
      getPricesForQuoteTokens: mockGetPricesForQuoteTokens,
    })),
    mockCreateCoingeckoClient: vi.fn(),
    mockCreateAlchemyPricesClient: vi.fn(),
    mockCreateUniswapV3DexQuoter: vi.fn(),
    mockCreateFlashbotsSubmitter: vi.fn(() => ({
      name: "flashbots",
      supportsLiveSubmission: true,
      submit: vi.fn(),
      isHealthy: vi.fn().mockResolvedValue(true),
      preflightLiveSubmissionReadiness: vi.fn().mockResolvedValue(true),
    })),
    mockCreatePrivateRpcSubmitter: vi.fn(() => ({
      name: "private-rpc",
      supportsLiveSubmission: true,
      submit: vi.fn(),
      isHealthy: vi.fn().mockResolvedValue(true),
      preflightLiveSubmissionReadiness: vi.fn().mockResolvedValue(true),
    })),
    mockFundedStrategy: {
      name: "funded",
      canExecute: vi.fn(),
      execute: vi.fn(),
      estimateProfit: vi.fn(),
      estimateKickProfit: vi.fn(),
      estimateAdditionalExecutionGasUnits: vi.fn(),
      estimateAdditionalKickExecutionGasUnits: vi.fn(),
    },
    mockCreateFundedStrategy: vi.fn(),
    mockCreateFlashArbStrategy: vi.fn(),
    mockEvaluateGasCost: vi.fn(() => ({
      currentGasPriceGwei: 1,
      isAboveCeiling: false,
      estimatedCostUsd: 0.01,
    })),
    mockGetNextBlockSafeFeeCapOverrides: vi.fn((gasPrice: bigint) => ({
      maxFeePerGas: gasPrice,
      maxPriorityFeePerGas: gasPrice,
    })),
    mockGetNextBlockSafeGasPriceWei: vi.fn((gasPrice: bigint) => gasPrice),
    mockIsNearProfitableAfterCosts: vi.fn(() => false),
    mockIsProfitableAfterCosts: vi.fn(() => false),
    mockSumEstimatedCostsUsd: vi.fn((...costs: number[]) => costs.reduce((sum, cost) => sum + cost, 0)),
    mockSetHealthDependency: vi.fn(),
    mockClearAllHealthDependencies: vi.fn(),
    mockSetHealthy: vi.fn(),
    mockLogger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      alert: vi.fn(),
      debug: vi.fn(),
    },
    mockCreatePublicClient: vi.fn(() => ({
      getGasPrice: vi.fn().mockResolvedValue(1n),
      getBlock: vi.fn().mockResolvedValue({ baseFeePerGas: 1n }),
    })),
    mockCreateWalletClient: vi.fn(() => ({
      account: { address: WALLET_ADDRESS },
    })),
    mockHttp: vi.fn(() => ({})),
    mockPrivateKeyToAccount: vi.fn(() => ({
      address: WALLET_ADDRESS,
    })),
  };
});

mockCreateFundedStrategy.mockImplementation(() => mockFundedStrategy);

vi.mock("viem", async () => {
  const actual = await vi.importActual<typeof ViemModule>("viem");

  return {
    ...actual,
    createPublicClient: mockCreatePublicClient,
    createWalletClient: mockCreateWalletClient,
    http: mockHttp,
  };
});

vi.mock("viem/accounts", async () => {
  const actual = await vi.importActual<typeof AccountsModule>("viem/accounts");

  return {
    ...actual,
    privateKeyToAccount: mockPrivateKeyToAccount,
  };
});

vi.mock("../../src/auction/discovery.js", () => ({
  discoverPools: mockDiscoverPools,
  getPoolReserveStates: mockGetPoolReserveStates,
  canKickReserveAuction: mockCanKickReserveAuction,
}));

vi.mock("../../src/auction/kick.js", () => ({
  estimateKickClaimableValueUsd: mockEstimateKickClaimableValueUsd,
  kickReserveAuction: mockKickReserveAuction,
}));

vi.mock("../../src/auction/auction-price.js", () => ({
  getAuctionPrices: mockGetAuctionPrices,
}));

vi.mock("../../src/pricing/coingecko.js", () => ({
  createCoingeckoClient: mockCreateCoingeckoClient,
}));

vi.mock("../../src/pricing/alchemy.js", () => ({
  createAlchemyPricesClient: mockCreateAlchemyPricesClient,
}));

vi.mock("../../src/pricing/oracle.js", () => ({
  createPriceOracle: mockCreatePriceOracle,
}));

vi.mock("../../src/pricing/uniswap-v3.js", () => ({
  createUniswapV3DexQuoter: mockCreateUniswapV3DexQuoter,
}));

vi.mock("../../src/strategies/funded.js", () => ({
  createFundedStrategy: mockCreateFundedStrategy,
}));

vi.mock("../../src/strategies/flash-arb.js", () => ({
  createFlashArbStrategy: mockCreateFlashArbStrategy,
}));

vi.mock("../../src/execution/flashbots.js", () => ({
  createFlashbotsSubmitter: mockCreateFlashbotsSubmitter,
}));

vi.mock("../../src/execution/private-rpc.js", () => ({
  createPrivateRpcSubmitter: mockCreatePrivateRpcSubmitter,
}));

vi.mock("../../src/execution/gas.js", () => ({
  evaluateGasCost: mockEvaluateGasCost,
  getNextBlockSafeFeeCapOverrides: mockGetNextBlockSafeFeeCapOverrides,
  getNextBlockSafeGasPriceWei: mockGetNextBlockSafeGasPriceWei,
  isNearProfitableAfterCosts: mockIsNearProfitableAfterCosts,
  isProfitableAfterCosts: mockIsProfitableAfterCosts,
  sumEstimatedCostsUsd: mockSumEstimatedCostsUsd,
}));

vi.mock("../../src/utils/logger.js", () => ({
  logger: mockLogger,
  formatErrorForLogs: (error: unknown) => error instanceof Error ? error.message : String(error),
}));

vi.mock("../../src/utils/health.js", () => ({
  setHealthDependency: mockSetHealthDependency,
  clearAllHealthDependencies: mockClearAllHealthDependencies,
  setHealthy: mockSetHealthy,
}));

import { requestShutdown, startKeeper } from "../../src/keeper.js";
import { PendingSubmissionError } from "../../src/execution/receipt.js";

function makeConfig(): AppConfig {
  return {
    chains: [
      {
        chainConfig: {
          name: "base",
          chain: {} as never,
          ajnaToken: "0x2222222222222222222222222222222222222222",
          poolFactory: "0x3333333333333333333333333333333333333333",
          poolInfoUtils: "0x4444444444444444444444444444444444444444",
          quoteTokens: {
            USDC: "0x5555555555555555555555555555555555555555",
          },
          coingeckoIds: {
            ajna: "ajna-protocol",
            quoteTokens: {
              USDC: "usd-coin",
            },
          },
          mevMethod: "private-rpc",
          nativeTokenPriceUsd: 2000,
          estimatedGasCostUsd: 0.02,
          defaultRpcUrl: "http://127.0.0.1:8545",
          alchemySlug: "base-mainnet",
          infuraSlug: undefined,
        },
        rpcUrl: "http://127.0.0.1:8545",
        privateRpcUrl: "http://127.0.0.1:9545",
        privateRpcTrusted: true,
        pools: [],
      },
    ],
    strategy: "funded",
    pricing: {
      provider: "coingecko",
    },
    funded: {
      targetExitPriceUsd: 0.1,
      autoApprove: false,
    },
    flashArb: {
      maxSlippagePercent: 1,
      minLiquidityUsd: 10,
      minProfitUsd: 1,
      routes: {},
    },
    polling: {
      idleIntervalMs: 0,
      activeIntervalMs: 0,
      profitabilityThreshold: 0.1,
    },
    dryRun: true,
    profitMarginPercent: 5,
    gasPriceCeilingGwei: 100,
    healthCheckPort: 3001,
    secrets: {
      privateKey: PRIVATE_KEY,
    },
  };
}

describe("keeper lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockCreatePrivateRpcSubmitter.mockImplementation(() => ({
      name: "private-rpc",
      supportsLiveSubmission: true,
      submit: vi.fn(),
      isHealthy: vi.fn().mockResolvedValue(true),
      preflightLiveSubmissionReadiness: vi.fn().mockResolvedValue(true),
    }));
    mockCreateFlashbotsSubmitter.mockImplementation(() => ({
      name: "flashbots",
      supportsLiveSubmission: true,
      submit: vi.fn(),
      isHealthy: vi.fn().mockResolvedValue(true),
      preflightLiveSubmissionReadiness: vi.fn().mockResolvedValue(true),
    }));

    mockDiscoverPools.mockResolvedValue([]);
    mockGetPoolReserveStates.mockResolvedValue([]);
    mockGetAuctionPrices.mockResolvedValue(new Map());
    mockCanKickReserveAuction.mockResolvedValue(false);
    mockEstimateKickClaimableValueUsd.mockReturnValue(0);
    mockGetPricesForQuoteTokens.mockResolvedValue(new Map());
    mockFundedStrategy.canExecute.mockResolvedValue(false);
    mockFundedStrategy.execute.mockResolvedValue(undefined);
    mockFundedStrategy.estimateProfit.mockResolvedValue(0);
    mockFundedStrategy.estimateKickProfit.mockResolvedValue(0);
    mockFundedStrategy.estimateAdditionalExecutionGasUnits.mockResolvedValue(0n);
    mockFundedStrategy.estimateAdditionalKickExecutionGasUnits.mockResolvedValue(0n);
    mockCreateAlchemyPricesClient.mockReturnValue({
      getPrices: vi.fn().mockResolvedValue(new Map()),
      isPriceStale: vi.fn(() => false),
    });
  });

  it("propagates unexpected chain loop crashes instead of resolving cleanly", async () => {
    mockDiscoverPools.mockRejectedValue(new Error("boom"));

    await expect(startKeeper(makeConfig())).rejects.toThrow("boom");
    expect(mockLogger.alert).toHaveBeenCalledWith(
      "Chain loop crashed",
      expect.objectContaining({
        chain: "base",
        error: "boom",
      }),
    );
  });

  it("propagates per-cycle keeper failures instead of retrying forever", async () => {
    mockGetPoolReserveStates.mockRejectedValue(new Error("cycle boom"));

    await expect(startKeeper(makeConfig())).rejects.toThrow("cycle boom");
    expect(mockLogger.alert).toHaveBeenCalledWith(
      "Chain loop crashed",
      expect.objectContaining({
        chain: "base",
        error: "cycle boom",
      }),
    );
  });

  it("retries transient per-cycle errors without crashing the keeper", async () => {
    mockGetPoolReserveStates
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockImplementationOnce(async () => {
        requestShutdown();
        return [];
      });

    await startKeeper(makeConfig());

    expect(mockLogger.warn).toHaveBeenCalledWith(
      "Transient chain loop error, retrying",
      expect.objectContaining({
        chain: "base",
        consecutiveTransientErrors: 1,
        retryDelayMs: 250,
        error: "fetch failed",
      }),
    );
    expect(mockLogger.alert).not.toHaveBeenCalled();
    expect(mockSetHealthDependency).not.toHaveBeenCalledWith(
      "rpc:base",
      false,
      expect.any(String),
    );
    expect(mockSetHealthDependency).toHaveBeenCalledWith("rpc:base", true);
  });

  it("marks public RPC health unhealthy after repeated transient loop failures and recovers on success", async () => {
    mockGetPoolReserveStates
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockRejectedValueOnce(new Error("fetch failed again"))
      .mockImplementationOnce(async () => {
        requestShutdown();
        return [];
      });

    await startKeeper(makeConfig());

    expect(mockSetHealthDependency).toHaveBeenCalledWith(
      "rpc:base",
      false,
      "public RPC transient failures: 2; last error: fetch failed again",
    );
    expect(mockSetHealthDependency).toHaveBeenCalledWith("rpc:base", true);
    expect(mockLogger.alert).not.toHaveBeenCalled();
  });

  it("accounts for additional strategy execution gas before funded takes", async () => {
    const activePoolState = {
      pool: "0x6666666666666666666666666666666666666666",
      quoteToken: "0x5555555555555555555555555555555555555555",
      quoteTokenScale: 1_000_000_000_000n,
      quoteTokenSymbol: "USDC",
      reserves: 0n,
      claimableReserves: 0n,
      claimableReservesRemaining: parseEther("1"),
      auctionPrice: parseEther("2"),
      timeRemaining: 3600n,
      hasActiveAuction: true,
      isKickable: false,
    };
    mockDiscoverPools.mockResolvedValue([activePoolState.pool]);
    mockGetPoolReserveStates
      .mockResolvedValueOnce([activePoolState])
      .mockImplementationOnce(async () => {
        requestShutdown();
        return [];
      });
    mockGetAuctionPrices.mockResolvedValue(new Map([
      [activePoolState.pool, {
        pool: activePoolState.pool,
        auctionPrice: parseEther("2"),
        auctionPriceFormatted: "2.0",
        timeRemaining: 3600n,
        timeRemainingHours: 1,
      }],
    ]));
    mockGetPricesForQuoteTokens.mockResolvedValue(new Map([
      ["USDC", {
        ajnaPriceUsd: 0.2,
        quoteTokenPriceUsd: 1,
        source: "coingecko",
        isStale: false,
      }],
    ]));
    mockFundedStrategy.estimateProfit.mockResolvedValue(0.012);
    mockFundedStrategy.canExecute.mockResolvedValue(true);
    mockFundedStrategy.estimateAdditionalExecutionGasUnits.mockResolvedValue(60_000n);
    mockEvaluateGasCost.mockImplementation((
      _gasPrice: bigint,
      _ceilingGwei: number,
      estimatedGasUnits: bigint,
    ) => ({
      currentGasPriceGwei: 1,
      isAboveCeiling: false,
      estimatedCostUsd: Number(estimatedGasUnits) / 200_000 * 0.01,
    }));

    await startKeeper({ ...makeConfig(), dryRun: false });

    expect(mockEvaluateGasCost).toHaveBeenCalledWith(1n, 100, 260_000n, 2000);
    expect(mockFundedStrategy.execute).not.toHaveBeenCalled();
  });

  it("accounts for additional strategy follow-up gas before kicking reserve auctions", async () => {
    const kickablePoolState = {
      pool: "0x7777777777777777777777777777777777777777",
      quoteToken: "0x5555555555555555555555555555555555555555",
      quoteTokenScale: 1_000_000_000_000n,
      quoteTokenSymbol: "USDC",
      reserves: 0n,
      claimableReserves: parseEther("1"),
      claimableReservesRemaining: 0n,
      auctionPrice: 0n,
      timeRemaining: 0n,
      hasActiveAuction: false,
      isKickable: true,
    };
    mockDiscoverPools.mockResolvedValue([kickablePoolState.pool]);
    mockGetPoolReserveStates
      .mockResolvedValueOnce([kickablePoolState])
      .mockImplementationOnce(async () => {
        requestShutdown();
        return [];
      });
    mockGetPricesForQuoteTokens.mockResolvedValue(new Map([
      ["USDC", {
        ajnaPriceUsd: 0.2,
        quoteTokenPriceUsd: 1,
        source: "coingecko",
        isStale: false,
      }],
    ]));
    mockCanKickReserveAuction.mockResolvedValue(true);
    mockEstimateKickClaimableValueUsd.mockReturnValue(1);
    mockFundedStrategy.estimateKickProfit.mockResolvedValue(0.0195);
    mockFundedStrategy.estimateAdditionalKickExecutionGasUnits.mockResolvedValue(60_000n);
    mockEvaluateGasCost.mockImplementation((
      _gasPrice: bigint,
      _ceilingGwei: number,
      estimatedGasUnits: bigint,
    ) => ({
      currentGasPriceGwei: 1,
      isAboveCeiling: false,
      estimatedCostUsd: Number(estimatedGasUnits) / 200_000 * 0.01,
    }));

    await startKeeper({ ...makeConfig(), dryRun: false });

    expect(mockEvaluateGasCost).toHaveBeenCalledWith(1n, 100, 260_000n, 2000);
    expect(mockKickReserveAuction).not.toHaveBeenCalled();
  });

  it("resets stale shutdown state before starting loops", async () => {
    requestShutdown();
    mockGetPoolReserveStates.mockImplementation(async () => {
      requestShutdown();
      return [];
    });

    await startKeeper(makeConfig());

    expect(mockGetPoolReserveStates).toHaveBeenCalledTimes(1);
  });

  it("fails startup preflight when live submission is unhealthy", async () => {
    const unhealthySubmitter = {
      name: "private-rpc",
      supportsLiveSubmission: true,
      submit: vi.fn(),
      isHealthy: vi.fn().mockResolvedValue(false),
      preflightLiveSubmissionReadiness: vi.fn().mockResolvedValue(false),
    };
    mockCreatePrivateRpcSubmitter.mockReturnValue(unhealthySubmitter);

    await expect(startKeeper({
      ...makeConfig(),
      dryRun: false,
    })).rejects.toThrow("Live private-rpc submission is unhealthy for base. Refusing startup.");

    expect(unhealthySubmitter.preflightLiveSubmissionReadiness).toHaveBeenCalledTimes(1);
    expect(mockDiscoverPools).not.toHaveBeenCalled();
  });

  it("pauses further live submissions for the current cycle when submitter health degrades mid-cycle", async () => {
    const firstPoolState = {
      pool: "0x6666666666666666666666666666666666666666",
      quoteToken: "0x5555555555555555555555555555555555555555",
      quoteTokenScale: 1_000_000_000_000n,
      quoteTokenSymbol: "USDC",
      reserves: 0n,
      claimableReserves: 0n,
      claimableReservesRemaining: parseEther("1"),
      auctionPrice: parseEther("2"),
      timeRemaining: 3600n,
      hasActiveAuction: true,
      isKickable: false,
    };
    const secondPoolState = {
      ...firstPoolState,
      pool: "0x7777777777777777777777777777777777777777",
    };
    const flashbotsSubmitter = {
      name: "flashbots",
      supportsLiveSubmission: true,
      submit: vi.fn(),
      isHealthy: vi.fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false)
        .mockImplementation(async () => {
          requestShutdown();
          return false;
        }),
      preflightLiveSubmissionReadiness: vi.fn().mockResolvedValue(true),
    };
    mockCreateFlashbotsSubmitter.mockReturnValue(flashbotsSubmitter);
    mockDiscoverPools.mockResolvedValue([firstPoolState.pool, secondPoolState.pool]);
    mockGetPoolReserveStates.mockResolvedValue([firstPoolState, secondPoolState]);
    mockGetAuctionPrices.mockResolvedValue(new Map([
      [firstPoolState.pool, {
        pool: firstPoolState.pool,
        auctionPrice: parseEther("2"),
        auctionPriceFormatted: "2.0",
        timeRemaining: 3600n,
        timeRemainingHours: 1,
      }],
      [secondPoolState.pool, {
        pool: secondPoolState.pool,
        auctionPrice: parseEther("2"),
        auctionPriceFormatted: "2.0",
        timeRemaining: 3600n,
        timeRemainingHours: 1,
      }],
    ]));
    mockGetPricesForQuoteTokens.mockResolvedValue(new Map([
      ["USDC", {
        ajnaPriceUsd: 0.2,
        quoteTokenPriceUsd: 1,
        source: "coingecko",
        isStale: false,
      }],
    ]));
    mockFundedStrategy.estimateProfit.mockResolvedValue(1);
    mockFundedStrategy.canExecute.mockResolvedValue(true);
    mockFundedStrategy.execute.mockRejectedValue(new Error("relay unavailable"));
    mockIsProfitableAfterCosts.mockReturnValue(true);

    await startKeeper({
      ...makeConfig(),
      dryRun: false,
      chains: [
        {
          ...makeConfig().chains[0],
          chainConfig: {
            ...makeConfig().chains[0].chainConfig,
            mevMethod: "flashbots",
          },
          privateRpcUrl: undefined,
          privateRpcTrusted: false,
        },
      ],
    });

    expect(mockFundedStrategy.execute).toHaveBeenCalledTimes(1);
    expect(flashbotsSubmitter.isHealthy).toHaveBeenCalledTimes(3);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "Submission endpoint became unhealthy mid-cycle, pausing further live submissions",
      expect.objectContaining({
        chain: "base",
        submitter: "flashbots",
        operation: "execution",
        pool: firstPoolState.pool,
      }),
    );
  });

  it("pauses further live submissions when a submitted transaction receipt cannot be confirmed", async () => {
    const firstPoolState = {
      pool: "0x6666666666666666666666666666666666666666",
      quoteToken: "0x5555555555555555555555555555555555555555",
      quoteTokenScale: 1_000_000_000_000n,
      quoteTokenSymbol: "USDC",
      reserves: 0n,
      claimableReserves: 0n,
      claimableReservesRemaining: parseEther("1"),
      auctionPrice: parseEther("2"),
      timeRemaining: 3600n,
      hasActiveAuction: true,
      isKickable: false,
    };
    const secondPoolState = {
      ...firstPoolState,
      pool: "0x7777777777777777777777777777777777777777",
    };
    const submittedTxHash = `0x${"aa".repeat(32)}`;
    const waitForTransactionReceipt = vi.fn().mockImplementationOnce(async () => {
      requestShutdown();
      throw new Error("receipt timed out");
    });

    mockCreatePublicClient.mockImplementation(() => ({
      getGasPrice: vi.fn().mockResolvedValue(1n),
      getBlock: vi.fn().mockResolvedValue({ baseFeePerGas: 1n }),
      waitForTransactionReceipt,
    }));
    mockDiscoverPools.mockResolvedValue([firstPoolState.pool, secondPoolState.pool]);
    mockGetPoolReserveStates.mockResolvedValue([firstPoolState, secondPoolState]);
    mockGetAuctionPrices.mockResolvedValue(new Map([
      [firstPoolState.pool, {
        pool: firstPoolState.pool,
        auctionPrice: parseEther("2"),
        auctionPriceFormatted: "2.0",
        timeRemaining: 3600n,
        timeRemainingHours: 1,
      }],
      [secondPoolState.pool, {
        pool: secondPoolState.pool,
        auctionPrice: parseEther("2"),
        auctionPriceFormatted: "2.0",
        timeRemaining: 3600n,
        timeRemainingHours: 1,
      }],
    ]));
    mockGetPricesForQuoteTokens.mockResolvedValue(new Map([
      ["USDC", {
        ajnaPriceUsd: 0.2,
        quoteTokenPriceUsd: 1,
        source: "coingecko",
        isStale: false,
      }],
    ]));
    mockFundedStrategy.estimateProfit.mockResolvedValue(1);
    mockFundedStrategy.canExecute.mockResolvedValue(true);
    mockFundedStrategy.execute.mockRejectedValueOnce(
      new PendingSubmissionError(
        {
          txHash: submittedTxHash,
          label: "execution",
          mode: "private-rpc",
          privateSubmission: true,
        },
        `Failed while waiting for execution receipt ${submittedTxHash}: receipt timed out`,
      ),
    );
    mockIsProfitableAfterCosts.mockReturnValue(true);

    await startKeeper({
      ...makeConfig(),
      dryRun: false,
    });

    expect(mockFundedStrategy.execute).toHaveBeenCalledTimes(1);
    expect(waitForTransactionReceipt).toHaveBeenCalledTimes(1);
    expect(mockSetHealthDependency).toHaveBeenCalledWith(
      "submission:base",
      false,
      `awaiting resolution for execution submission ${submittedTxHash}`,
    );
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "Submitted transaction outcome is unresolved, pausing further live submissions",
      expect.objectContaining({
        chain: "base",
        operation: "execution",
        pool: firstPoolState.pool,
        txHash: submittedTxHash,
        label: "execution",
      }),
    );
  });

  it("pauses further live submissions when a flashbots bundle was accepted but monitoring failed", async () => {
    const firstPoolState = {
      pool: "0x6666666666666666666666666666666666666666",
      quoteToken: "0x5555555555555555555555555555555555555555",
      quoteTokenScale: 1_000_000_000_000n,
      quoteTokenSymbol: "USDC",
      reserves: 0n,
      claimableReserves: 0n,
      claimableReservesRemaining: parseEther("1"),
      auctionPrice: parseEther("2"),
      timeRemaining: 3600n,
      hasActiveAuction: true,
      isKickable: false,
    };
    const secondPoolState = {
      ...firstPoolState,
      pool: "0x7777777777777777777777777777777777777777",
    };
    const submittedTxHash = `0x${"bb".repeat(32)}`;

    mockDiscoverPools.mockResolvedValue([firstPoolState.pool, secondPoolState.pool]);
    mockGetPoolReserveStates.mockResolvedValue([firstPoolState, secondPoolState]);
    mockGetAuctionPrices.mockResolvedValue(new Map([
      [firstPoolState.pool, {
        pool: firstPoolState.pool,
        auctionPrice: parseEther("2"),
        auctionPriceFormatted: "2.0",
        timeRemaining: 3600n,
        timeRemainingHours: 1,
      }],
      [secondPoolState.pool, {
        pool: secondPoolState.pool,
        auctionPrice: parseEther("2"),
        auctionPriceFormatted: "2.0",
        timeRemaining: 3600n,
        timeRemainingHours: 1,
      }],
    ]));
    mockGetPricesForQuoteTokens.mockResolvedValue(new Map([
      ["USDC", {
        ajnaPriceUsd: 0.2,
        quoteTokenPriceUsd: 1,
        source: "coingecko",
        isStale: false,
      }],
    ]));
    mockFundedStrategy.estimateProfit.mockResolvedValue(1);
    mockFundedStrategy.canExecute.mockResolvedValue(true);
    mockFundedStrategy.execute.mockImplementationOnce(async () => {
      requestShutdown();
      throw new PendingSubmissionError(
        {
          txHash: submittedTxHash,
          label: "takeReserves",
          mode: "flashbots",
          bundleHash: "bundle-1",
          targetBlock: 101n,
          privateSubmission: true,
        },
        `Flashbots bundle submission accepted by relay, but inclusion monitoring failed: gateway timeout`,
      );
    });
    mockIsProfitableAfterCosts.mockReturnValue(true);

    await startKeeper({
      ...makeConfig(),
      dryRun: false,
    });

    expect(mockFundedStrategy.execute).toHaveBeenCalledTimes(1);
    expect(mockSetHealthDependency).toHaveBeenCalledWith(
      "submission:base",
      false,
      `awaiting resolution for takeReserves submission ${submittedTxHash}`,
    );
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "Submitted transaction outcome is unresolved, pausing further live submissions",
      expect.objectContaining({
        chain: "base",
        operation: "execution",
        pool: firstPoolState.pool,
        txHash: submittedTxHash,
        label: "takeReserves",
        submissionMode: "flashbots",
        bundleHash: "bundle-1",
        targetBlock: "101",
        privateSubmission: true,
      }),
    );
  });

  it("marks pricing unhealthy when the active quote-token price is stale", async () => {
    const activePoolState = {
      pool: "0x6666666666666666666666666666666666666666",
      quoteToken: "0x5555555555555555555555555555555555555555",
      quoteTokenScale: 1_000_000_000_000n,
      quoteTokenSymbol: "USDC",
      reserves: 0n,
      claimableReserves: 0n,
      claimableReservesRemaining: parseEther("1"),
      auctionPrice: parseEther("2"),
      timeRemaining: 3600n,
      hasActiveAuction: true,
      isKickable: false,
    };
    mockDiscoverPools.mockResolvedValue([activePoolState.pool]);
    mockGetPoolReserveStates
      .mockResolvedValueOnce([activePoolState])
      .mockImplementationOnce(async () => {
        requestShutdown();
        return [];
      });
    mockGetAuctionPrices.mockResolvedValue(new Map([
      [activePoolState.pool, {
        pool: activePoolState.pool,
        auctionPrice: parseEther("2"),
        auctionPriceFormatted: "2.0",
        timeRemaining: 3600n,
        timeRemainingHours: 1,
      }],
    ]));
    mockGetPricesForQuoteTokens.mockResolvedValue(new Map([
      ["USDC", {
        ajnaPriceUsd: 0.2,
        quoteTokenPriceUsd: 1,
        source: "coingecko",
        isStale: true,
      }],
    ]));

    await startKeeper(makeConfig());

    expect(mockSetHealthDependency).toHaveBeenCalledWith(
      "pricing:base",
      false,
      "stale prices: USDC",
    );
  });

  it("fails fast when alchemy-only pricing cannot price the chain AJNA token", async () => {
    mockCreateAlchemyPricesClient.mockReturnValue({
      getPrices: vi.fn().mockResolvedValue(new Map()),
      isPriceStale: vi.fn(() => true),
    });

    await expect(startKeeper({
      ...makeConfig(),
      pricing: {
        provider: "alchemy",
      },
      secrets: {
        privateKey: PRIVATE_KEY,
        alchemyApiKey: "test-alchemy-key",
      },
    })).rejects.toThrow("Alchemy-only pricing cannot price AJNA token");
    expect(mockDiscoverPools).not.toHaveBeenCalled();
  });
});
