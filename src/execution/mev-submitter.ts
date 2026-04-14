import type { Address, Hex, Abi } from "viem";
import type { FeeCapOverrides } from "./gas.js";

export interface SubmitRequest {
  to: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  account: Address;
  gasPriceWei?: bigint;
  feeCapOverrides?: FeeCapOverrides;
}

export interface SubmissionResult {
  mode: "private-rpc" | "flashbots";
  txHash?: Hex;
  bundleHash?: string;
  targetBlock?: bigint;
  privateSubmission: boolean;
  account?: Address;
  nonce?: bigint;
  submittedAtMs?: number;
}

export interface PendingSubmission {
  txHash: Hex;
  label: string;
  mode?: SubmissionResult["mode"];
  bundleHash?: string;
  targetBlock?: bigint;
  privateSubmission?: boolean;
  account?: Address;
  nonce?: bigint;
  submittedAtMs?: number;
}

export interface MevSubmitter {
  readonly name: string;
  readonly supportsLiveSubmission: boolean;

  /** Submit a transaction with MEV protection. */
  submit(request: SubmitRequest): Promise<SubmissionResult>;

  /**
   * Check if the submission endpoint is healthy.
   * Implementations should keep this cheap on the common path and only
   * revalidate active write capability on bounded intervals.
   */
  isHealthy(): Promise<boolean>;

  /**
   * Perform any one-time live-submission capability checks required before startup.
   * Implementations should avoid invoking this on every runtime health refresh.
   */
  preflightLiveSubmissionReadiness?(): Promise<boolean>;
}
