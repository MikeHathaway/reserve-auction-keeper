import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import net from "node:net";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import { createFlashbotsSubmitter } from "../../src/execution/flashbots.js";
import { createRestrictedChildEnv } from "../../scripts/child-process-env.mjs";

const LOCAL_HOST = "127.0.0.1";
const ANVIL_DEFAULT_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const FLASHBOTS_AUTH_KEY =
  "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const RECIPIENT = "0x1111111111111111111111111111111111111111";

const SIMPLE_ABI = [
  {
    inputs: [],
    name: "poke",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, LOCAL_HOST, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to allocate a free local port"));
        return;
      }

      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

async function waitForRpcReady(rpcUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_blockNumber",
          params: [],
        }),
      });
      if (response.ok) return;
      lastError = new Error(`Unexpected RPC status ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(
    `Timed out waiting for local RPC at ${rpcUrl}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

async function readJsonBody(request: IncomingMessage): Promise<{
  jsonrpc?: string;
  id?: number;
  method?: string;
  params?: unknown[];
}> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
    jsonrpc?: string;
    id?: number;
    method?: string;
    params?: unknown[];
  };
}

async function rpcRequest(
  rpcUrl: string,
  method: string,
  params: unknown[],
): Promise<unknown> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    }),
  });

  if (!response.ok) {
    throw new Error(`RPC ${method} failed with status ${response.status}`);
  }

  const body = await response.json() as {
    result?: unknown;
    error?: { message?: string };
  };

  if (body.error?.message) {
    throw new Error(`RPC ${method} failed: ${body.error.message}`);
  }

  return body.result;
}

function writeJson(
  response: ServerResponse,
  payload: unknown,
): void {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
}

describe("flashbots submitter integration", () => {
  let anvilProcess: ChildProcessWithoutNullStreams | null = null;
  let relayServer: ReturnType<typeof createServer> | null = null;
  let rpcUrl = "";
  let relayUrl = "";
  let lastSignatureHeader = "";
  let callBundleCount = 0;
  let sendBundleCount = 0;

  beforeAll(async () => {
    const anvilPort = await getFreePort();
    rpcUrl = `http://${LOCAL_HOST}:${anvilPort}`;

    anvilProcess = spawn(
      "anvil",
      [
        "--host",
        LOCAL_HOST,
        "--port",
        String(anvilPort),
        "--chain-id",
        "1",
        "--silent",
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: createRestrictedChildEnv(),
      },
    );

    let stderr = "";
    anvilProcess.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    anvilProcess.once("exit", (code) => {
      if (code !== 0) {
        process.stderr.write(stderr);
      }
    });

    await waitForRpcReady(rpcUrl, 10_000);

    const relayPort = await getFreePort();
    relayUrl = `http://${LOCAL_HOST}:${relayPort}`;

    relayServer = createServer(async (request, response) => {
      try {
        const payload = await readJsonBody(request);
        lastSignatureHeader = String(request.headers["x-flashbots-signature"] || "");

        if (payload.method === "eth_chainId") {
          writeJson(response, { jsonrpc: "2.0", id: payload.id || 1, result: "0x1" });
          return;
        }

        if (payload.method === "eth_callBundle") {
          callBundleCount += 1;
          writeJson(response, {
            jsonrpc: "2.0",
            id: payload.id || 1,
            result: { results: [{}] },
          });
          return;
        }

        if (payload.method === "eth_sendBundle") {
          sendBundleCount += 1;
          const rawTransaction = (payload.params?.[0] as { txs?: string[] } | undefined)?.txs?.[0];
          if (!rawTransaction) {
            writeJson(response, {
              jsonrpc: "2.0",
              id: payload.id || 1,
              error: { message: "missing bundled transaction" },
            });
            return;
          }

          await rpcRequest(rpcUrl, "eth_sendRawTransaction", [rawTransaction]);

          writeJson(response, {
            jsonrpc: "2.0",
            id: payload.id || 1,
            result: { bundleHash: `bundle-${sendBundleCount}` },
          });
          return;
        }

        writeJson(response, {
          jsonrpc: "2.0",
          id: payload.id || 1,
          error: { message: `unsupported method ${payload.method}` },
        });
      } catch (error) {
        writeJson(response, {
          jsonrpc: "2.0",
          id: 1,
          error: {
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
    });

    await new Promise<void>((resolve, reject) => {
      relayServer!.once("error", reject);
      relayServer!.listen(relayPort, LOCAL_HOST, () => resolve());
    });
  });

  afterAll(async () => {
    if (relayServer) {
      await new Promise<void>((resolve, reject) => {
        relayServer!.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      relayServer = null;
    }

    if (!anvilProcess) return;
    anvilProcess.kill("SIGTERM");
    await new Promise((resolve) => anvilProcess?.once("exit", resolve));
    anvilProcess = null;
  });

  it("builds, relays, and confirms a live flashbots submission against a local relay", async () => {
    const account = privateKeyToAccount(ANVIL_DEFAULT_PRIVATE_KEY as Hex);
    const publicClient = createPublicClient({
      chain: mainnet,
      transport: http(rpcUrl),
    });
    const walletClient = createWalletClient({
      account,
      chain: mainnet,
      transport: http(rpcUrl),
    });

    const submitter = createFlashbotsSubmitter(
      publicClient,
      walletClient,
      FLASHBOTS_AUTH_KEY as Hex,
      {
        relayUrl,
        pollIntervalMs: 10,
      },
    );

    const submission = await submitter.submit({
      to: RECIPIENT as Address,
      abi: SIMPLE_ABI,
      functionName: "poke",
      args: [],
      account: account.address,
    });

    expect(submission.mode).toBe("flashbots");
    expect(submission.bundleHash).toBe("bundle-1");
    expect(submission.txHash).toBeDefined();
    expect(submission.privateSubmission).toBe(true);
    expect(submission.targetBlock).toBe(1n);
    expect(lastSignatureHeader).toContain(":");
    expect(callBundleCount).toBe(1);
    expect(sendBundleCount).toBe(1);

    const receipt = await publicClient.getTransactionReceipt({
      hash: submission.txHash!,
    });
    expect(receipt.status).toBe("success");
    expect(receipt.blockNumber).toBe(submission.targetBlock);
  });
});
