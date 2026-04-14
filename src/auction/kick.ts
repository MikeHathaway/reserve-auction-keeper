import { formatEther, type Address, type Hex, type PublicClient } from "viem";
import type { MevSubmitter, SubmissionResult } from "../execution/mev-submitter.js";
import type { FeeCapOverrides } from "../execution/gas.js";
import { waitForConfirmedReceipt } from "../execution/receipt.js";
import { POOL_ABI } from "../contracts/abis/index.js";

export interface KickAuctionResult extends SubmissionResult {
  receiptBlockNumber: bigint;
}

export function estimateKickClaimableValueUsd(
  claimableReserves: bigint,
  quoteTokenPriceUsd: number,
): number {
  return Number(formatEther(claimableReserves)) * quoteTokenPriceUsd;
}

export async function kickReserveAuction(
  publicClient: PublicClient,
  submitter: MevSubmitter,
  walletAddress: Address,
  pool: Address,
  gasPriceWei?: bigint,
  feeCapOverrides?: FeeCapOverrides,
): Promise<KickAuctionResult> {
  const submission = await submitter.submit({
    to: pool,
    abi: POOL_ABI,
    functionName: "kickReserveAuction",
    args: [],
    account: walletAddress,
    gasPriceWei,
    feeCapOverrides,
  });

  if (!submission.txHash) {
    throw new Error(
      `kickReserveAuction submission via ${submitter.name} did not return a transaction hash.`,
    );
  }

  const receipt = await waitForConfirmedReceipt(
    publicClient,
    submission.txHash,
    "kickReserveAuction",
    { submission },
  );

  if (receipt.status !== "success") {
    throw new Error(`kickReserveAuction transaction ${submission.txHash} reverted on-chain.`);
  }

  return {
    ...submission,
    txHash: submission.txHash as Hex,
    receiptBlockNumber: receipt.blockNumber,
  };
}
