import type { Address, Hex } from "viem";
import type { PoolReserveState } from "../auction/discovery.js";
import type { PriceData } from "../pricing/oracle.js";
import type { RealizedExecutionSettlement } from "../execution/settlement.js";

export interface AuctionContext {
  poolState: PoolReserveState;
  auctionPrice: bigint;
  prices: PriceData;
  chainName: string;
}

export interface KickContext {
  poolState: PoolReserveState;
  prices: PriceData;
  chainName: string;
}

export interface TxResult {
  submissionMode: "dry-run" | "private-rpc" | "flashbots";
  txHash?: Hex;
  bundleHash?: string;
  targetBlock?: bigint;
  privateSubmission: boolean;
  pool: Address;
  amountQuoteReceived: bigint;
  ajnaCost: bigint;
  profitUsd: number;
  realized?: RealizedExecutionSettlement;
  chain: string;
}

export interface ExecutionStrategy {
  readonly name: string;

  /** Check if this strategy can and should execute on the given auction. */
  canExecute(ctx: AuctionContext): Promise<boolean>;

  /** Execute the strategy. Returns the transaction result. */
  execute(ctx: AuctionContext): Promise<TxResult>;

  /** Estimate the total profit in USD for this auction opportunity. */
  estimateProfit(ctx: AuctionContext): Promise<number>;

  /**
   * Estimate the strategy's best-case future profit in USD if this pool is kicked now,
   * excluding the kick transaction gas itself.
   */
  estimateKickProfit(ctx: KickContext): Promise<number>;
}
