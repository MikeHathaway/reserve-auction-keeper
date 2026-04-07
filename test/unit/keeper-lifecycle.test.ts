import { beforeEach, describe, expect, it, vi } from "vitest";
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
  mockIsNearProfitableAfterCosts,
  mockIsProfitableAfterCosts,
  mockSumEstimatedCostsUsd,
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
    })),
    mockCreatePrivateRpcSubmitter: vi.fn(() => ({
      name: "private-rpc",
      supportsLiveSubmission: true,
      submit: vi.fn(),
      isHealthy: vi.fn().mockResolvedValue(true),
    })),
    mockFundedStrategy: {
      name: "funded",
      canExecute: vi.fn(),
      execute: vi.fn(),
      estimateProfit: vi.fn(),
      estimateKickProfit: vi.fn(),
    },
    mockCreateFundedStrategy: vi.fn(),
    mockCreateFlashArbStrategy: vi.fn(),
    mockEvaluateGasCost: vi.fn(() => ({
      currentGasPriceGwei: 1,
      isAboveCeiling: false,
      estimatedCostUsd: 0.01,
    })),
    mockIsNearProfitableAfterCosts: vi.fn(() => false),
    mockIsProfitableAfterCosts: vi.fn(() => false),
    mockSumEstimatedCostsUsd: vi.fn((...costs: number[]) => costs.reduce((sum, cost) => sum + cost, 0)),
    mockLogger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      alert: vi.fn(),
      debug: vi.fn(),
    },
    mockCreatePublicClient: vi.fn(() => ({
      getGasPrice: vi.fn().mockResolvedValue(1n),
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
  isNearProfitableAfterCosts: mockIsNearProfitableAfterCosts,
  isProfitableAfterCosts: mockIsProfitableAfterCosts,
  sumEstimatedCostsUsd: mockSumEstimatedCostsUsd,
}));

vi.mock("../../src/utils/logger.js", () => ({
  logger: mockLogger,
}));

import { requestShutdown, startKeeper } from "../../src/keeper.js";

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
