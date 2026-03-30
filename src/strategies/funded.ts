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

  async function getAjnaBalance(): Promise<bigint> {
    return publicClient.readContract({
      address: ajnaToken,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [walletAddress],
    });
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

      if (!poolState.hasActiveAuction) return false;
      if (auctionPrice === 0n) return false;

      // Check wallet balance
      const balance = await getAjnaBalance();
      if (balance === 0n) {
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
      const balance = await getAjnaBalance();

      // amount = min(walletBalance / auctionPrice, unclaimed, maxTakeAmount)
      // amount is in quote tokens. AJNA cost = amount * auctionPrice (in WAD terms)
      const maxFromBalance = (balance * parseEther("1")) / auctionPrice;
      let amount = maxFromBalance < poolState.claimableReservesRemaining
        ? maxFromBalance
        : poolState.claimableReservesRemaining;

      if (config.maxTakeAmount && amount > config.maxTakeAmount) {
        amount = config.maxTakeAmount;
      }

      if (amount === 0n) {
        throw new Error("Calculated take amount is 0");
      }

      const ajnaCost = (amount * auctionPrice) / parseEther("1");

      // Ensure approval
      await ensureApproval(poolState.pool, ajnaCost);

      logger.info("Executing takeReserves", {
        pool: poolState.pool,
        chain: ctx.chainName,
        quoteAmount: formatEther(amount),
        ajnaCost: formatEther(ajnaCost),
        dryRun: config.dryRun,
      });

      if (config.dryRun) {
        // Simulate only
        await publicClient.simulateContract({
          address: poolState.pool,
          abi: POOL_ABI,
          functionName: "takeReserves",
          args: [amount],
          account: walletAddress,
        });

        logger.info("DRY RUN: takeReserves simulation succeeded", {
          pool: poolState.pool,
          chain: ctx.chainName,
          quoteAmount: formatEther(amount),
          ajnaCost: formatEther(ajnaCost),
        });

        return {
          submissionMode: "dry-run",
          privateSubmission: false,
          pool: poolState.pool,
          amountQuoteReceived: amount,
          ajnaCost,
          profitUsd: this.estimateProfit(ctx),
          chain: ctx.chainName,
        };
      }

      // Real execution via MEV-protected submission
      const submission = await submitter.submit({
        to: poolState.pool,
        abi: POOL_ABI,
        functionName: "takeReserves",
        args: [amount],
        account: walletAddress,
      });

      logger.info("takeReserves submitted", {
        pool: poolState.pool,
        chain: ctx.chainName,
        submissionMode: submission.mode,
        txHash: submission.txHash,
        bundleHash: submission.bundleHash,
        targetBlock: submission.targetBlock?.toString(),
        quoteAmount: formatEther(amount),
        ajnaCost: formatEther(ajnaCost),
      });

      return {
        submissionMode: submission.mode,
        txHash: submission.txHash,
        bundleHash: submission.bundleHash,
        targetBlock: submission.targetBlock,
        privateSubmission: submission.privateSubmission,
        pool: poolState.pool,
        amountQuoteReceived: amount,
        ajnaCost,
        profitUsd: this.estimateProfit(ctx),
        chain: ctx.chainName,
      };
    },

    estimateProfit(ctx: AuctionContext): number {
      const { auctionPrice, prices } = ctx;
      const auctionPriceFloat = Number(formatEther(auctionPrice));
      if (auctionPriceFloat === 0) return 0;

      // Value received per AJNA spent (in USD)
      const valuePerAjna = prices.quoteTokenPriceUsd / auctionPriceFloat;
      // Cost per AJNA (in USD)
      const costPerAjna = prices.ajnaPriceUsd;
      // Profit per AJNA
      return valuePerAjna - costPerAjna;
    },
  };
}
