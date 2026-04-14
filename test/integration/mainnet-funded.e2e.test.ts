import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import net from "node:net";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import { MAINNET_CONFIG } from "../../src/chains/index.js";
import {
  canKickReserveAuction,
  discoverPools,
  getPoolReserveStates,
} from "../../src/auction/discovery.js";
import { getAuctionPrices } from "../../src/auction/auction-price.js";
import { createFundedStrategy } from "../../src/strategies/funded.js";
import { createPrivateRpcSubmitter } from "../../src/execution/private-rpc.js";
import { setLogLevel } from "../../src/utils/logger.js";
import type { AuctionContext } from "../../src/strategies/interface.js";
import { createRestrictedChildEnv } from "../../scripts/child-process-env.mjs";
import { createEphemeralFoundryRpcConfig } from "../../scripts/foundry-rpc-config.mjs";

const FORK_BLOCK = 24_773_987;
const TARGET_POOL = "0x9cdB48FcBd8241Bb75887AF04d3b1302c410F671";
const AJNA_WETH_UNISWAP_POOL = "0xB79323DDEd09EaBAE6366cE11c51EC53b3fcd57e";
const AJNA_TRANSFER_AMOUNT = parseEther("50000");
const LOCAL_RPC_HOST = "127.0.0.1";
const ANVIL_DEFAULT_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const ERC20_ABI = [
  {
    inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }],
    name: "transfer",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

function resolveMainnetRpcUrl(): string | null {
  if (process.env.MAINNET_RPC_URL) return process.env.MAINNET_RPC_URL;

  const provider = process.env.RPC_PROVIDER;
  const apiKey = process.env.RPC_API_KEY?.trim() ||
    (process.env.RPC_API_KEY_FILE ? readFileSync(process.env.RPC_API_KEY_FILE, "utf-8").trim() : "");
  if (!provider || !apiKey) return null;

  if (provider === "alchemy") {
    return `https://eth-mainnet.g.alchemy.com/v2/${apiKey}`;
  }

  if (provider === "infura") {
    return `https://mainnet.infura.io/v3/${apiKey}`;
  }

  return null;
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, LOCAL_RPC_HOST, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to allocate a free local port for Anvil"));
        return;
      }

      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
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

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(
    `Timed out waiting for Anvil RPC at ${rpcUrl}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
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

const forkRpcUrl = resolveMainnetRpcUrl();
const describeMainnetFork = forkRpcUrl ? describe : describe.skip;

describeMainnetFork("mainnet funded strategy e2e", () => {
  let anvilProcess: ChildProcessWithoutNullStreams | null = null;
  let rpcUrl = "";
  let forkConfig: ReturnType<typeof createEphemeralFoundryRpcConfig> | null = null;

  beforeAll(async () => {
    setLogLevel("error");

    const port = await getFreePort();
    rpcUrl = `http://${LOCAL_RPC_HOST}:${port}`;
    forkConfig = createEphemeralFoundryRpcConfig("mainnet", forkRpcUrl!);

    anvilProcess = spawn(
      "anvil",
      [
        "--host",
        LOCAL_RPC_HOST,
        "--port",
        String(port),
        "--fork-url",
        "mainnet",
        "--fork-block-number",
        String(FORK_BLOCK),
        "--chain-id",
        "1",
        "--silent",
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        cwd: forkConfig.workdir,
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

    try {
      await waitForRpcReady(rpcUrl, 15_000);
    } catch (error) {
      anvilProcess.kill("SIGTERM");
      forkConfig?.cleanup();
      forkConfig = null;
      throw error;
    }
  });

  afterAll(async () => {
    if (!anvilProcess) return;
    anvilProcess.kill("SIGTERM");
    await new Promise((resolve) => anvilProcess?.once("exit", resolve));
    anvilProcess = null;
    forkConfig?.cleanup();
    forkConfig = null;
  });

  it("discovers, kicks, and fills a reserve auction against a pinned mainnet fork", async () => {
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

    await rpcRequest(rpcUrl, "anvil_impersonateAccount", [AJNA_WETH_UNISWAP_POOL]);
    await rpcRequest(rpcUrl, "anvil_setBalance", [
      AJNA_WETH_UNISWAP_POOL,
      "0x56BC75E2D63100000",
    ]);

    const impersonatedWalletClient = createWalletClient({
      account: AJNA_WETH_UNISWAP_POOL as Address,
      chain: mainnet,
      transport: http(rpcUrl),
    });

    const fundHash = await impersonatedWalletClient.writeContract({
      address: MAINNET_CONFIG.ajnaToken,
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [account.address, AJNA_TRANSFER_AMOUNT],
      account: AJNA_WETH_UNISWAP_POOL as Address,
      chain: mainnet,
    });
    await publicClient.waitForTransactionReceipt({ hash: fundHash });
    await rpcRequest(rpcUrl, "anvil_stopImpersonatingAccount", [AJNA_WETH_UNISWAP_POOL]);

    const pools = await discoverPools(publicClient, MAINNET_CONFIG, [TARGET_POOL]);
    expect(pools).toEqual([TARGET_POOL]);
    await expect(canKickReserveAuction(publicClient, TARGET_POOL)).resolves.toBe(true);

    const kickHash = await walletClient.writeContract({
      address: TARGET_POOL,
      abi: [
        {
          inputs: [],
          name: "kickReserveAuction",
          outputs: [],
          stateMutability: "nonpayable",
          type: "function",
        },
      ],
      functionName: "kickReserveAuction",
      chain: mainnet,
      account,
    });
    await publicClient.waitForTransactionReceipt({ hash: kickHash });

    const [poolState] = await getPoolReserveStates(publicClient, MAINNET_CONFIG, pools);
    expect(poolState).toBeDefined();
    expect(poolState.hasActiveAuction).toBe(true);
    expect(poolState.isKickable).toBe(false);
    expect(poolState.claimableReservesRemaining).toBeGreaterThan(0n);

    const priceMap = await getAuctionPrices(publicClient, MAINNET_CONFIG, pools);
    const priceInfo = priceMap.get(TARGET_POOL);
    expect(priceInfo).toBeDefined();

    const prices = {
      ajnaPriceUsd: 0.000000000000001,
      quoteTokenPriceUsd: 1,
      source: "coingecko" as const,
      isStale: false,
    };

    const ctx: AuctionContext = {
      poolState,
      auctionPrice: priceInfo!.auctionPrice,
      prices,
      chainName: "mainnet",
    };

    const submitter = createPrivateRpcSubmitter(publicClient, walletClient, rpcUrl, true);
    const strategy = createFundedStrategy(
      publicClient,
      walletClient,
      MAINNET_CONFIG.ajnaToken,
      submitter,
      {
        targetExitPriceUsd: 0,
        maxTakeAmount: parseEther("1"),
        autoApprove: true,
        profitMarginPercent: 0,
        dryRun: false,
      },
    );

    const estimatedProfitUsd = await strategy.estimateProfit(ctx);
    expect(estimatedProfitUsd).toBeGreaterThan(0);
    await expect(strategy.canExecute(ctx)).resolves.toBe(true);

    const quoteBalanceBefore = await publicClient.readContract({
      address: poolState.quoteToken,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [account.address],
    });
    const ajnaBalanceBefore = await publicClient.readContract({
      address: MAINNET_CONFIG.ajnaToken,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [account.address],
    });

    const result = await strategy.execute(ctx);

    expect(result.txHash).toBeDefined();
    expect(result.submissionMode).toBe("private-rpc");
    expect(result.privateSubmission).toBe(true);
    expect(result.pool).toBe(TARGET_POOL);
    expect(result.amountQuoteReceived).toBeGreaterThan(0n);

    const receipt = await publicClient.waitForTransactionReceipt({
      hash: result.txHash!,
    });
    expect(receipt.status).toBe("success");

    const quoteBalanceAfter = await publicClient.readContract({
      address: poolState.quoteToken,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [account.address],
    });
    const ajnaBalanceAfter = await publicClient.readContract({
      address: MAINNET_CONFIG.ajnaToken,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [account.address],
    });
    const [poolStateAfter] = await getPoolReserveStates(publicClient, MAINNET_CONFIG, pools);

    expect(quoteBalanceAfter).toBeGreaterThan(quoteBalanceBefore);
    expect(ajnaBalanceAfter).toBeLessThan(ajnaBalanceBefore);
    expect(poolStateAfter.claimableReservesRemaining).toBeLessThan(
      poolState.claimableReservesRemaining,
    );
  });
});
