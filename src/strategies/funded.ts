import {
  type PublicClient,
  type WalletClient,
  type Address,
  formatEther,
  parseEther,
  getContract,
} from "viem";
import type { ExecutionStrategy, AuctionContext, TxResult } from "./interface.js";
import type { MevSubmitter } from "../execution/mev-submitter.js";
import { POOL_ABI } from "../contracts/abis/index.js";
import { logger } from "../utils/logger.js";

interface FundedStrategyConfig {
  targetExitPriceUsd: number;
  maxTakeAmount?: bigint;
  autoApprove: boolean;
  profitMarginPercent: number;
  dryRun: boolean;
}

interface FundedExecutionPlan {
  amount: bigint;
  ajnaCost: bigint;
  profitUsd: number;
}

const ERC20_ABI = [
  {
    inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }],
    name: "allowance",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
    name: "approve",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export function createFundedStrategy(
  publicClient: PublicClient,
  walletClient: WalletClient,
  ajnaToken: Address,
  submitter: MevSubmitter,
  config: FundedStrategyConfig,
): ExecutionStrategy {
  const walletAddress = walletClient.account!.address;
  let lastPlan: { key: string; plan: FundedExecutionPlan | null } | null = null;

  async function getAjnaBalance(): Promise<bigint> {
    return publicClient.readContract({
      address: ajnaToken,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [walletAddress],
    });
  }

  function getContextKey(ctx: AuctionContext): string {
    return [
      ctx.chainName,
      ctx.poolState.pool,
      ctx.poolState.claimableReservesRemaining.toString(),
      ctx.auctionPrice.toString(),
      ctx.prices.quoteTokenPriceUsd.toString(),
      ctx.prices.ajnaPriceUsd.toString(),
    ].join(":");
  }

  async function getExecutionPlan(
    ctx: AuctionContext,
  ): Promise<FundedExecutionPlan | null> {
    const key = getContextKey(ctx);
    if (lastPlan?.key === key) {
      return lastPlan.plan;
    }

    if (!ctx.poolState.hasActiveAuction || ctx.auctionPrice === 0n) {
      lastPlan = { key, plan: null };
      return null;
    }

    const balance = await getAjnaBalance();
    if (balance === 0n) {
      lastPlan = { key, plan: null };
      return null;
    }

    const maxFromBalance = (balance * parseEther("1")) / ctx.auctionPrice;
    let amount = maxFromBalance < ctx.poolState.claimableReservesRemaining
      ? maxFromBalance
      : ctx.poolState.claimableReservesRemaining;

    if (config.maxTakeAmount && amount > config.maxTakeAmount) {
      amount = config.maxTakeAmount;
    }

    if (amount === 0n) {
      lastPlan = { key, plan: null };
      return null;
    }

    const ajnaCost = (amount * ctx.auctionPrice) / parseEther("1");
    const quoteValueUsd =
      Number(formatEther(amount)) * ctx.prices.quoteTokenPriceUsd;
    const ajnaCostUsd =
      Number(formatEther(ajnaCost)) * ctx.prices.ajnaPriceUsd;

    const plan = {
      amount,
      ajnaCost,
      profitUsd: quoteValueUsd - ajnaCostUsd,
    };

    lastPlan = { key, plan };
    return plan;
  }

  async function ensureApproval(pool: Address, amount: bigint): Promise<void> {
    const allowance = await publicClient.readContract({
      address: ajnaToken,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [walletAddress, pool],
    });

    if (allowance >= amount) return;

    if (!config.autoApprove) {
      logger.alert("Insufficient AJNA allowance for pool, auto-approve disabled", {
        pool,
        required: formatEther(amount),
        current: formatEther(allowance),
      });
      throw new Error(`Insufficient allowance for pool ${pool}. Set autoApprove: true or approve manually.`);
    }

    logger.info("Approving AJNA spend for pool", {
      pool,
      amount: formatEther(amount),
    });

    const hash = await walletClient.writeContract({
      address: ajnaToken,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [pool, amount],
      chain: publicClient.chain,
      account: walletClient.account!,
    });

    await publicClient.waitForTransactionReceipt({ hash });
    logger.info("AJNA approval confirmed", { pool, hash });
  }

  return {
    name: "funded",

    async canExecute(ctx: AuctionContext): Promise<boolean> {
      const { poolState, auctionPrice, prices } = ctx;
      const plan = await getExecutionPlan(ctx);

      if (!poolState.hasActiveAuction) return false;
      if (auctionPrice === 0n) return false;

      if (!plan) {
        logger.debug("Wallet has no AJNA balance", { chain: ctx.chainName });
        return false;
      }

      // The auctionPrice is AJNA per quote token (high at start, decays over time).
      // We want to sell AJNA when 1 AJNA buys >= targetExitPriceUsd worth of quote tokens.
      // Value of quote tokens received per AJNA spent = quoteTokenPriceUsd / auctionPrice
      // So: quoteTokenPriceUsd / auctionPrice >= targetExitPriceUsd
      const auctionPriceFloat = Number(formatEther(auctionPrice));
      if (auctionPriceFloat === 0) return false;

      const valuePerAjna = prices.quoteTokenPriceUsd / auctionPriceFloat;
      const meetsTarget = valuePerAjna >= config.targetExitPriceUsd;

      if (meetsTarget) {
        logger.info("Auction price meets target", {
          pool: poolState.pool,
          chain: ctx.chainName,
          valuePerAjna: valuePerAjna.toFixed(4),
          target: config.targetExitPriceUsd,
          auctionPrice: auctionPriceFloat.toFixed(6),
        });
      }

      return meetsTarget;
    },

    async execute(ctx: AuctionContext): Promise<TxResult> {
      const { poolState, auctionPrice, prices } = ctx;
      const plan = await getExecutionPlan(ctx);
      if (!plan) {
        throw new Error("Calculated take amount is 0");
      }

      // Ensure approval
      await ensureApproval(poolState.pool, plan.ajnaCost);

      logger.info("Executing takeReserves", {
        pool: poolState.pool,
        chain: ctx.chainName,
        quoteAmount: formatEther(plan.amount),
        ajnaCost: formatEther(plan.ajnaCost),
        dryRun: config.dryRun,
      });

      if (config.dryRun) {
        // Simulate only
        await publicClient.simulateContract({
          address: poolState.pool,
          abi: POOL_ABI,
          functionName: "takeReserves",
          args: [plan.amount],
          account: walletAddress,
        });

        logger.info("DRY RUN: takeReserves simulation succeeded", {
          pool: poolState.pool,
          chain: ctx.chainName,
          quoteAmount: formatEther(plan.amount),
          ajnaCost: formatEther(plan.ajnaCost),
        });

        return {
          submissionMode: "dry-run",
          privateSubmission: false,
          pool: poolState.pool,
          amountQuoteReceived: plan.amount,
          ajnaCost: plan.ajnaCost,
          profitUsd: plan.profitUsd,
          chain: ctx.chainName,
        };
      }

      // Real execution via MEV-protected submission
      const submission = await submitter.submit({
        to: poolState.pool,
        abi: POOL_ABI,
        functionName: "takeReserves",
        args: [plan.amount],
        account: walletAddress,
      });

      logger.info("takeReserves submitted", {
        pool: poolState.pool,
        chain: ctx.chainName,
        submissionMode: submission.mode,
        txHash: submission.txHash,
        bundleHash: submission.bundleHash,
        targetBlock: submission.targetBlock?.toString(),
        quoteAmount: formatEther(plan.amount),
        ajnaCost: formatEther(plan.ajnaCost),
      });

      return {
        submissionMode: submission.mode,
        txHash: submission.txHash,
        bundleHash: submission.bundleHash,
        targetBlock: submission.targetBlock,
        privateSubmission: submission.privateSubmission,
        pool: poolState.pool,
        amountQuoteReceived: plan.amount,
        ajnaCost: plan.ajnaCost,
        profitUsd: plan.profitUsd,
        chain: ctx.chainName,
      };
    },

    async estimateProfit(ctx: AuctionContext): Promise<number> {
      const plan = await getExecutionPlan(ctx);
      return plan?.profitUsd ?? 0;
    },
  };
}
