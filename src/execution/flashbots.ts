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

const FLASHBOTS_RELAY_URL = "https://relay.flashbots.net";
const MAX_BLOCK_RETRIES = 3;
const DEFAULT_POLL_INTERVAL_MS = 1_000;

interface FlashbotsOptions {
  relayUrl?: string;
  maxBlockRetries?: number;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
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
  const flashbotsAuthKey = authKey ?? generateEphemeralPrivateKey();

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
        fetch(relayUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Flashbots-Signature": signature,
          },
          body,
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

    try {
      const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
      return receipt.blockNumber === targetBlock;
    } catch (error) {
      if (isReceiptNotFoundError(error)) return false;
      throw error;
    }
  }

  async function buildSignedTransaction(request: SubmitRequest): Promise<{
    serializedTransaction: Hex;
    txHash: Hex;
  }> {
    const account = walletClient.account;
    if (!account?.signTransaction) {
      throw new Error(
        "Flashbots submission requires a local account that can sign raw transactions.",
      );
    }

    const calldata = encodeFunctionData({
      abi: request.abi,
      functionName: request.functionName,
      args: request.args,
    });

    const prepared = await walletClient.prepareTransactionRequest({
      account,
      chain: publicClient.chain,
      to: request.to,
      data: calldata,
      type: "eip1559",
    });

    const serializedTransaction = await account.signTransaction(prepared, {
      serializer: publicClient.chain?.serializers?.transaction,
    });
    return {
      serializedTransaction,
      txHash: keccak256(serializedTransaction),
    };
  }

  return {
    name: "flashbots",
    supportsLiveSubmission: true,

    async submit(request: SubmitRequest): Promise<SubmissionResult> {
      const { serializedTransaction, txHash } =
        await buildSignedTransaction(request);

      let lastError: unknown;

      for (let attempt = 1; attempt <= maxBlockRetries; attempt++) {
        const latestBlock = await publicClient.getBlockNumber();
        const targetBlock = latestBlock + 1n;

        try {
          await simulateBundle(serializedTransaction, targetBlock);
          const bundleHash = await sendBundle(serializedTransaction, targetBlock);

          logger.info("Flashbots bundle submitted", {
            functionName: request.functionName,
            txHash,
            bundleHash,
            targetBlock: targetBlock.toString(),
            attempt,
          });

          const included = await waitForBundleInclusion(txHash, targetBlock);
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
            relayUrl,
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
        }
      }

      throw new Error(
        `Flashbots bundle was not included after ${maxBlockRetries} attempts: ${getErrorMessage(lastError)}`,
      );
    },

    async isHealthy(): Promise<boolean> {
      try {
        const response = await fetch(relayUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "eth_chainId",
            params: [],
          }),
        });
        return response.ok;
      } catch {
        return false;
      }
    },
  };
}
