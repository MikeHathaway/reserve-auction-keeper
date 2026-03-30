import { formatEther } from "viem";
import type { AuctionContext, ExecutionStrategy } from "./interface.js";
import { logger } from "../utils/logger.js";
import type { DexQuoter } from "../pricing/uniswap-v3.js";

interface FlashArbStrategyConfig {
  maxSlippagePercent: number;
  minLiquidityUsd: number;
  minProfitUsd: number;
  executorAddress?: string;
  dryRun: boolean;
  dexQuoter?: DexQuoter;
}

export function createFlashArbStrategy(
  config: FlashArbStrategyConfig,
): ExecutionStrategy {
  let warnedUnsupported = false;

  function warnUnsupported(ctx: AuctionContext) {
    if (warnedUnsupported) return;
    warnedUnsupported = true;

    logger.alert("Flash-arb strategy is scaffolded but not live yet", {
      chain: ctx.chainName,
      pool: ctx.poolState.pool,
      executorAddress: config.executorAddress,
      dryRun: config.dryRun,
    });
  }

  return {
    name: "flash-arb",

    async canExecute(ctx: AuctionContext): Promise<boolean> {
      if (!ctx.poolState.hasActiveAuction || ctx.auctionPrice === 0n) {
        return false;
      }

      const quoteAmount = Number(formatEther(ctx.poolState.claimableReservesRemaining));
      const liquidityUsd = quoteAmount * ctx.prices.quoteTokenPriceUsd;

      if (liquidityUsd < config.minLiquidityUsd) {
        return false;
      }

      if (!config.dexQuoter) {
        logger.debug("Flash-arb quoter not configured for chain", {
          chain: ctx.chainName,
          pool: ctx.poolState.pool,
        });
        return false;
      }

      const quote = await config.dexQuoter.quoteQuoteToAjna(
        ctx.poolState.quoteTokenSymbol,
        ctx.poolState.claimableReservesRemaining,
        ctx.prices,
      );
      if (!quote) {
        return false;
      }

      if (quote.slippagePercent > config.maxSlippagePercent) {
        logger.debug("Flash-arb candidate rejected for slippage", {
          chain: ctx.chainName,
          pool: ctx.poolState.pool,
          slippagePercent: quote.slippagePercent.toFixed(2),
          maxSlippagePercent: config.maxSlippagePercent,
        });
        return false;
      }

      const auctionPriceFloat = Number(formatEther(ctx.auctionPrice));
      const ajnaCost = quoteAmount * auctionPriceFloat;
      const profitAjna = quote.actualAmountOut - ajnaCost;
      const profitUsd = profitAjna * ctx.prices.ajnaPriceUsd;

      if (profitUsd < config.minProfitUsd) {
        return false;
      }

      warnUnsupported(ctx);
      logger.info("Flash-arb candidate identified in scaffold mode", {
        chain: ctx.chainName,
        pool: ctx.poolState.pool,
        estimatedProfitUsd: profitUsd.toFixed(4),
        liquidityUsd: liquidityUsd.toFixed(2),
        slippagePercent: quote.slippagePercent.toFixed(2),
        maxSlippagePercent: config.maxSlippagePercent,
        minLiquidityUsd: config.minLiquidityUsd,
      });

      return false;
    },

    async execute(ctx: AuctionContext) {
      warnUnsupported(ctx);
      throw new Error(
        "Flash-arb execution is not implemented yet. The current scaffold supports monitoring only.",
      );
    },

    estimateProfit(ctx: AuctionContext): number {
      const auctionPriceFloat = Number(formatEther(ctx.auctionPrice));
      if (!Number.isFinite(auctionPriceFloat) || auctionPriceFloat <= 0) {
        return 0;
      }

      const grossQuoteValuePerAjna =
        ctx.prices.quoteTokenPriceUsd / auctionPriceFloat;
      const slippagePenaltyUsd =
        grossQuoteValuePerAjna * (config.maxSlippagePercent / 100);

      return grossQuoteValuePerAjna - ctx.prices.ajnaPriceUsd - slippagePenaltyUsd;
    },
  };
}
