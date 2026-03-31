import {
  type PublicClient,
  type WalletClient,
  createPublicClient,
  http,
  encodeFunctionData,
} from "viem";
import type { MevSubmitter, SubmitRequest } from "./mev-submitter.js";
import { logger } from "../utils/logger.js";
import { isTransientRpcError, retryAsync } from "../utils/retry.js";

/**
 * Private RPC submitter for L2 chains (Base).
 * Sends transactions to a private/sequencer RPC endpoint to avoid the public mempool.
 */
export function createPrivateRpcSubmitter(
  publicClient: PublicClient,
  walletClient: WalletClient,
  privateRpcUrl?: string,
): MevSubmitter {
  const effectiveUrl = privateRpcUrl;

  if (!effectiveUrl) {
    logger.warn(
      "No private RPC URL configured. Live private-rpc submission is disabled.",
    );
  }

  return {
    name: "private-rpc",
    supportsLiveSubmission: !!effectiveUrl,

    async submit(request: SubmitRequest) {
      if (!effectiveUrl) {
        throw new Error(
          "Private RPC URL is required for live private-rpc submission.",
        );
      }

      // Health check before submitting
      const healthy = await this.isHealthy();
      if (!healthy) {
        logger.alert(
          "Private RPC is unhealthy. Aborting transaction to avoid public mempool exposure.",
          { privateRpcUrl: effectiveUrl },
        );
        throw new Error("Private RPC unhealthy, aborting to protect against MEV");
      }

      const calldata = encodeFunctionData({
        abi: request.abi,
        functionName: request.functionName,
        args: request.args,
      });

      const hash = await retryAsync(
        () =>
          walletClient.sendTransaction({
            to: request.to,
            data: calldata,
            chain: publicClient.chain,
            account: walletClient.account!,
          }),
        {
          label: `private-rpc.submit.${request.functionName}`,
          shouldRetry: isTransientRpcError,
        },
      );

      logger.info("Transaction submitted via private RPC", {
        hash,
        to: request.to,
        privateRpc: !!effectiveUrl,
      });

      return {
        mode: "private-rpc" as const,
        txHash: hash,
        privateSubmission: !!effectiveUrl,
        relayUrl: effectiveUrl,
      };
    },

    async isHealthy(): Promise<boolean> {
      if (!effectiveUrl) return false;

      try {
        const testClient = createPublicClient({
          transport: http(effectiveUrl),
        });
        await retryAsync(
          () => testClient.getBlockNumber(),
          {
            label: "private-rpc.health-check",
            shouldRetry: isTransientRpcError,
          },
        );
        return true;
      } catch {
        return false;
      }
    },
  };
}
