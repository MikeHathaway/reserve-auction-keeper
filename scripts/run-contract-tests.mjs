import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const TEST_DIR = join(process.cwd(), "contracts", "test");

function collectContractTests(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectContractTests(fullPath));
      continue;
    }
    if (!entry.name.endsWith(".t.sol")) continue;
    if (entry.name.endsWith(".mainnet-fork.t.sol")) continue;
    if (entry.name.endsWith(".base-fork.t.sol")) continue;
    files.push(fullPath);
  }

  return files.sort();
}

const tests = collectContractTests(TEST_DIR);
if (tests.length === 0) {
  console.error("No offline Solidity test files found.");
  process.exit(1);
}

for (const testFile of tests) {
  const result = spawnSync(
    "forge",
    ["test", "--offline", "--match-path", testFile],
    { stdio: "inherit" },
  );
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
