import "dotenv/config";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const TEST_DIR = join(process.cwd(), "contracts", "test");
const DEFAULT_MAINNET_FORK_BLOCK = "24773987";

function collectForkTests(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectForkTests(fullPath));
      continue;
    }
    if (!entry.name.endsWith(".mainnet-fork.t.sol")) continue;
    files.push(fullPath);
  }

  return files.sort();
}

function resolveMainnetRpcUrl() {
  if (process.env.MAINNET_RPC_URL) {
    return process.env.MAINNET_RPC_URL;
  }

  const provider = process.env.RPC_PROVIDER;
  const apiKey = process.env.RPC_API_KEY;
  if (!provider || !apiKey) {
    throw new Error(
      "MAINNET_RPC_URL or RPC_PROVIDER/RPC_API_KEY is required for mainnet fork tests.",
    );
  }

  if (provider === "alchemy") {
    return `https://eth-mainnet.g.alchemy.com/v2/${apiKey}`;
  }

  if (provider === "infura") {
    return `https://mainnet.infura.io/v3/${apiKey}`;
  }

  throw new Error(`Unsupported RPC_PROVIDER for mainnet fork tests: ${provider}`);
}

const tests = collectForkTests(TEST_DIR);
if (tests.length === 0) {
  console.error("No mainnet fork Solidity test files found.");
  process.exit(1);
}

const rpcUrl = resolveMainnetRpcUrl();
const forkBlock = process.env.MAINNET_FORK_BLOCK || DEFAULT_MAINNET_FORK_BLOCK;

for (const testFile of tests) {
  const result = spawnSync(
    "forge",
    [
      "test",
      "--match-path",
      testFile,
      "--fork-url",
      rpcUrl,
      "--fork-block-number",
      forkBlock,
    ],
    { stdio: "inherit" },
  );
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
