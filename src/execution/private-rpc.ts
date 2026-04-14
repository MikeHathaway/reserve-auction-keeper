import {
  type PublicClient,
  type WalletClient,
  createPublicClient,
  http,
  encodeFunctionData,
} from "viem";
import type { MevSubmitter, SubmitRequest } from "./mev-submitter.js";
import { logger, redactUrlForLogs } from "../utils/logger.js";
import { isTransientRpcError, retryAsync } from "../utils/retry.js";
import { getEip1559FeeCapOverrides } from "./gas.js";

const DEFAULT_WRITE_PATH_HEALTHY_CACHE_MS = 60_000;
const DEFAULT_WRITE_PATH_FAILURE_RETRY_MS = 5_000;

interface PrivateRpcOptions {
  now?: () => number;
  writePathRevalidationIntervalMs?: number;
  writePathFailureRetryMs?: number;
}

function isExpectedRawTransactionProbeError(error: unknown): boolean {
  const message = String(error instanceof Error ? error.message : error).toLowerCase();
  return [
    "decode",
    "deserial",
    "invalid transaction",
    "rlp",
    "hex string",
    "unable to parse",
    "unable to decode",
    "malformed",
  ].some((fragment) => message.includes(fragment));
}

function isWritePathAvailabilityError(error: unknown): boolean {
  if (isTransientRpcError(error)) {
    return true;
  }

  const message = String(error instanceof Error ? error.message : error).toLowerCase();
  const nonEndpointFailureMarkers = [
    "insufficient funds",
    "nonce too low",
    "replacement transaction underpriced",
    "execution reverted",
    "revert",
    "user rejected",
    "denied",
    "already known",
    "intrinsic gas too low",
    "max fee per gas less than block base fee",
    "fee cap less than block base fee",
    "tip above fee cap",
    "invalid sender",
    "invalid nonce",
    "chain id",
  ];

  if (nonEndpointFailureMarkers.some((fragment) => message.includes(fragment))) {
    return false;
  }

  return [
    "500",
    "internal error",
    "internal server error",
    "upstream",
    "bad gateway",
    "403",
    "401",
    "forbidden",
    "unauthorized",
    "method not found",
    "method not supported",
    "unsupported method",
    "access denied",
  ].some((fragment) => message.includes(fragment));
}

/**
 * Private RPC submitter for L2 chains (Base).
 * Sends transactions to a private/sequencer RPC endpoint to avoid the public mempool.
 */
export function createPrivateRpcSubmitter(
  publicClient: PublicClient,
  walletClient: WalletClient,
  privateRpcUrl?: string,
  privateRpcTrusted: boolean = false,
  options: PrivateRpcOptions = {},
): MevSubmitter {
  const effectiveUrl = privateRpcUrl;
  const now = options.now || Date.now;
  const writePathHealthyCacheMs =
    options.writePathRevalidationIntervalMs ?? DEFAULT_WRITE_PATH_HEALTHY_CACHE_MS;
  const writePathFailureRetryMs =
    options.writePathFailureRetryMs ?? DEFAULT_WRITE_PATH_FAILURE_RETRY_MS;
  let lastWritePathProbeAt: number | null = null;
  let lastWritePathHealthy = false;

  if (!effectiveUrl) {
    logger.warn(
      "No private RPC URL configured. Live private-rpc submission is disabled.",
    );
  } else if (!privateRpcTrusted) {
    logger.warn(
      "Private RPC URL configured without explicit trust. Live private-rpc submission is disabled.",
      { privateRpcUrl: redactUrlForLogs(effectiveUrl) },
    );
  }

  function recordWritePathHealth(healthy: boolean) {
    lastWritePathProbeAt = now();
    lastWritePathHealthy = healthy;
  }

  function createHealthCheckClient() {
    return createPublicClient({
      chain: publicClient.chain,
      transport: http(effectiveUrl!),
    });
  }

  async function verifyReadPath(testClient: ReturnType<typeof createHealthCheckClient>) {
    await retryAsync(
      () => testClient.getBlockNumber(),
      {
        label: "private-rpc.health-check",
        shouldRetry: isTransientRpcError,
      },
    );
  }

  async function probeWritePath(
    testClient: ReturnType<typeof createHealthCheckClient>,
  ): Promise<void> {
    const requestCapableClient = testClient as typeof testClient & {
      request(args: {
        method: string;
        params?: unknown[];
      }): Promise<unknown>;
    };

    try {
      await requestCapableClient.request({
        method: "eth_sendRawTransaction",
        params: ["0x00"],
      });
    } catch (error) {
      if (isExpectedRawTransactionProbeError(error)) {
        return;
      }
      throw error;
    }
  }

  return {
    name: "private-rpc",
    supportsLiveSubmission: !!effectiveUrl && privateRpcTrusted,

    async submit(request: SubmitRequest) {
      if (!effectiveUrl) {
        throw new Error(
          "Private RPC URL is required for live private-rpc submission.",
        );
      }
      if (!privateRpcTrusted) {
        throw new Error(
          "privateRpcTrusted: true is required for live private-rpc submission.",
      );
    }

      // Health check before submitting
      const healthy = await this.isHealthy();
      if (!healthy) {
        logger.alert(
          "Private RPC is unhealthy. Aborting transaction to avoid public mempool exposure.",
          { privateRpcUrl: redactUrlForLogs(effectiveUrl) },
        );
        throw new Error("Private RPC unhealthy, aborting to protect against MEV");
      }

      const calldata = encodeFunctionData({
        abi: request.abi,
        functionName: request.functionName,
        args: request.args,
      });

      let hash;
      try {
        hash = await retryAsync(
          () =>
            walletClient.sendTransaction({
              to: request.to,
              data: calldata,
              chain: publicClient.chain,
              account: walletClient.account!,
              ...(request.feeCapOverrides ??
                getEip1559FeeCapOverrides(request.gasPriceWei) ??
                {}),
            }),
          {
            label: `private-rpc.submit.${request.functionName}`,
            shouldRetry: isTransientRpcError,
          },
        );
      } catch (error) {
        if (isWritePathAvailabilityError(error)) {
          recordWritePathHealth(false);
        }
        throw error;
      }
      recordWritePathHealth(true);

      logger.info("Transaction submitted via private RPC", {
        hash,
        to: request.to,
        privateRpc: !!effectiveUrl,
      });

      return {
        mode: "private-rpc" as const,
        txHash: hash,
        privateSubmission: true,
      };
    },

    async isHealthy(): Promise<boolean> {
      if (!effectiveUrl || !privateRpcTrusted) return false;

      const testClient = createHealthCheckClient();

      try {
        await verifyReadPath(testClient);
      } catch {
        return false;
      }

      if (lastWritePathProbeAt != null) {
        const ageMs = now() - lastWritePathProbeAt;
        if (lastWritePathHealthy && ageMs < writePathHealthyCacheMs) {
          return true;
        }
        if (!lastWritePathHealthy && ageMs < writePathFailureRetryMs) {
          return false;
        }
      }

      try {
        await probeWritePath(testClient);
        recordWritePathHealth(true);
        return true;
      } catch {
        recordWritePathHealth(false);
        return false;
      }
    },

    async preflightLiveSubmissionReadiness(): Promise<boolean> {
      if (!effectiveUrl || !privateRpcTrusted) return false;

      try {
        const testClient = createHealthCheckClient();
        await verifyReadPath(testClient);
        await probeWritePath(testClient);
        recordWritePathHealth(true);
        return true;
      } catch {
        recordWritePathHealth(false);
        return false;
      }
    },
  };
}
