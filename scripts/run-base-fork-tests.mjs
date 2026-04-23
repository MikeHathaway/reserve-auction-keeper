import "dotenv/config";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createEphemeralFoundryRpcConfig } from "./foundry-rpc-config.mjs";
import { createRestrictedChildEnv } from "./child-process-env.mjs";

const TEST_DIR = join(process.cwd(), "contracts", "test");
const DEFAULT_BASE_FORK_BLOCK = "44533293";

function collectForkTests(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectForkTests(fullPath));
      continue;
    }
    if (!entry.name.endsWith(".base-fork.t.sol")) continue;
    files.push(fullPath);
  }

  return files.sort();
}

function resolveBaseRpcUrl() {
  if (process.env.BASE_RPC_URL) {
    return process.env.BASE_RPC_URL;
  }

  const provider = process.env.RPC_PROVIDER;
  const apiKey = process.env.RPC_API_KEY?.trim() ||
    (process.env.RPC_API_KEY_FILE ? readFileSync(process.env.RPC_API_KEY_FILE, "utf-8").trim() : "");
  if (!provider || !apiKey) {
    throw new Error(
      "BASE_RPC_URL or RPC_PROVIDER/RPC_API_KEY or RPC_API_KEY_FILE is required for Base fork tests.",
    );
  }

  if (provider === "alchemy") {
    return `https://base-mainnet.g.alchemy.com/v2/${apiKey}`;
  }

  throw new Error(`Unsupported RPC_PROVIDER for Base fork tests: ${provider}`);
}

const tests = collectForkTests(TEST_DIR);
if (tests.length === 0) {
  console.error("No Base fork Solidity test files found.");
  process.exit(1);
}

const rpcUrl = resolveBaseRpcUrl();
const forkBlock = process.env.BASE_FORK_BLOCK || DEFAULT_BASE_FORK_BLOCK;
// absolutePaths: the config lives in /tmp, so src/test/out/libs get rewritten to
// absolute paths anchored at the real project root. Without this, forge resolves
// `src = "contracts"` relative to the config's tmpdir and silently finds no sources.
// The URL stays in the config file (mode 0o600) and off the child env, keeping it
// out of /proc/<forge>/environ and out of reach of Foundry's vm.envString cheatcode.
const { configPath, cleanup } = createEphemeralFoundryRpcConfig("base", rpcUrl, {
  absolutePaths: true,
});
let exitCode = 0;

try {
  for (const testFile of tests) {
    const result = spawnSync(
      "forge",
      [
        "test",
        "--config-path",
        configPath,
        "--match-path",
        testFile,
        "--fork-url",
        "base",
        "--fork-block-number",
        forkBlock,
      ],
      {
        stdio: "inherit",
        env: createRestrictedChildEnv(),
      },
    );
    if (result.status !== 0) {
      exitCode = result.status ?? 1;
      break;
    }
  }
} finally {
  cleanup();
}

if (exitCode !== 0) {
  process.exit(exitCode);
}
