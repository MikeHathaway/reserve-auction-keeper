import {
  type Address,
  formatEther,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import type {
  AuctionContext,
  ExecutionStrategy,
  KickContext,
  TxResult,
} from "./interface.js";
import type { MevSubmitter } from "../execution/mev-submitter.js";
import { FLASH_ARB_EXECUTOR_ABI } from "../contracts/abis/index.js";
import {
  calculateReserveTakeAjnaCost,
  normalizeReserveTakeAmount,
} from "../auction/math.js";
import {
  captureExecutionSnapshot,
  finalizeExecutionSettlement,
} from "../execution/settlement.js";
import { logger } from "../utils/logger.js";
import type { DexQuoter } from "../pricing/uniswap-v3.js";

const UNISWAP_V3_POOL_ABI = [
  {
    inputs: [],
    name: "fee",
    outputs: [{ name: "", type: "uint24" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const UNISWAP_FEE_DENOMINATOR = 1_000_000n;
const SLIPPAGE_BPS_DENOMINATOR = 10_000n;

interface FlashArbRouteConfig {
  executorAddress?: Address;
  flashLoanPools: Record<string, Address>;
  quoteToAjnaPaths: Record<string, Hex>;
}

interface FlashArbStrategyConfig {
  maxSlippagePercent: number;
  minLiquidityUsd: number;
  minProfitUsd: number;
  dryRun: boolean;
  ajnaToken: Address;
  nativeTokenPriceUsd: number;
  dexQuoter?: DexQuoter;
  executorAddress?: Address;
  route?: FlashArbRouteConfig;
}

interface FlashArbCandidate {
  executorAddress: Address;
  flashPool: Address;
  quoteAmount: bigint;
  borrowAmount: bigint;
  repayAmount: bigint;
  minAjnaOut: bigint;
  quotedAjnaOut: bigint;
  swapPath: Hex;
  estimatedProfitUsd: number;
  liquidityUsd: number;
  slippagePercent: number;
}

type RouteContext = Pick<AuctionContext, "poolState" | "chainName"> | KickContext;

export function createFlashArbStrategy(
  publicClient: PublicClient,
  walletClient: WalletClient,
  submitter: MevSubmitter,
  config: FlashArbStrategyConfig,
): ExecutionStrategy {
  const walletAddress = walletClient.account!.address;
  const warnedKeys = new Set<string>();
  const flashPoolFeeCache = new Map<Address, bigint>();
  let lastCandidate: { key: string; candidate: FlashArbCandidate | null } | null = null;

  function warnOnce(message: string, key: string, ctx: RouteContext) {
    if (warnedKeys.has(key)) return;
    warnedKeys.add(key);
    logger.warn(message, {
      chain: ctx.chainName,
      pool: ctx.poolState.pool,
      quoteToken: ctx.poolState.quoteTokenSymbol,
    });
  }

  function getContextKey(ctx: AuctionContext): string {
    return [
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

  function getSlippageBps(): bigint {
    return BigInt(Math.floor(config.maxSlippagePercent * 100));
  }

  function calculateFlashFee(borrowAmount: bigint, feePpm: bigint): bigint {
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

  async function getFlashPoolFeePpm(flashPool: Address): Promise<bigint> {
    const cached = flashPoolFeeCache.get(flashPool);
    if (cached !== undefined) {
      return cached;
    }

    const rawFee = await publicClient.readContract({
      address: flashPool,
      abi: UNISWAP_V3_POOL_ABI,
      functionName: "fee",
    });
    const feePpm = typeof rawFee === "bigint" ? rawFee : BigInt(rawFee);
    flashPoolFeeCache.set(flashPool, feePpm);
    return feePpm;
  }

  function resolveRoute(ctx: RouteContext): {
    executorAddress: Address;
    flashPool: Address;
    swapPath: Hex;
  } | null {
    if (!config.route) {
      warnOnce("Flash-arb route config missing for chain", `route:${ctx.chainName}`, ctx);
      return null;
    }

    const executorAddress = config.route.executorAddress || config.executorAddress;
    if (!executorAddress) {
      warnOnce("Flash-arb executor address missing for chain", `executor:${ctx.chainName}`, ctx);
      return null;
    }

    const flashPool = config.route.flashLoanPools[ctx.poolState.quoteTokenSymbol];
    if (!flashPool) {
      warnOnce(
        "Flash-arb flash pool missing for quote token",
        `flashPool:${ctx.chainName}:${ctx.poolState.quoteTokenSymbol}`,
        ctx,
      );
      return null;
    }

    const swapPath = config.route.quoteToAjnaPaths[ctx.poolState.quoteTokenSymbol];
    if (!swapPath) {
      warnOnce(
        "Flash-arb swap path missing for quote token",
        `path:${ctx.chainName}:${ctx.poolState.quoteTokenSymbol}`,
        ctx,
      );
      return null;
    }

    return { executorAddress, flashPool, swapPath };
  }

  async function evaluateCandidate(
    ctx: AuctionContext,
  ): Promise<FlashArbCandidate | null> {
    const key = getContextKey(ctx);
    if (lastCandidate?.key === key) {
      return lastCandidate.candidate;
    }

    if (!ctx.poolState.hasActiveAuction || ctx.auctionPrice === 0n) {
      lastCandidate = { key, candidate: null };
      return null;
    }

    const route = resolveRoute(ctx);
    if (!route) {
      lastCandidate = { key, candidate: null };
      return null;
    }

    if (!config.dexQuoter) {
      warnOnce("Flash-arb quoter not configured for chain", `quoter:${ctx.chainName}`, ctx);
      lastCandidate = { key, candidate: null };
      return null;
    }

    const quoteAmount = normalizeReserveTakeAmount(
      ctx.poolState.claimableReservesRemaining,
      ctx.poolState.quoteTokenScale,
    );
    if (quoteAmount === 0n) {
      lastCandidate = { key, candidate: null };
      return null;
    }

    const liquidityUsd =
      Number(formatEther(quoteAmount)) * ctx.prices.quoteTokenPriceUsd;
    if (liquidityUsd < config.minLiquidityUsd) {
      lastCandidate = { key, candidate: null };
      return null;
    }

    const quote = await config.dexQuoter.quoteQuoteToAjna(
      ctx.poolState.quoteTokenSymbol,
      quoteAmount,
      ctx.poolState.quoteTokenScale,
      ctx.prices,
    );
    if (!quote) {
      lastCandidate = { key, candidate: null };
      return null;
    }

    if (quote.slippagePercent > config.maxSlippagePercent) {
      logger.debug("Flash-arb candidate rejected for slippage", {
        chain: ctx.chainName,
        pool: ctx.poolState.pool,
        slippagePercent: quote.slippagePercent.toFixed(2),
        maxSlippagePercent: config.maxSlippagePercent,
      });
      lastCandidate = { key, candidate: null };
      return null;
    }

    const borrowAmount = calculateReserveTakeAjnaCost(
      quoteAmount,
      ctx.auctionPrice,
    );
    if (borrowAmount === 0n) {
      lastCandidate = { key, candidate: null };
      return null;
    }

    const flashFeePpm = await getFlashPoolFeePpm(route.flashPool);
    const repayAmount = borrowAmount + calculateFlashFee(borrowAmount, flashFeePpm);
    const minAjnaOut = applySlippageFloor(quote.amountOut);

    if (minAjnaOut <= repayAmount) {
      logger.debug("Flash-arb candidate rejected after flash fee and slippage floor", {
        chain: ctx.chainName,
        pool: ctx.poolState.pool,
        borrowAmount: formatEther(borrowAmount),
        repayAmount: formatEther(repayAmount),
        minAjnaOut: formatEther(minAjnaOut),
      });
      lastCandidate = { key, candidate: null };
      return null;
    }

    const estimatedProfitAjna = minAjnaOut - repayAmount;
    const estimatedProfitUsd =
      Number(formatEther(estimatedProfitAjna)) * ctx.prices.ajnaPriceUsd;
    if (estimatedProfitUsd < config.minProfitUsd) {
      lastCandidate = { key, candidate: null };
      return null;
    }

    const candidate = {
      executorAddress: route.executorAddress,
      flashPool: route.flashPool,
      quoteAmount,
      borrowAmount,
      repayAmount,
      minAjnaOut,
      quotedAjnaOut: quote.amountOut,
      swapPath: route.swapPath,
      estimatedProfitUsd,
      liquidityUsd,
      slippagePercent: quote.slippagePercent,
    };

    lastCandidate = { key, candidate };
    return candidate;
  }

  return {
    name: "flash-arb",

    async canExecute(ctx: AuctionContext): Promise<boolean> {
      const candidate = await evaluateCandidate(ctx);
      if (!candidate) {
        return false;
      }

      logger.info("Flash-arb candidate ready", {
        chain: ctx.chainName,
        pool: ctx.poolState.pool,
        executorAddress: candidate.executorAddress,
        flashPool: candidate.flashPool,
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
      const candidate = await evaluateCandidate(ctx);
      if (!candidate) {
        throw new Error(
          "Flash-arb opportunity is no longer executable or the route is misconfigured.",
        );
      }

      const args = [{
        flashPool: candidate.flashPool,
        ajnaPool: ctx.poolState.pool,
        borrowAmount: candidate.borrowAmount,
        quoteAmount: candidate.quoteAmount,
        swapPath: candidate.swapPath,
        minAjnaOut: candidate.minAjnaOut,
        profitRecipient: walletAddress,
      }] as const;

      logger.info("Executing flash-arb via executor", {
        chain: ctx.chainName,
        pool: ctx.poolState.pool,
        executorAddress: candidate.executorAddress,
        flashPool: candidate.flashPool,
        quoteAmount: formatEther(candidate.quoteAmount),
        borrowAmount: formatEther(candidate.borrowAmount),
        minAjnaOut: formatEther(candidate.minAjnaOut),
        dryRun: config.dryRun,
      });

      if (config.dryRun) {
        await publicClient.simulateContract({
          address: candidate.executorAddress,
          abi: FLASH_ARB_EXECUTOR_ABI,
          functionName: "executeFlashArb",
          args,
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
        abi: FLASH_ARB_EXECUTOR_ABI,
        functionName: "executeFlashArb",
        args,
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
      const candidate = await evaluateCandidate(ctx);
      return candidate?.estimatedProfitUsd ?? 0;
    },

    async estimateKickProfit(ctx: KickContext): Promise<number> {
      const route = resolveRoute(ctx);
      if (!route || !config.dexQuoter) return 0;
      if (config.minProfitUsd <= 0) return 0;
      if (ctx.prices.ajnaPriceUsd <= 0) return 0;

      const quoteAmount = normalizeReserveTakeAmount(
        ctx.poolState.claimableReserves,
        ctx.poolState.quoteTokenScale,
      );
      if (quoteAmount === 0n) return 0;

      const liquidityUsd =
        Number(formatEther(quoteAmount)) * ctx.prices.quoteTokenPriceUsd;
      if (liquidityUsd < config.minLiquidityUsd) return 0;

      const quote = await config.dexQuoter.quoteQuoteToAjna(
        ctx.poolState.quoteTokenSymbol,
        quoteAmount,
        ctx.poolState.quoteTokenScale,
        ctx.prices,
      );
      if (!quote) return 0;
      if (quote.slippagePercent > config.maxSlippagePercent) return 0;

      const flashFeePpm = await getFlashPoolFeePpm(route.flashPool);
      const minAjnaOut = applySlippageFloor(quote.amountOut);
      const minAjnaOutFloat = Number(formatEther(minAjnaOut));
      const minProfitAjna = config.minProfitUsd / ctx.prices.ajnaPriceUsd;
      const flashFeeMultiplier = 1 + Number(flashFeePpm) / Number(UNISWAP_FEE_DENOMINATOR);
      const maxBorrowAjna = (minAjnaOutFloat - minProfitAjna) / flashFeeMultiplier;
      if (maxBorrowAjna <= 0) return 0;

      return config.minProfitUsd;
    },
  };
}
