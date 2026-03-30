import type { Address, Hex, Abi } from "viem";

export interface SubmitRequest {
  to: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  account: Address;
}

export interface SubmissionResult {
  mode: "private-rpc" | "flashbots";
  txHash?: Hex;
  bundleHash?: string;
  targetBlock?: bigint;
  privateSubmission: boolean;
  relayUrl?: string;
}

export interface MevSubmitter {
  readonly name: string;
  readonly supportsLiveSubmission: boolean;

  /** Submit a transaction with MEV protection. */
  submit(request: SubmitRequest): Promise<SubmissionResult>;

  /** Check if the submission endpoint is healthy. */
  isHealthy(): Promise<boolean>;
}
