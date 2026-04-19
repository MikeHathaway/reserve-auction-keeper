import {
  type Hex,
  type PublicClient,
  type WalletClient,
  createPublicClient,
  http,
  encodeFunctionData,
  keccak256,
} from "viem";
import type { MevSubmitter, SubmitRequest } from "./mev-submitter.js";
import { logger, redactUrlForLogs } from "../utils/logger.js";
import { isTransientRpcError, retryAsync } from "../utils/retry.js";
import { getEip1559FeeCapOverrides } from "./gas.js";
import { createPendingSubmissionError } from "./receipt.js";

const DEFAULT_WRITE_PATH_HEALTHY_CACHE_MS = 60_000;
const DEFAULT_WRITE_PATH_FAILURE_RETRY_MS = 5_000;
// Read-path probe (getBlockNumber against the private endpoint) is cheap and
// exercises a different code path than the write probe (junk eth_sendRawTransaction).
// Refreshed more often than the write TTL so endpoint-level read failures are
// detected within ~half the write-revalidation window.
const DEFAULT_READ_PATH_HEALTHY_CACHE_MS = 30_000;
const DEFAULT_READ_PATH_FAILURE_RETRY_MS = 5_000;

interface PrivateRpcOptions {
  now?: () => number;
  writePathRevalidationIntervalMs?: number;
  writePathFailureRetryMs?: number;
  readPathRevalidationIntervalMs?: number;
  readPathFailureRetryMs?: number;
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

function isKnownRawTransactionError(error: unknown): boolean {
  const message = String(error instanceof Error ? error.message : error).toLowerCase();
  return [
    "already known",
    "known transaction",
    "nonce too low",
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
  const readPathHealthyCacheMs =
    options.readPathRevalidationIntervalMs ?? DEFAULT_READ_PATH_HEALTHY_CACHE_MS;
  const readPathFailureRetryMs =
    options.readPathFailureRetryMs ?? DEFAULT_READ_PATH_FAILURE_RETRY_MS;
  let lastWritePathProbeAt: number | null = null;
  let lastWritePathHealthy = false;
  let lastReadPathProbeAt: number | null = null;
  let lastReadPathHealthy = false;

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

  function recordReadPathHealth(healthy: boolean) {
    lastReadPathProbeAt = now();
    lastReadPathHealthy = healthy;
  }

  async function ensureReadPathHealthy(
    testClient: ReturnType<typeof createHealthCheckClient>,
  ): Promise<boolean> {
    if (lastReadPathProbeAt != null) {
      const ageMs = now() - lastReadPathProbeAt;
      if (lastReadPathHealthy && ageMs < readPathHealthyCacheMs) return true;
      if (!lastReadPathHealthy && ageMs < readPathFailureRetryMs) return false;
    }
    try {
      await verifyReadPath(testClient);
      recordReadPathHealth(true);
      return true;
    } catch {
      recordReadPathHealth(false);
      return false;
    }
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

  async function sendRawTransaction(
    testClient: ReturnType<typeof createHealthCheckClient>,
    serializedTransaction: Hex,
  ): Promise<Hex> {
    const requestCapableClient = testClient as typeof testClient & {
      request(args: {
        method: string;
        params?: unknown[];
      }): Promise<unknown>;
    };

    const result = await requestCapableClient.request({
      method: "eth_sendRawTransaction",
      params: [serializedTransaction],
    });

    if (typeof result !== "string") {
      throw new Error("Private RPC eth_sendRawTransaction returned no transaction hash.");
    }

    return result as Hex;
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

      const metadataClient = createHealthCheckClient();
      let nonce: bigint;
      try {
        const capturedNonce = await retryAsync(
          () => metadataClient.getTransactionCount({
            address: request.account,
            blockTag: "pending",
          }),
          {
            label: `private-rpc.capture-nonce.${request.functionName}`,
            shouldRetry: isTransientRpcError,
          },
        );
        nonce = BigInt(capturedNonce);
      } catch (error) {
        if (isWritePathAvailabilityError(error)) {
          recordWritePathHealth(false);
        }
        throw error;
      }
      const submittedAtMs = now();

      const account = walletClient.account;
      if (!account?.signTransaction) {
        throw new Error(
          "Private RPC submission requires a local account that can sign raw transactions.",
        );
      }

      const prepared = await walletClient.prepareTransactionRequest({
        account,
        chain: publicClient.chain,
        to: request.to,
        data: calldata,
        nonce: Number(nonce),
        type: "eip1559",
        ...(request.feeCapOverrides ??
          getEip1559FeeCapOverrides(request.gasPriceWei) ??
          {}),
      });

      const serializedTransaction = await account.signTransaction(prepared, {
        serializer: publicClient.chain?.serializers?.transaction,
      });
      const txHash = keccak256(serializedTransaction);

      try {
        const returnedHash = await retryAsync(
          () =>
            sendRawTransaction(metadataClient, serializedTransaction),
          {
            label: `private-rpc.submit.${request.functionName}`,
            shouldRetry: isTransientRpcError,
          },
        );
        if (returnedHash !== txHash) {
          throw new Error(
            `Private RPC returned unexpected transaction hash ${returnedHash} for ${request.functionName}.`,
          );
        }
      } catch (error) {
        if (isKnownRawTransactionError(error)) {
          logger.info("Transaction already accepted by private RPC", {
            txHash,
            to: request.to,
            functionName: request.functionName,
          });
          recordWritePathHealth(true);
          return {
            mode: "private-rpc" as const,
            txHash,
            privateSubmission: true,
            account: request.account,
            nonce,
            submittedAtMs,
          };
        }
        if (isTransientRpcError(error)) {
          recordWritePathHealth(false);
          throw createPendingSubmissionError(
            {
              txHash,
              label: request.functionName,
              mode: "private-rpc",
              privateSubmission: true,
              account: request.account,
              nonce,
              submittedAtMs,
            },
            `Private RPC submission may have succeeded but the endpoint response was lost: ${String(error instanceof Error ? error.message : error)}`,
          );
        }
        if (isWritePathAvailabilityError(error)) {
          recordWritePathHealth(false);
        }
        throw error;
      }
      recordWritePathHealth(true);

      logger.info("Transaction submitted via private RPC", {
        hash: txHash,
        to: request.to,
        privateRpc: !!effectiveUrl,
      });

      return {
        mode: "private-rpc" as const,
        txHash,
        privateSubmission: true,
        account: request.account,
        nonce,
        submittedAtMs,
      };
    },

    async isHealthy(): Promise<boolean> {
      if (!effectiveUrl || !privateRpcTrusted) return false;

      // Eagerly create one testClient and share it between read + write probes.
      // Object construction is cheap (no RPC; HTTP transport is lazy), and the
      // alternative — creating one per probe phase — would double the
      // construction cost in the common bootstrap case where both probes run.
      const testClient = createHealthCheckClient();

      if (!(await ensureReadPathHealthy(testClient))) {
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

      const testClient = createHealthCheckClient();
      try {
        await verifyReadPath(testClient);
        recordReadPathHealth(true);
      } catch {
        recordReadPathHealth(false);
        return false;
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
  };
}
