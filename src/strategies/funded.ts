import {
  type PublicClient,
  type WalletClient,
  type Address,
  formatEther,
  parseEther,
} from "viem";
import type { ExecutionStrategy, AuctionContext, TxResult } from "./interface.js";
import type { MevSubmitter } from "../execution/mev-submitter.js";
import { POOL_ABI } from "../contracts/abis/index.js";
import {
  calculateReserveTakeAjnaCost,
  normalizeReserveTakeAmount,
} from "../auction/math.js";
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
  let lastPlan:
    | { key: string; balance: bigint; plan: FundedExecutionPlan | null }
    | null = null;

  async function getAjnaBalance(): Promise<bigint> {
    return publicClient.readContract({
      address: ajnaToken,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [walletAddress],
    });
  }

  async function getAllowance(pool: Address): Promise<bigint> {
    return publicClient.readContract({
      address: ajnaToken,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [walletAddress, pool],
    });
  }

  async function canSatisfyAllowance(
    pool: Address,
    amount: bigint,
  ): Promise<boolean> {
    const allowance = await getAllowance(pool);
    if (allowance >= amount) return true;

    if (config.autoApprove && !config.dryRun) {
      return true;
    }

    logger.debug("Skipping funded execution due to insufficient allowance", {
      pool,
      required: formatEther(amount),
      current: formatEther(allowance),
      autoApprove: config.autoApprove,
      dryRun: config.dryRun,
    });
    return false;
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
    const balance = await getAjnaBalance();
    if (lastPlan?.key === key && lastPlan.balance === balance) {
      return lastPlan.plan;
    }

    if (!ctx.poolState.hasActiveAuction || ctx.auctionPrice === 0n) {
      lastPlan = { key, balance, plan: null };
      return null;
    }

    if (balance === 0n) {
      lastPlan = { key, balance, plan: null };
      return null;
    }

    const maxFromBalance = (balance * parseEther("1")) / ctx.auctionPrice;
    let amount = maxFromBalance < ctx.poolState.claimableReservesRemaining
      ? maxFromBalance
      : ctx.poolState.claimableReservesRemaining;

    if (config.maxTakeAmount && amount > config.maxTakeAmount) {
      amount = config.maxTakeAmount;
    }

    amount = normalizeReserveTakeAmount(amount, ctx.poolState.quoteTokenScale);

    if (amount === 0n) {
      lastPlan = { key, balance, plan: null };
      return null;
    }

    const ajnaCost = calculateReserveTakeAjnaCost(amount, ctx.auctionPrice);
    const quoteValueUsd =
      Number(formatEther(amount)) * ctx.prices.quoteTokenPriceUsd;
    const ajnaCostUsd =
      Number(formatEther(ajnaCost)) * ctx.prices.ajnaPriceUsd;

    const plan = {
      amount,
      ajnaCost,
      profitUsd: quoteValueUsd - ajnaCostUsd,
    };

    lastPlan = { key, balance, plan };
    return plan;
  }

  async function ensureApproval(pool: Address, amount: bigint): Promise<void> {
    const allowance = await getAllowance(pool);

    if (allowance >= amount) return;

    if (!config.autoApprove) {
      logger.alert("Insufficient AJNA allowance for pool, auto-approve disabled", {
        pool,
        required: formatEther(amount),
        current: formatEther(allowance),
      });
      throw new Error(`Insufficient allowance for pool ${pool}. Set autoApprove: true or approve manually.`);
    }

    if (config.dryRun) {
      logger.warn("Dry run cannot auto-approve missing allowance", {
        pool,
        required: formatEther(amount),
        current: formatEther(allowance),
      });
      throw new Error(
        `Insufficient allowance for pool ${pool}. Dry run cannot auto-approve; approve manually or disable dryRun.`,
      );
    }

    logger.info("Approving AJNA spend for pool", {
      pool,
      amount: formatEther(amount),
      submitter: submitter.name,
    });

    const submission = await submitter.submit({
      to: ajnaToken,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [pool, amount],
      account: walletAddress,
    });

    if (!submission.txHash) {
      throw new Error(
        `Approval submission via ${submitter.name} did not return a transaction hash.`,
      );
    }

    await publicClient.waitForTransactionReceipt({ hash: submission.txHash });
    logger.info("AJNA approval confirmed", {
      pool,
      txHash: submission.txHash,
      submissionMode: submission.mode,
      bundleHash: submission.bundleHash,
      targetBlock: submission.targetBlock?.toString(),
    });
  }

  return {
    name: "funded",

    async canExecute(ctx: AuctionContext): Promise<boolean> {
      const { poolState, auctionPrice, prices } = ctx;
      const plan = await getExecutionPlan(ctx);

      if (!poolState.hasActiveAuction) return false;
      if (auctionPrice === 0n) return false;

      if (!plan) {
        logger.debug("No executable funded plan for current auction", {
          chain: ctx.chainName,
          pool: poolState.pool,
        });
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

      if (!meetsTarget) return false;

      return canSatisfyAllowance(poolState.pool, plan.ajnaCost);
    },

    async execute(ctx: AuctionContext): Promise<TxResult> {
      const { poolState } = ctx;
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
