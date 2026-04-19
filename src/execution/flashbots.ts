import {
  type Hex,
  encodeFunctionData,
  keccak256,
  numberToHex,
  toHex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { MevSubmitter, SubmitRequest, SubmissionResult } from "./mev-submitter.js";
import { logger } from "../utils/logger.js";
import { getErrorMessage, isTransientRpcError, retryAsync } from "../utils/retry.js";
import { generateEphemeralPrivateKey } from "../utils/secrets.js";
import { fetchWithTimeout } from "../utils/http.js";
import { getEip1559FeeCapOverrides } from "./gas.js";
import { PendingSubmissionError, createPendingSubmissionError } from "./receipt.js";

const FLASHBOTS_RELAY_URL = "https://relay.flashbots.net";
const MAX_BLOCK_RETRIES = 3;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_RELAY_HTTP_TIMEOUT_MS = 10_000;
const DEFAULT_RECEIPT_VISIBILITY_TIMEOUT_MS = 5_000;
const DEFAULT_WRITE_PATH_HEALTHY_CACHE_MS = 60_000;
const DEFAULT_WRITE_PATH_FAILURE_RETRY_MS = 5_000;
// Read-path probe runs eth_callBundle to confirm the relay can parse and
// simulate a signed transaction. It exercises more relay-side logic than the
// write probe (which just checks endpoint reachability), so refresh more often
// to catch relay regressions sooner.
const DEFAULT_READ_PATH_HEALTHY_CACHE_MS = 30_000;
const DEFAULT_READ_PATH_FAILURE_RETRY_MS = 5_000;

interface FlashbotsOptions {
  relayUrl?: string;
  maxBlockRetries?: number;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  relayTimeoutMs?: number;
  receiptVisibilityTimeoutMs?: number;
  writePathRevalidationIntervalMs?: number;
  writePathFailureRetryMs?: number;
  readPathRevalidationIntervalMs?: number;
  readPathFailureRetryMs?: number;
  now?: () => number;
}

interface FlashbotsRpcSuccess<T> {
  result?: T;
  error?: { message?: string };
}

interface FlashbotsSimulationResult {
  results?: Array<{ error?: string }>;
  firstRevert?: { error?: string };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isReceiptNotFoundError(error: unknown): boolean {
  return getErrorMessage(error).toLowerCase().includes("receipt");
}

function isExpectedSendBundleProbeError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
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

/**
 * Single-transaction Flashbots bundle submitter.
 * This uses a local account to build and sign a raw EIP-1559 transaction,
 * simulates it with eth_callBundle, then sends it with eth_sendBundle and
 * waits for inclusion for up to N consecutive target blocks.
 */
export function createFlashbotsSubmitter(
  publicClient: PublicClient,
  walletClient: WalletClient,
  authKey?: Hex,
  options: FlashbotsOptions = {},
): MevSubmitter {
  const relayUrl = options.relayUrl || FLASHBOTS_RELAY_URL;
  const maxBlockRetries = options.maxBlockRetries || MAX_BLOCK_RETRIES;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const sleep = options.sleep || defaultSleep;
  const relayTimeoutMs = options.relayTimeoutMs ?? DEFAULT_RELAY_HTTP_TIMEOUT_MS;
  const receiptVisibilityTimeoutMs =
    options.receiptVisibilityTimeoutMs ?? DEFAULT_RECEIPT_VISIBILITY_TIMEOUT_MS;
  const writePathHealthyCacheMs =
    options.writePathRevalidationIntervalMs ?? DEFAULT_WRITE_PATH_HEALTHY_CACHE_MS;
  const writePathFailureRetryMs =
    options.writePathFailureRetryMs ?? DEFAULT_WRITE_PATH_FAILURE_RETRY_MS;
  const readPathHealthyCacheMs =
    options.readPathRevalidationIntervalMs ?? DEFAULT_READ_PATH_HEALTHY_CACHE_MS;
  const readPathFailureRetryMs =
    options.readPathFailureRetryMs ?? DEFAULT_READ_PATH_FAILURE_RETRY_MS;
  const now = options.now || Date.now;
  const flashbotsAuthKey = authKey ?? generateEphemeralPrivateKey();
  let lastWritePathProbeAt: number | null = null;
  let lastWritePathHealthy = false;
  let lastReadPathProbeAt: number | null = null;
  let lastReadPathHealthy = false;

  if (!authKey) {
    logger.warn(
      "FLASHBOTS_AUTH_KEY not configured; generated an ephemeral relay identity for this process",
    );
  }

  const authAccount = privateKeyToAccount(flashbotsAuthKey);

  async function signFlashbotsPayload(body: string): Promise<string> {
    const hash = keccak256(toHex(body));
    const signature = await authAccount.signMessage({ message: { raw: hash } });
    return `${authAccount.address}:${signature}`;
  }

  async function relayRpc<T>(
    method: string,
    params: unknown[],
  ): Promise<T> {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    });

    const signature = await signFlashbotsPayload(body);

    const response = await retryAsync(
      () =>
        fetchWithTimeout(relayUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Flashbots-Signature": signature,
          },
          body,
          timeoutMs: relayTimeoutMs,
          label: `flashbots.${method}`,
        }),
      {
        label: `flashbots.${method}.http`,
        shouldRetry: isTransientRpcError,
      },
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Flashbots relay error: ${response.status} ${text}`);
    }

    const json = await response.json() as FlashbotsRpcSuccess<T>;
    if (json.error?.message) {
      throw new Error(`Flashbots RPC error: ${json.error.message}`);
    }

    return json.result as T;
  }

  async function simulateBundle(
    serializedTransaction: Hex,
    targetBlock: bigint,
  ): Promise<void> {
    const result = await relayRpc<FlashbotsSimulationResult>(
      "eth_callBundle",
      [
        {
          txs: [serializedTransaction],
          blockNumber: numberToHex(targetBlock),
          stateBlockNumber: "latest",
        },
      ],
    );

    const nestedError =
      result.firstRevert?.error ||
      result.results?.find((entry) => entry.error)?.error;

    if (nestedError) {
      throw new Error(`Flashbots simulation failed: ${nestedError}`);
    }
  }

  async function sendBundle(
    serializedTransaction: Hex,
    targetBlock: bigint,
  ): Promise<string> {
    const result = await relayRpc<{ bundleHash?: string }>(
      "eth_sendBundle",
      [
        {
          txs: [serializedTransaction],
          blockNumber: numberToHex(targetBlock),
        },
      ],
    );

    if (!result.bundleHash) {
      throw new Error("Flashbots relay returned no bundleHash");
    }

    return result.bundleHash;
  }

  async function probeSendBundlePath(targetBlock: bigint): Promise<void> {
    try {
      await relayRpc<{ bundleHash?: string }>(
        "eth_sendBundle",
        [
          {
            txs: ["0x00"],
            blockNumber: numberToHex(targetBlock),
          },
        ],
      );
    } catch (error) {
      if (isExpectedSendBundleProbeError(error)) {
        return;
      }
      throw error;
    }
  }

  function recordWritePathHealth(healthy: boolean) {
    lastWritePathProbeAt = now();
    lastWritePathHealthy = healthy;
  }

  function recordReadPathHealth(healthy: boolean) {
    lastReadPathProbeAt = now();
    lastReadPathHealthy = healthy;
  }

  async function ensureReadPathHealthy(): Promise<{
    healthy: boolean;
    targetBlock: bigint | null;
  }> {
    if (lastReadPathProbeAt != null) {
      const ageMs = now() - lastReadPathProbeAt;
      if (lastReadPathHealthy && ageMs < readPathHealthyCacheMs) {
        return { healthy: true, targetBlock: null };
      }
      if (!lastReadPathHealthy && ageMs < readPathFailureRetryMs) {
        return { healthy: false, targetBlock: null };
      }
    }

    // getBlockNumber hits the regular chain RPC, not the Flashbots relay.
    // An upstream RPC failure shouldn't poison the relay-side read-path cache.
    let targetBlock: bigint;
    try {
      const latestBlock = await publicClient.getBlockNumber();
      targetBlock = latestBlock + 1n;
    } catch (error) {
      logger.debug("Flashbots health check aborted: upstream RPC getBlockNumber failed", {
        error: getErrorMessage(error),
      });
      return { healthy: false, targetBlock: null };
    }

    try {
      await simulateExecutionPath(targetBlock);
      recordReadPathHealth(true);
      return { healthy: true, targetBlock };
    } catch (error) {
      logger.debug("Flashbots health check aborted: simulate probe failed", {
        error: getErrorMessage(error),
      });
      recordReadPathHealth(false);
      return { healthy: false, targetBlock: null };
    }
  }

  function hasRecentWritePathFailure(): boolean {
    if (lastWritePathProbeAt == null || lastWritePathHealthy) {
      return false;
    }
    return now() - lastWritePathProbeAt < writePathFailureRetryMs;
  }

  async function simulateExecutionPath(targetBlock: bigint): Promise<void> {
    const { serializedTransaction } = await buildSignedHealthCheckTransaction();
    await simulateBundle(serializedTransaction, targetBlock);
  }

  async function revalidateWritePath(targetBlock: bigint): Promise<boolean> {
    try {
      await probeSendBundlePath(targetBlock);
      recordWritePathHealth(true);
      return true;
    } catch {
      recordWritePathHealth(false);
      return false;
    }
  }

  async function waitForTargetBlock(targetBlock: bigint): Promise<void> {
    while (true) {
      const currentBlock = await publicClient.getBlockNumber();
      if (currentBlock >= targetBlock) return;
      await sleep(pollIntervalMs);
    }
  }

  async function waitForBundleInclusion(
    txHash: Hex,
    targetBlock: bigint,
  ): Promise<boolean> {
    await waitForTargetBlock(targetBlock);

    const deadline = now() + receiptVisibilityTimeoutMs;

    while (true) {
      try {
        const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
        return receipt.blockNumber === targetBlock;
      } catch (error) {
        if (!isReceiptNotFoundError(error)) {
          throw error;
        }
      }

      if (now() >= deadline) {
        return false;
      }

      await sleep(pollIntervalMs);
    }
  }

  async function buildSignedTransaction(
    to: Hex | `0x${string}`,
    data: Hex,
    request?: Pick<SubmitRequest, "gasPriceWei" | "feeCapOverrides">,
  ): Promise<{
    serializedTransaction: Hex;
    txHash: Hex;
  }> {
    const account = walletClient.account;
    if (!account?.signTransaction) {
      throw new Error(
        "Flashbots submission requires a local account that can sign raw transactions.",
      );
    }

    const prepared = await walletClient.prepareTransactionRequest({
      account,
      chain: publicClient.chain,
      to,
      data,
      type: "eip1559",
      ...(request?.feeCapOverrides ??
        getEip1559FeeCapOverrides(request?.gasPriceWei) ??
        {}),
    });

    const serializedTransaction = await account.signTransaction(prepared, {
      serializer: publicClient.chain?.serializers?.transaction,
    });
    return {
      serializedTransaction,
      txHash: keccak256(serializedTransaction),
    };
  }

  async function buildSignedExecutionTransaction(request: SubmitRequest): Promise<{
    serializedTransaction: Hex;
    txHash: Hex;
  }> {
    const calldata = encodeFunctionData({
      abi: request.abi,
      functionName: request.functionName,
      args: request.args,
    });

    return buildSignedTransaction(request.to, calldata, request);
  }

  async function buildSignedHealthCheckTransaction(): Promise<{
    serializedTransaction: Hex;
    txHash: Hex;
  }> {
    const account = walletClient.account;
    if (!account) {
      throw new Error("Flashbots health check requires a configured wallet account.");
    }

    return buildSignedTransaction(account.address, "0x");
  }

  return {
    name: "flashbots",
    supportsLiveSubmission: true,

    async submit(request: SubmitRequest): Promise<SubmissionResult> {
      if (hasRecentWritePathFailure()) {
        throw new Error(
          "Flashbots relay unhealthy, aborting bundle submission until the next health revalidation window.",
        );
      }

      let lastError: unknown;

      for (let attempt = 1; attempt <= maxBlockRetries; attempt++) {
        const latestBlock = await publicClient.getBlockNumber();
        const targetBlock = latestBlock + 1n;
        let txHash: Hex | undefined;

        try {
          const builtTransaction =
            await buildSignedExecutionTransaction(request);
          txHash = builtTransaction.txHash;
          const { serializedTransaction } = builtTransaction;
          await simulateBundle(serializedTransaction, targetBlock);
          let bundleHash: string;
          try {
            bundleHash = await sendBundle(serializedTransaction, targetBlock);
          } catch (error) {
            recordWritePathHealth(false);
            throw error;
          }
          recordWritePathHealth(true);

          logger.info("Flashbots bundle submitted", {
            functionName: request.functionName,
            txHash,
            bundleHash,
            targetBlock: targetBlock.toString(),
            attempt,
          });

          let included: boolean;
          try {
            included = await waitForBundleInclusion(txHash, targetBlock);
          } catch (error) {
            throw createPendingSubmissionError(
              {
                txHash,
                label: request.functionName,
                mode: "flashbots",
                bundleHash,
                targetBlock,
                privateSubmission: true,
              },
              `Flashbots bundle submission accepted by relay, but inclusion monitoring failed: ${getErrorMessage(error)}`,
            );
          }
          if (!included) {
            logger.warn("Flashbots bundle not included in target block", {
              txHash,
              bundleHash,
              targetBlock: targetBlock.toString(),
              attempt,
            });
            continue;
          }

          return {
            mode: "flashbots",
            txHash,
            bundleHash,
            targetBlock,
            privateSubmission: true,
          };
        } catch (error) {
          lastError = error;
          logger.warn("Flashbots bundle attempt failed", {
            functionName: request.functionName,
            txHash,
            targetBlock: targetBlock.toString(),
            attempt,
            error: getErrorMessage(error),
          });

          if (error instanceof PendingSubmissionError) {
            throw error;
          }

          if (hasRecentWritePathFailure()) {
            throw new Error(
              `Flashbots relay unhealthy, aborting remaining bundle retries until the next health revalidation window: ${getErrorMessage(error)}`,
            );
          }
        }
      }

      throw new Error(
        `Flashbots bundle was not included after ${maxBlockRetries} attempts: ${getErrorMessage(lastError)}`,
      );
    },

    async isHealthy(): Promise<boolean> {
      const readResult = await ensureReadPathHealthy();
      if (!readResult.healthy) return false;

      if (lastWritePathProbeAt != null) {
        const ageMs = now() - lastWritePathProbeAt;
        if (lastWritePathHealthy && ageMs < writePathHealthyCacheMs) {
          return true;
        }
        if (!lastWritePathHealthy && ageMs < writePathFailureRetryMs) {
          return false;
        }
      }

      let targetBlock: bigint;
      if (readResult.targetBlock != null) {
        targetBlock = readResult.targetBlock;
      } else {
        try {
          const latestBlock = await publicClient.getBlockNumber();
          targetBlock = latestBlock + 1n;
        } catch (error) {
          // Upstream RPC failure — don't poison relay-side write-path cache.
          logger.debug("Flashbots write-path revalidation aborted: upstream RPC getBlockNumber failed", {
            error: getErrorMessage(error),
          });
          return false;
        }
      }
      return await revalidateWritePath(targetBlock);
    },

    async preflightLiveSubmissionReadiness(): Promise<boolean> {
      let targetBlock: bigint;
      try {
        const latestBlock = await publicClient.getBlockNumber();
        targetBlock = latestBlock + 1n;
      } catch (error) {
        logger.debug("Flashbots preflight aborted: upstream RPC getBlockNumber failed", {
          error: getErrorMessage(error),
        });
        return false;
      }
      try {
        await simulateExecutionPath(targetBlock);
        recordReadPathHealth(true);
      } catch (error) {
        logger.debug("Flashbots preflight aborted: simulate probe failed", {
          error: getErrorMessage(error),
        });
        recordReadPathHealth(false);
        return false;
      }
      try {
        await probeSendBundlePath(targetBlock);
        recordWritePathHealth(true);
        return true;
      } catch (error) {
        logger.debug("Flashbots preflight aborted: sendBundle probe failed", {
          error: getErrorMessage(error),
        });
        recordWritePathHealth(false);
        return false;
      }
    },
  };
}
