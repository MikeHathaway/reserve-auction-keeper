import type { Hex, PublicClient } from "viem";
import type { PendingSubmission, SubmissionResult } from "./mev-submitter.js";
import { getErrorMessage } from "../utils/retry.js";

const DEFAULT_BLOCK_TIME_MS = 12_000;
const MIN_RECEIPT_TIMEOUT_MS = 60_000;
const RECEIPT_CONFIRMATION_BLOCKS = 10;

export class PendingSubmissionError extends Error {
  readonly pendingSubmission: PendingSubmission;

  constructor(pendingSubmission: PendingSubmission, message: string) {
    super(message);
    this.name = "PendingSubmissionError";
    this.pendingSubmission = pendingSubmission;
  }
}

interface WaitForConfirmedReceiptOptions {
  timeoutMs?: number;
  submission?: SubmissionResult;
}

export function createPendingSubmission(
  txHash: Hex,
  label: string,
  submission?: SubmissionResult,
): PendingSubmission {
  return {
    txHash,
    label,
    mode: submission?.mode,
    bundleHash: submission?.bundleHash,
    targetBlock: submission?.targetBlock,
    privateSubmission: submission?.privateSubmission,
  };
}

export function createPendingSubmissionError(
  pendingSubmission: PendingSubmission,
  message: string,
): PendingSubmissionError {
  return new PendingSubmissionError(pendingSubmission, message);
}

function getReceiptTimeoutMs(publicClient: PublicClient): number {
  const blockTimeMs = publicClient.chain?.blockTime ?? DEFAULT_BLOCK_TIME_MS;
  return Math.max(
    MIN_RECEIPT_TIMEOUT_MS,
    blockTimeMs * RECEIPT_CONFIRMATION_BLOCKS,
  );
}

export async function waitForConfirmedReceipt(
  publicClient: PublicClient,
  txHash: Hex,
  label: string,
  options: WaitForConfirmedReceiptOptions = {},
): Promise<Awaited<ReturnType<PublicClient["waitForTransactionReceipt"]>>> {
  const {
    timeoutMs = getReceiptTimeoutMs(publicClient),
    submission,
  } = options;

  try {
    return await publicClient.waitForTransactionReceipt({
      hash: txHash,
      timeout: timeoutMs,
    });
  } catch (error) {
    throw createPendingSubmissionError(
      createPendingSubmission(txHash, label, submission),
      `Failed while waiting for ${label} receipt ${txHash}: ${getErrorMessage(error)}`,
    );
  }
}
