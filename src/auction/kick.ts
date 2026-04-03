import type { Address, Hex, PublicClient } from "viem";
import type { MevSubmitter, SubmissionResult } from "../execution/mev-submitter.js";
import { POOL_ABI } from "../contracts/abis/index.js";

export interface KickAuctionResult extends SubmissionResult {
  receiptBlockNumber: bigint;
}

export async function kickReserveAuction(
  publicClient: PublicClient,
  submitter: MevSubmitter,
  walletAddress: Address,
  pool: Address,
): Promise<KickAuctionResult> {
  const submission = await submitter.submit({
    to: pool,
    abi: POOL_ABI,
    functionName: "kickReserveAuction",
    args: [],
    account: walletAddress,
  });

  if (!submission.txHash) {
    throw new Error(
      `kickReserveAuction submission via ${submitter.name} did not return a transaction hash.`,
    );
  }

  const receipt = await publicClient.waitForTransactionReceipt({
    hash: submission.txHash,
  });

  if (receipt.status !== "success") {
    throw new Error(`kickReserveAuction transaction ${submission.txHash} reverted on-chain.`);
  }

  return {
    ...submission,
    txHash: submission.txHash as Hex,
    receiptBlockNumber: receipt.blockNumber,
  };
}
