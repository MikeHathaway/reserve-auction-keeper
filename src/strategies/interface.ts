import type { Address, Hex } from "viem";
import type { PoolReserveState } from "../auction/discovery.js";
import type { PriceData } from "../pricing/oracle.js";
import type { RealizedExecutionSettlement } from "../execution/settlement.js";
import type { FeeCapOverrides } from "../execution/gas.js";

export interface AuctionContext {
  poolState: PoolReserveState;
  auctionPrice: bigint;
  prices: PriceData;
  chainName: string;
  gasPriceWei?: bigint;
  feeCapOverrides?: FeeCapOverrides;
}

export interface KickContext {
  poolState: PoolReserveState;
  prices: PriceData;
  chainName: string;
  gasPriceWei?: bigint;
  feeCapOverrides?: FeeCapOverrides;
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
   * Estimate a conservative future trade profit in USD if this pool is kicked now,
   * before any gas costs are applied.
   */
  estimateKickProfit(ctx: KickContext): Promise<number>;

  /**
   * Estimate any strategy-specific execution gas on top of the keeper's shared
   * transaction baseline for an active auction.
   */
  estimateAdditionalExecutionGasUnits?(ctx: AuctionContext): Promise<bigint>;

  /**
   * Estimate any strategy-specific future execution gas on top of the keeper's
   * shared transaction baseline if a reserve auction is kicked now.
   */
  estimateAdditionalKickExecutionGasUnits?(ctx: KickContext): Promise<bigint>;
}
