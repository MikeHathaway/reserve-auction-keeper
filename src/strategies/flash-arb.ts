import {
  type Abi,
  type Address,
  formatEther,
  type PublicClient,
  type WalletClient,
} from "viem";
import type {
  AuctionContext,
  ExecutionStrategy,
  KickContext,
  TxResult,
} from "./interface.js";
import type {
  FlashArbExecutorFamily,
  FlashArbSourceConfig,
  FlashArbSwapRouteConfig,
  NormalizedFlashArbRoute,
} from "../config.js";
import type { MevSubmitter } from "../execution/mev-submitter.js";
import {
  FLASH_ARB_EXECUTOR_ABI,
  FLASH_ARB_EXECUTOR_V2_V3_ABI,
  FLASH_ARB_EXECUTOR_V3_V2_ABI,
} from "../contracts/abis/index.js";
import {
  calculateReserveTakeAjnaCost,
  normalizeReserveTakeAmount,
} from "../auction/math.js";
import {
  captureExecutionSnapshot,
  finalizeExecutionSettlement,
} from "../execution/settlement.js";
import { quoteUniswapV2Path } from "../pricing/uniswap-v2.js";
import type { DexQuote } from "../pricing/uniswap-v3.js";
import { quoteUniswapV3Path } from "../pricing/uniswap-v3.js";
import { logger } from "../utils/logger.js";
import {
  calculateUniswapV2RepayAmount,
  getUniswapV2PairReserveForToken,
  readUniswapV2PairState,
  type UniswapV2PairState,
} from "../utils/uniswap-v2.js";
import {
  decodeUniswapV3Path,
  pathReusesUniswapV3Pool,
  readUniswapV3PoolIdentity,
  type UniswapV3PoolIdentity,
} from "../utils/uniswap-v3.js";

const UNISWAP_FEE_DENOMINATOR = 1_000_000n;
const SLIPPAGE_BPS_DENOMINATOR = 10_000n;
const FAMILY_ADDITIONAL_EXECUTION_GAS_UNITS: Record<FlashArbExecutorFamily, bigint> = {
  v3v3: 0n,
  v2v3: 30_000n,
  v3v2: 30_000n,
};

const ERC20_BALANCE_ABI = [
  {
    inputs: [{ name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

interface FlashArbStrategyConfig {
  maxSlippagePercent: number;
  minLiquidityUsd: number;
  minProfitUsd: number;
  dryRun: boolean;
  ajnaToken: Address;
  nativeTokenPriceUsd: number;
  route?: NormalizedFlashArbRoute;
}

interface FlashArbCandidate {
  family: FlashArbExecutorFamily;
  executorAddress: Address;
  flashSourceAddress: Address;
  sourceProtocol: FlashArbSourceConfig["protocol"];
  swapProtocol: FlashArbSwapRouteConfig["protocol"];
  quoteAmount: bigint;
  borrowAmount: bigint;
  repayAmount: bigint;
  minAjnaOut: bigint;
  quotedAjnaOut: bigint;
  estimatedProfitUsd: number;
  liquidityUsd: number;
  slippagePercent: number;
  hopCount: number;
  additionalExecutionGasUnits: bigint;
  swapPath: FlashArbSwapRouteConfig["path"];
}

type RouteContext = Pick<AuctionContext, "poolState" | "chainName"> | KickContext;

type ResolvedSymbolRoute = {
  sources: FlashArbSourceConfig[];
  swapRoutes: FlashArbSwapRouteConfig[];
};

type EvaluatedSource =
  | {
      protocol: "uniswap-v2";
      sourceAddress: Address;
      pairState: UniswapV2PairState;
      availableBorrowAjna: bigint;
    }
  | {
      protocol: "uniswap-v3";
      sourceAddress: Address;
      poolIdentity: UniswapV3PoolIdentity;
      availableBorrowAjna: bigint;
    };

type SwapQuoteCacheValue = {
  quote: DexQuote;
  hopCount: number;
};

export function createFlashArbStrategy(
  publicClient: PublicClient,
  walletClient: WalletClient,
  submitter: MevSubmitter,
  config: FlashArbStrategyConfig,
): ExecutionStrategy {
  const walletAddress = walletClient.account!.address;
  const warnedKeys = new Set<string>();
  const v3IdentityCache = new Map<Address, Promise<UniswapV3PoolIdentity>>();
  const v2PairStateCache = new Map<Address, Promise<UniswapV2PairState>>();
  let lastActiveCandidate: { key: string; candidate: FlashArbCandidate | null } | null = null;
  let lastKickCandidate: { key: string; candidate: FlashArbCandidate | null } | null = null;

  function warnOnce(message: string, key: string, ctx: RouteContext) {
    if (warnedKeys.has(key)) return;
    warnedKeys.add(key);
    logger.warn(message, {
      chain: ctx.chainName,
      pool: ctx.poolState.pool,
      quoteToken: ctx.poolState.quoteTokenSymbol,
    });
  }

  function getActiveContextKey(ctx: AuctionContext): string {
    return [
      "active",
      ctx.chainName,
      ctx.poolState.pool,
      ctx.poolState.quoteTokenSymbol,
      ctx.poolState.quoteTokenScale.toString(),
      ctx.poolState.claimableReservesRemaining.toString(),
      ctx.auctionPrice.toString(),
      ctx.prices.quoteTokenPriceUsd.toString(),
      ctx.prices.ajnaPriceUsd.toString(),
    ].join(":");
  }

  function getKickContextKey(ctx: KickContext): string {
    return [
      "kick",
      ctx.chainName,
      ctx.poolState.pool,
      ctx.poolState.quoteTokenSymbol,
      ctx.poolState.quoteTokenScale.toString(),
      ctx.poolState.claimableReserves.toString(),
      ctx.poolState.auctionPrice.toString(),
      ctx.prices.quoteTokenPriceUsd.toString(),
      ctx.prices.ajnaPriceUsd.toString(),
    ].join(":");
  }

  function getSlippageBps(): bigint {
    return BigInt(Math.floor(config.maxSlippagePercent * 100));
  }

  function calculateV3FlashFee(borrowAmount: bigint, feePpm: bigint): bigint {
    return (borrowAmount * feePpm + UNISWAP_FEE_DENOMINATOR - 1n) /
      UNISWAP_FEE_DENOMINATOR;
  }

  function applySlippageFloor(amountOut: bigint): bigint {
    const slippageBps = getSlippageBps();
    if (slippageBps >= SLIPPAGE_BPS_DENOMINATOR) {
      return 0n;
    }

    return amountOut * (SLIPPAGE_BPS_DENOMINATOR - slippageBps) /
      SLIPPAGE_BPS_DENOMINATOR;
  }

  function resolveExecutorFamily(
    sourceProtocol: FlashArbSourceConfig["protocol"],
    swapProtocol: FlashArbSwapRouteConfig["protocol"],
  ): FlashArbExecutorFamily | null {
    if (sourceProtocol === "uniswap-v2" && swapProtocol === "uniswap-v3") return "v2v3";
    if (sourceProtocol === "uniswap-v3" && swapProtocol === "uniswap-v2") return "v3v2";
    if (sourceProtocol === "uniswap-v3" && swapProtocol === "uniswap-v3") return "v3v3";
    return null;
  }

  function getRouteLabel(
    ctx: RouteContext,
    sourceProtocol: FlashArbSourceConfig["protocol"],
    swapProtocol: FlashArbSwapRouteConfig["protocol"],
  ): string {
    return `${ctx.chainName}.flashArb.${ctx.poolState.quoteTokenSymbol}.${sourceProtocol}->${swapProtocol}`;
  }

  function resolveSymbolRoute(ctx: RouteContext): ResolvedSymbolRoute | null {
    if (!config.route) {
      warnOnce("Flash-arb route config missing for chain", `route:${ctx.chainName}`, ctx);
      return null;
    }

    const symbol = ctx.poolState.quoteTokenSymbol;
    const sources = config.route.sources[symbol];
    if (!sources || sources.length === 0) {
      warnOnce(
        "Flash-arb sources missing for quote token",
        `sources:${ctx.chainName}:${symbol}`,
        ctx,
      );
      return null;
    }

    const swapRoutes = config.route.swapRoutes[symbol];
    if (!swapRoutes || swapRoutes.length === 0) {
      warnOnce(
        "Flash-arb swap routes missing for quote token",
        `swapRoutes:${ctx.chainName}:${symbol}`,
        ctx,
      );
      return null;
    }

    return { sources, swapRoutes };
  }

  async function getV3PoolIdentity(poolAddress: Address): Promise<UniswapV3PoolIdentity> {
    const cached = v3IdentityCache.get(poolAddress);
    if (cached) return cached;

    const pending = readUniswapV3PoolIdentity(publicClient, poolAddress)
      .catch((error) => {
        v3IdentityCache.delete(poolAddress);
        throw error;
      });
    v3IdentityCache.set(poolAddress, pending);
    return pending;
  }

  async function getV2PairState(pairAddress: Address): Promise<UniswapV2PairState> {
    const cached = v2PairStateCache.get(pairAddress);
    if (cached) return cached;

    const pending = readUniswapV2PairState(publicClient, pairAddress)
      .catch((error) => {
        v2PairStateCache.delete(pairAddress);
        throw error;
      });
    v2PairStateCache.set(pairAddress, pending);
    return pending;
  }

  async function getAjnaBalance(account: Address): Promise<bigint> {
    const balance = await publicClient.readContract({
      address: config.ajnaToken,
      abi: ERC20_BALANCE_ABI,
      functionName: "balanceOf",
      args: [account],
    });
    return typeof balance === "bigint" ? balance : BigInt(balance);
  }

  async function inspectSource(
    ctx: RouteContext,
    source: FlashArbSourceConfig,
  ): Promise<EvaluatedSource | null> {
    if (source.protocol === "uniswap-v2") {
      let pairState: UniswapV2PairState;
      try {
        pairState = await getV2PairState(source.address);
      } catch (error) {
        warnOnce(
          `Flash-arb Uniswap V2 flash source could not be inspected: ${error instanceof Error ? error.message : String(error)}`,
          `sourceInspect:${ctx.chainName}:${ctx.poolState.quoteTokenSymbol}:${source.protocol}:${source.address}`,
          ctx,
        );
        return null;
      }

      const availableBorrowAjna = getUniswapV2PairReserveForToken(pairState, config.ajnaToken);
      if (availableBorrowAjna === 0n) {
        warnOnce(
          "Flash-arb Uniswap V2 flash source does not hold AJNA liquidity",
          `sourceAjnaMissing:${ctx.chainName}:${ctx.poolState.quoteTokenSymbol}:${source.protocol}:${source.address}`,
          ctx,
        );
        return null;
      }

      return {
        protocol: "uniswap-v2",
        sourceAddress: source.address,
        pairState,
        availableBorrowAjna,
      };
    }

    let poolIdentity: UniswapV3PoolIdentity;
    try {
      poolIdentity = await getV3PoolIdentity(source.address);
    } catch (error) {
      warnOnce(
        `Flash-arb Uniswap V3 flash source could not be inspected: ${error instanceof Error ? error.message : String(error)}`,
        `sourceInspect:${ctx.chainName}:${ctx.poolState.quoteTokenSymbol}:${source.protocol}:${source.address}`,
        ctx,
      );
      return null;
    }

    if (
      poolIdentity.token0.toLowerCase() !== config.ajnaToken.toLowerCase() &&
      poolIdentity.token1.toLowerCase() !== config.ajnaToken.toLowerCase()
    ) {
      warnOnce(
        "Flash-arb Uniswap V3 flash source does not contain AJNA",
        `sourceAjnaMissing:${ctx.chainName}:${ctx.poolState.quoteTokenSymbol}:${source.protocol}:${source.address}`,
        ctx,
      );
      return null;
    }

    if (poolIdentity.liquidity === 0n) {
      warnOnce(
        "Flash-arb Uniswap V3 flash source has zero liquidity",
        `sourceLiquidity:${ctx.chainName}:${ctx.poolState.quoteTokenSymbol}:${source.protocol}:${source.address}`,
        ctx,
      );
      return null;
    }

    const availableBorrowAjna = await getAjnaBalance(source.address);
    if (availableBorrowAjna === 0n) {
      warnOnce(
        "Flash-arb Uniswap V3 flash source has no AJNA balance",
        `sourceBalance:${ctx.chainName}:${ctx.poolState.quoteTokenSymbol}:${source.protocol}:${source.address}`,
        ctx,
      );
      return null;
    }

    return {
      protocol: "uniswap-v3",
      sourceAddress: source.address,
      poolIdentity,
      availableBorrowAjna,
    };
  }

  async function quoteSwapRoute(
    ctx: RouteContext,
    swapRoute: FlashArbSwapRouteConfig,
    quoteAmount: bigint,
    prices: AuctionContext["prices"],
  ): Promise<SwapQuoteCacheValue | null> {
    if (!config.route) return null;

    const label = getRouteLabel(ctx, "uniswap-v3", swapRoute.protocol);
    if (swapRoute.protocol === "uniswap-v2") {
      if (!config.route.uniswapV2FactoryAddress) {
        warnOnce(
          "Flash-arb Uniswap V2 swap route configured without a factory address",
          `v2Factory:${ctx.chainName}:${ctx.poolState.quoteTokenSymbol}`,
          ctx,
        );
        return null;
      }

      const quote = await quoteUniswapV2Path(
        publicClient,
        {
          factoryAddress: config.route.uniswapV2FactoryAddress,
          label,
        },
        swapRoute.path,
        quoteAmount,
        ctx.poolState.quoteTokenScale,
        prices,
      );
      if (!quote) return null;

      return {
        quote,
        hopCount: Math.max(0, swapRoute.path.length - 1),
      };
    }

    if (!config.route.quoterAddress) {
      warnOnce(
        "Flash-arb Uniswap V3 swap route configured without a quoter address",
        `v3Quoter:${ctx.chainName}:${ctx.poolState.quoteTokenSymbol}`,
        ctx,
      );
      return null;
    }

    const quote = await quoteUniswapV3Path(
      publicClient,
      config.route.quoterAddress,
      swapRoute.path,
      quoteAmount,
      ctx.poolState.quoteTokenScale,
      prices,
      label,
    );
    if (!quote) return null;

    return {
      quote,
      hopCount: decodeUniswapV3Path(swapRoute.path).length,
    };
  }

  function isBetterCandidate(
    nextCandidate: FlashArbCandidate,
    currentBest: FlashArbCandidate | null,
  ): boolean {
    if (!currentBest) return true;
    if (nextCandidate.estimatedProfitUsd !== currentBest.estimatedProfitUsd) {
      return nextCandidate.estimatedProfitUsd > currentBest.estimatedProfitUsd;
    }
    if (nextCandidate.minAjnaOut !== currentBest.minAjnaOut) {
      return nextCandidate.minAjnaOut > currentBest.minAjnaOut;
    }
    if (nextCandidate.slippagePercent !== currentBest.slippagePercent) {
      return nextCandidate.slippagePercent < currentBest.slippagePercent;
    }
    if (nextCandidate.hopCount !== currentBest.hopCount) {
      return nextCandidate.hopCount < currentBest.hopCount;
    }
    return nextCandidate.repayAmount < currentBest.repayAmount;
  }

  async function selectBestCandidate(
    ctx: RouteContext,
    quoteAmount: bigint,
    borrowAmount: bigint,
    prices: AuctionContext["prices"],
    liquidityUsd: number,
  ): Promise<FlashArbCandidate | null> {
    const symbolRoute = resolveSymbolRoute(ctx);
    if (!symbolRoute || !config.route) {
      return null;
    }

    const sourceStateCache = new Map<string, Promise<EvaluatedSource | null>>();
    const swapQuoteCache = new Map<string, Promise<SwapQuoteCacheValue | null>>();
    let bestCandidate: FlashArbCandidate | null = null;

    for (const source of symbolRoute.sources) {
      const sourceCacheKey = `${source.protocol}:${source.address}`;
      const sourceStatePromise = sourceStateCache.get(sourceCacheKey) ||
        inspectSource(ctx, source);
      sourceStateCache.set(sourceCacheKey, sourceStatePromise);
      const sourceState = await sourceStatePromise;
      if (!sourceState) continue;

      if (sourceState.availableBorrowAjna < borrowAmount) {
        logger.debug("Flash-arb candidate rejected because flash source cannot cover the borrow amount", {
          chain: ctx.chainName,
          pool: ctx.poolState.pool,
          flashSource: sourceState.sourceAddress,
          sourceProtocol: sourceState.protocol,
          borrowAmount: formatEther(borrowAmount),
          availableBorrowAjna: formatEther(sourceState.availableBorrowAjna),
        });
        continue;
      }

      for (const swapRoute of symbolRoute.swapRoutes) {
        const family = resolveExecutorFamily(source.protocol, swapRoute.protocol);
        if (!family) continue;

        const executorAddress = config.route.executors[family];
        if (!executorAddress) {
          warnOnce(
            `Flash-arb executor missing for ${family} routes`,
            `executor:${ctx.chainName}:${ctx.poolState.quoteTokenSymbol}:${family}`,
            ctx,
          );
          continue;
        }

        if (
          sourceState.protocol === "uniswap-v3" &&
          swapRoute.protocol === "uniswap-v3" &&
          pathReusesUniswapV3Pool(swapRoute.path, sourceState.poolIdentity)
        ) {
          warnOnce(
            "Flash-arb swap path reuses the configured Uniswap V3 flash source and cannot execute during callback",
            `flashPoolReuse:${ctx.chainName}:${ctx.poolState.quoteTokenSymbol}:${sourceState.sourceAddress}:${swapRoute.path}`,
            ctx,
          );
          continue;
        }

        const swapQuoteCacheKey = swapRoute.protocol === "uniswap-v3"
          ? `${swapRoute.protocol}:${swapRoute.path}`
          : `${swapRoute.protocol}:${swapRoute.path.join(",")}`;
        const swapQuotePromise = swapQuoteCache.get(swapQuoteCacheKey) ||
          quoteSwapRoute(ctx, swapRoute, quoteAmount, prices);
        swapQuoteCache.set(swapQuoteCacheKey, swapQuotePromise);
        const quotedRoute = await swapQuotePromise;
        if (!quotedRoute) continue;

        if (quotedRoute.quote.slippagePercent > config.maxSlippagePercent) {
          logger.debug("Flash-arb candidate rejected for slippage", {
            chain: ctx.chainName,
            pool: ctx.poolState.pool,
            sourceProtocol: source.protocol,
            swapProtocol: swapRoute.protocol,
            slippagePercent: quotedRoute.quote.slippagePercent.toFixed(2),
            maxSlippagePercent: config.maxSlippagePercent,
          });
          continue;
        }

        const repayAmount = sourceState.protocol === "uniswap-v2"
          ? calculateUniswapV2RepayAmount(borrowAmount)
          : borrowAmount + calculateV3FlashFee(borrowAmount, sourceState.poolIdentity.fee);
        const minAjnaOut = applySlippageFloor(quotedRoute.quote.amountOut);
        if (minAjnaOut <= repayAmount) {
          logger.debug("Flash-arb candidate rejected after repayment and slippage floor", {
            chain: ctx.chainName,
            pool: ctx.poolState.pool,
            sourceProtocol: source.protocol,
            swapProtocol: swapRoute.protocol,
            borrowAmount: formatEther(borrowAmount),
            repayAmount: formatEther(repayAmount),
            minAjnaOut: formatEther(minAjnaOut),
          });
          continue;
        }

        const estimatedProfitAjna = minAjnaOut - repayAmount;
        const estimatedProfitUsd =
          Number(formatEther(estimatedProfitAjna)) * prices.ajnaPriceUsd;
        if (estimatedProfitUsd < config.minProfitUsd) {
          continue;
        }

        const candidate: FlashArbCandidate = {
          family,
          executorAddress,
          flashSourceAddress: sourceState.sourceAddress,
          sourceProtocol: source.protocol,
          swapProtocol: swapRoute.protocol,
          quoteAmount,
          borrowAmount,
          repayAmount,
          minAjnaOut,
          quotedAjnaOut: quotedRoute.quote.amountOut,
          estimatedProfitUsd,
          liquidityUsd,
          slippagePercent: quotedRoute.quote.slippagePercent,
          hopCount: quotedRoute.hopCount,
          additionalExecutionGasUnits: FAMILY_ADDITIONAL_EXECUTION_GAS_UNITS[family],
          swapPath: swapRoute.path,
        };

        if (isBetterCandidate(candidate, bestCandidate)) {
          bestCandidate = candidate;
        }
      }
    }

    return bestCandidate;
  }

  async function evaluateActiveCandidate(ctx: AuctionContext): Promise<FlashArbCandidate | null> {
    const key = getActiveContextKey(ctx);
    if (lastActiveCandidate?.key === key) {
      return lastActiveCandidate.candidate;
    }

    if (!ctx.poolState.hasActiveAuction || ctx.auctionPrice === 0n) {
      lastActiveCandidate = { key, candidate: null };
      return null;
    }

    const quoteAmount = normalizeReserveTakeAmount(
      ctx.poolState.claimableReservesRemaining,
      ctx.poolState.quoteTokenScale,
    );
    if (quoteAmount === 0n) {
      lastActiveCandidate = { key, candidate: null };
      return null;
    }

    const liquidityUsd =
      Number(formatEther(quoteAmount)) * ctx.prices.quoteTokenPriceUsd;
    if (liquidityUsd < config.minLiquidityUsd) {
      lastActiveCandidate = { key, candidate: null };
      return null;
    }

    const borrowAmount = calculateReserveTakeAjnaCost(
      quoteAmount,
      ctx.auctionPrice,
    );
    if (borrowAmount === 0n) {
      lastActiveCandidate = { key, candidate: null };
      return null;
    }

    const candidate = await selectBestCandidate(
      ctx,
      quoteAmount,
      borrowAmount,
      ctx.prices,
      liquidityUsd,
    );
    lastActiveCandidate = { key, candidate };
    return candidate;
  }

  async function evaluateKickCandidate(ctx: KickContext): Promise<FlashArbCandidate | null> {
    const key = getKickContextKey(ctx);
    if (lastKickCandidate?.key === key) {
      return lastKickCandidate.candidate;
    }

    if (config.minProfitUsd <= 0 || ctx.prices.ajnaPriceUsd <= 0) {
      lastKickCandidate = { key, candidate: null };
      return null;
    }

    const quoteAmount = normalizeReserveTakeAmount(
      ctx.poolState.claimableReserves,
      ctx.poolState.quoteTokenScale,
    );
    if (quoteAmount === 0n) {
      lastKickCandidate = { key, candidate: null };
      return null;
    }

    const liquidityUsd =
      Number(formatEther(quoteAmount)) * ctx.prices.quoteTokenPriceUsd;
    if (liquidityUsd < config.minLiquidityUsd) {
      lastKickCandidate = { key, candidate: null };
      return null;
    }

    const borrowAmount = calculateReserveTakeAjnaCost(
      quoteAmount,
      ctx.poolState.auctionPrice,
    );
    if (borrowAmount === 0n) {
      lastKickCandidate = { key, candidate: null };
      return null;
    }

    const candidate = await selectBestCandidate(
      ctx,
      quoteAmount,
      borrowAmount,
      ctx.prices,
      liquidityUsd,
    );
    lastKickCandidate = { key, candidate };
    return candidate;
  }

  function getExecutorInvocation(
    candidate: FlashArbCandidate,
    ajnaPool: Address,
    profitRecipient: Address,
  ): { abi: Abi; args: readonly unknown[] } {
    if (candidate.family === "v2v3") {
      return {
        abi: FLASH_ARB_EXECUTOR_V2_V3_ABI as Abi,
        args: [{
          flashPair: candidate.flashSourceAddress,
          ajnaPool,
          borrowAmount: candidate.borrowAmount,
          quoteAmount: candidate.quoteAmount,
          swapPath: candidate.swapPath,
          minAjnaOut: candidate.minAjnaOut,
          profitRecipient,
        }],
      };
    }

    if (candidate.family === "v3v2") {
      return {
        abi: FLASH_ARB_EXECUTOR_V3_V2_ABI as Abi,
        args: [{
          flashPool: candidate.flashSourceAddress,
          ajnaPool,
          borrowAmount: candidate.borrowAmount,
          quoteAmount: candidate.quoteAmount,
          swapPath: candidate.swapPath,
          minAjnaOut: candidate.minAjnaOut,
          profitRecipient,
        }],
      };
    }

    return {
      abi: FLASH_ARB_EXECUTOR_ABI as Abi,
      args: [{
        flashPool: candidate.flashSourceAddress,
        ajnaPool,
        borrowAmount: candidate.borrowAmount,
        quoteAmount: candidate.quoteAmount,
        swapPath: candidate.swapPath,
        minAjnaOut: candidate.minAjnaOut,
        profitRecipient,
      }],
    };
  }

  return {
    name: "flash-arb",

    async canExecute(ctx: AuctionContext): Promise<boolean> {
      const candidate = await evaluateActiveCandidate(ctx);
      if (!candidate) {
        return false;
      }

      logger.info("Flash-arb candidate ready", {
        chain: ctx.chainName,
        pool: ctx.poolState.pool,
        family: candidate.family,
        executorAddress: candidate.executorAddress,
        flashSourceAddress: candidate.flashSourceAddress,
        sourceProtocol: candidate.sourceProtocol,
        swapProtocol: candidate.swapProtocol,
        estimatedProfitUsd: candidate.estimatedProfitUsd.toFixed(4),
        liquidityUsd: candidate.liquidityUsd.toFixed(2),
        slippagePercent: candidate.slippagePercent.toFixed(2),
        maxSlippagePercent: config.maxSlippagePercent,
        minLiquidityUsd: config.minLiquidityUsd,
        dryRun: config.dryRun,
      });

      return true;
    },

    async execute(ctx: AuctionContext): Promise<TxResult> {
      const candidate = await evaluateActiveCandidate(ctx);
      if (!candidate) {
        throw new Error(
          "Flash-arb opportunity is no longer executable or the route is misconfigured.",
        );
      }

      const invocation = getExecutorInvocation(candidate, ctx.poolState.pool, walletAddress);

      logger.info("Executing flash-arb via executor", {
        chain: ctx.chainName,
        pool: ctx.poolState.pool,
        family: candidate.family,
        executorAddress: candidate.executorAddress,
        flashSourceAddress: candidate.flashSourceAddress,
        sourceProtocol: candidate.sourceProtocol,
        swapProtocol: candidate.swapProtocol,
        quoteAmount: formatEther(candidate.quoteAmount),
        borrowAmount: formatEther(candidate.borrowAmount),
        minAjnaOut: formatEther(candidate.minAjnaOut),
        dryRun: config.dryRun,
      });

      if (config.dryRun) {
        await publicClient.simulateContract({
          address: candidate.executorAddress,
          abi: invocation.abi,
          functionName: "executeFlashArb",
          args: invocation.args,
          account: walletAddress,
        });

        return {
          submissionMode: "dry-run",
          privateSubmission: false,
          pool: ctx.poolState.pool,
          amountQuoteReceived: candidate.quoteAmount,
          ajnaCost: candidate.repayAmount,
          profitUsd: candidate.estimatedProfitUsd,
          chain: ctx.chainName,
        };
      }

      const beforeSettlement = await captureExecutionSnapshot(
        publicClient,
        walletAddress,
        config.ajnaToken,
        ctx.poolState.quoteToken,
      );

      const submission = await submitter.submit({
        to: candidate.executorAddress,
        abi: invocation.abi,
        functionName: "executeFlashArb",
        args: invocation.args,
        account: walletAddress,
      });

      if (!submission.txHash) {
        throw new Error(
          `Execution submission via ${submitter.name} did not return a transaction hash.`,
        );
      }

      const realized = await finalizeExecutionSettlement(beforeSettlement, {
        publicClient,
        txHash: submission.txHash,
        walletAddress,
        ajnaToken: config.ajnaToken,
        quoteToken: ctx.poolState.quoteToken,
        quoteTokenScale: ctx.poolState.quoteTokenScale,
        prices: ctx.prices,
        nativeTokenPriceUsd: config.nativeTokenPriceUsd,
      });

      return {
        submissionMode: submission.mode,
        txHash: submission.txHash,
        bundleHash: submission.bundleHash,
        targetBlock: submission.targetBlock,
        privateSubmission: submission.privateSubmission,
        pool: ctx.poolState.pool,
        amountQuoteReceived: candidate.quoteAmount,
        ajnaCost: candidate.repayAmount,
        profitUsd: candidate.estimatedProfitUsd,
        realized,
        chain: ctx.chainName,
      };
    },

    async estimateProfit(ctx: AuctionContext): Promise<number> {
      const candidate = await evaluateActiveCandidate(ctx);
      return candidate?.estimatedProfitUsd ?? 0;
    },

    async estimateAdditionalExecutionGasUnits(ctx: AuctionContext): Promise<bigint> {
      const candidate = await evaluateActiveCandidate(ctx);
      return candidate?.additionalExecutionGasUnits ?? 0n;
    },

    async estimateKickProfit(ctx: KickContext): Promise<number> {
      const candidate = await evaluateKickCandidate(ctx);
      return candidate?.estimatedProfitUsd ?? 0;
    },

    async estimateAdditionalKickExecutionGasUnits(ctx: KickContext): Promise<bigint> {
      const candidate = await evaluateKickCandidate(ctx);
      return candidate?.additionalExecutionGasUnits ?? 0n;
    },
  };
}
