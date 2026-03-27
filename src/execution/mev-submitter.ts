import type { Address, Hex, Abi } from "viem";

export interface SubmitRequest {
  to: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  account: Address;
}

export interface MevSubmitter {
  readonly name: string;

  /** Submit a transaction with MEV protection. Returns tx hash. */
  submit(request: SubmitRequest): Promise<Hex>;

  /** Check if the submission endpoint is healthy. */
  isHealthy(): Promise<boolean>;
}
