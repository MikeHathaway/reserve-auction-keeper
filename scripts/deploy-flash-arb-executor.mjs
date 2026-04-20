import "dotenv/config";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createEphemeralFoundryRpcConfig } from "./foundry-rpc-config.mjs";
import { createRestrictedChildEnv } from "./child-process-env.mjs";

const STANDARD_UNISWAP_V3_POOL_INIT_CODE_HASH =
  "0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54";
const SUPPORTED_EXECUTOR_KINDS = ["v3v3", "v2v3", "v3v2"];

const CHAIN_PRESETS = {
  mainnet: {
    ajnaToken: "0x9a96ec9B57Fb64FbC60B423d1f4da7691Bd35079",
    explicitRpcEnv: "MAINNET_RPC_URL",
    alchemySlug: "eth-mainnet",
    infuraSlug: "mainnet",
    uniswapV2: {
      factory: "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f",
      swapRouter: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
    },
    uniswapV3: {
      factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
      poolInitCodeHash: STANDARD_UNISWAP_V3_POOL_INIT_CODE_HASH,
      swapRouter: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
    },
  },
  base: {
    ajnaToken: "0xf0f326af3b1Ed943ab95C29470730CC8Cf66ae47",
    explicitRpcEnv: "BASE_RPC_URL",
    alchemySlug: "base-mainnet",
    infuraSlug: null,
    uniswapV2: {
      factory: "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6",
      swapRouter: "0x4752ba5Dbc23f44D87826276BF6fd6b1C372aD24",
    },
    uniswapV3: {
      factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
      poolInitCodeHash: STANDARD_UNISWAP_V3_POOL_INIT_CODE_HASH,
      swapRouter: "0x2626664c2603336E57B271c5C0b26F421741e481",
    },
  },
  arbitrum: {
    ajnaToken: "0xA98c94d67D9dF259Bee2E7b519dF75aB00E3E2A8",
    explicitRpcEnv: "ARBITRUM_RPC_URL",
    alchemySlug: "arb-mainnet",
    infuraSlug: "arbitrum-mainnet",
    uniswapV2: {
      factory: "0xf1D7CC64Fb4452F05c498126312eBE29f30Fbcf9",
      swapRouter: "0x4752ba5Dbc23f44D87826276BF6fd6b1C372aD24",
    },
    uniswapV3: {
      factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
      poolInitCodeHash: STANDARD_UNISWAP_V3_POOL_INIT_CODE_HASH,
      swapRouter: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
    },
  },
  optimism: {
    ajnaToken: "0x6c518f9D1a163379235816c543E62922a79863Fa",
    explicitRpcEnv: "OPTIMISM_RPC_URL",
    alchemySlug: "opt-mainnet",
    infuraSlug: "optimism-mainnet",
    uniswapV2: {
      factory: "0x0c3c1c532F1e39EdF36BE9Fe0bE1410313E074Bf",
      swapRouter: "0x4A7b5Da61326A6379179b40d00F57E5bbDC962c2",
    },
    uniswapV3: {
      factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
      poolInitCodeHash: STANDARD_UNISWAP_V3_POOL_INIT_CODE_HASH,
      swapRouter: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
    },
  },
  polygon: {
    ajnaToken: "0xA63b19647787Da652D0826424460D1BBf43Bf9c6",
    explicitRpcEnv: "POLYGON_RPC_URL",
    alchemySlug: "polygon-mainnet",
    infuraSlug: "polygon-mainnet",
    uniswapV2: {
      factory: "0x9e5A52f57b3038F1B8EeE45F28b3C1967e22799C",
      swapRouter: "0xedf6066A2b290C185783862C7F4776A2C8077AD1",
    },
    uniswapV3: {
      factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
      poolInitCodeHash: STANDARD_UNISWAP_V3_POOL_INIT_CODE_HASH,
      swapRouter: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
    },
  },
};

const DISALLOWED_FORWARD_FLAGS = new Map([
  ["--private-key", "Use --account or --keystore with --password-file instead."],
  ["--mnemonic", "Use --account or --keystore with --password-file instead."],
  ["--mnemonic-passphrase", "Use --account or --keystore with --password-file instead."],
  ["--password", "Use --password-file instead of passing a password on the command line."],
  ["--etherscan-api-key", "Set the verifier API key in the environment instead of passing it on the command line."],
  ["--verifier-api-key", "Set the verifier API key in the environment instead of passing it on the command line."],
  ["--rpc-url", "Use DEPLOY_RPC_URL or DEPLOY_CHAIN instead of forwarding --rpc-url."],
  ["--fork-url", "Use DEPLOY_RPC_URL or DEPLOY_CHAIN instead of forwarding --fork-url."],
  ["-f", "Use DEPLOY_RPC_URL or DEPLOY_CHAIN instead of forwarding -f/--fork-url."],
]);

function parseCliFlag(arg) {
  if (!arg.startsWith("-")) return null;
  const equalsIndex = arg.indexOf("=");
  return equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
}

function shouldRedactFlagValue(flag) {
  if (!flag) return false;
  return /(?:key|secret|password|url)/i.test(flag) || flag === "-f";
}

function sanitizeArgsForLogs(args) {
  const sanitized = [];
  let redactNext = false;

  for (const arg of args) {
    if (redactNext) {
      sanitized.push("[redacted]");
      redactNext = false;
      continue;
    }

    const flag = parseCliFlag(arg);
    if (flag && shouldRedactFlagValue(flag)) {
      if (arg.includes("=")) {
        sanitized.push(`${flag}=[redacted]`);
      } else {
        sanitized.push(flag);
        redactNext = true;
      }
      continue;
    }

    sanitized.push(arg);
  }

  return sanitized;
}

function getVerifierEnvKeys() {
  return Object.keys(process.env).filter((key) =>
    /(?:etherscan|blockscout|verifier|sourcify)/i.test(key)
  );
}

function assertNoUnsafeForwardedArgs(args) {
  for (const arg of args) {
    const flag = parseCliFlag(arg);
    if (!flag) continue;

    const guidance = DISALLOWED_FORWARD_FLAGS.get(flag);
    if (guidance) {
      throw new Error(`Refusing to forward ${flag}. ${guidance}`);
    }
  }
}

function resolveChain() {
  const raw = process.env.DEPLOY_CHAIN?.trim().toLowerCase();
  if (!raw) return null;
  if (!(raw in CHAIN_PRESETS)) {
    throw new Error(
      `Unsupported DEPLOY_CHAIN "${raw}". Expected one of: ${Object.keys(CHAIN_PRESETS).join(", ")}`,
    );
  }
  return raw;
}

function resolveRpcUrl(chainName, preset) {
  if (process.env.DEPLOY_RPC_URL) {
    return process.env.DEPLOY_RPC_URL;
  }

  if (preset?.explicitRpcEnv && process.env[preset.explicitRpcEnv]) {
    return process.env[preset.explicitRpcEnv];
  }

  const provider = process.env.RPC_PROVIDER?.trim().toLowerCase();
  const apiKey = process.env.RPC_API_KEY?.trim() ||
    (process.env.RPC_API_KEY_FILE
      ? readFileSync(process.env.RPC_API_KEY_FILE, "utf-8").trim()
      : "");
  if (!provider || !apiKey || !preset) {
    throw new Error(
      "DEPLOY_RPC_URL or DEPLOY_CHAIN plus RPC_PROVIDER/RPC_API_KEY or RPC_API_KEY_FILE is required for deployment.",
    );
  }

  if (provider === "alchemy" && preset.alchemySlug) {
    return `https://${preset.alchemySlug}.g.alchemy.com/v2/${apiKey}`;
  }

  if (provider === "infura" && preset.infuraSlug) {
    return `https://${preset.infuraSlug}.infura.io/v3/${apiKey}`;
  }

  throw new Error(
    `Unable to auto-construct RPC URL for provider ${provider} on chain ${chainName}. Set DEPLOY_RPC_URL explicitly.`,
  );
}

function requireHex(name, value, expectedLength) {
  if (!value) {
    throw new Error(`${name} is required.`);
  }

  const normalized = value.trim();
  const regex = new RegExp(`^0x[0-9a-fA-F]{${expectedLength}}$`);
  if (!regex.test(normalized)) {
    throw new Error(`${name} must be a 0x-prefixed hex string with ${expectedLength} hex characters.`);
  }

  return normalized;
}

const chainName = resolveChain();
const preset = chainName ? CHAIN_PRESETS[chainName] : null;
const forwardedArgs = process.argv.slice(2);
assertNoUnsafeForwardedArgs(forwardedArgs);
const executorKind = (process.env.FLASH_ARB_EXECUTOR_KIND?.trim().toLowerCase() || "v3v3");
if (!SUPPORTED_EXECUTOR_KINDS.includes(executorKind)) {
  throw new Error(
    `Unsupported FLASH_ARB_EXECUTOR_KIND "${executorKind}". Expected one of: ${SUPPORTED_EXECUTOR_KINDS.join(", ")}`,
  );
}

const ajnaToken = requireHex(
  "FLASH_ARB_EXECUTOR_AJNA_TOKEN",
  process.env.FLASH_ARB_EXECUTOR_AJNA_TOKEN || preset?.ajnaToken,
  40,
);
const defaultSwapRouter = process.env.FLASH_ARB_EXECUTOR_SWAP_ROUTER ||
  (executorKind === "v3v2" ? preset?.uniswapV2?.swapRouter : preset?.uniswapV3?.swapRouter);
const swapRouter = requireHex(
  "FLASH_ARB_EXECUTOR_SWAP_ROUTER",
  defaultSwapRouter,
  40,
);
const rpcUrl = resolveRpcUrl(chainName, preset);

const scriptTarget = executorKind === "v2v3"
  ? "script/DeployFlashArbExecutorV2V3.s.sol:DeployFlashArbExecutorV2V3Script"
  : executorKind === "v3v2"
  ? "script/DeployFlashArbExecutorV3V2.s.sol:DeployFlashArbExecutorV3V2Script"
  : "script/DeployFlashArbExecutor.s.sol:DeployFlashArbExecutorScript";

const forgeArgs = [
  "script",
  scriptTarget,
  "--config-path",
  "",
  "--rpc-url",
  "deploy",
  ...forwardedArgs,
];

const env = createRestrictedChildEnv(
  {
    FLASH_ARB_EXECUTOR_AJNA_TOKEN: ajnaToken,
    FLASH_ARB_EXECUTOR_SWAP_ROUTER: swapRouter,
  },
  getVerifierEnvKeys(),
);

let deploymentDetails = {
  chain: chainName ?? "custom",
  executorKind,
  ajnaToken,
  swapRouter,
  rpcUrlSource: process.env.DEPLOY_RPC_URL
    ? "DEPLOY_RPC_URL"
    : preset?.explicitRpcEnv && process.env[preset.explicitRpcEnv]
    ? preset.explicitRpcEnv
    : process.env.RPC_API_KEY_FILE
    ? "RPC_API_KEY_FILE"
    : "RPC_PROVIDER/RPC_API_KEY",
  forgeArgs: sanitizeArgsForLogs(forgeArgs),
};

// When a chain preset defines a canonical factory / init-code-hash, these are the
// values the executor will trust forever (they're immutable at construction). If an
// operator sets an env override, we loudly flag the divergence — a typo or stale
// shell var here silently turns off the executor's canonical-pool verification.
function warnIfEnvOverridesPreset(envKey, envValue, presetValue, chainLabel) {
  if (!envValue || !presetValue) return;
  if (envValue.toLowerCase() === presetValue.toLowerCase()) return;
  console.warn(
    `⚠  ${envKey} env value (${envValue}) overrides the canonical preset for ` +
      `${chainLabel} (${presetValue}). The deployed executor will trust pools ` +
      `derived from the OVERRIDE, not the canonical Uniswap deployment. ` +
      `Set ${envKey} to an empty string or unset it to use the preset.`,
  );
}

if (executorKind === "v2v3") {
  warnIfEnvOverridesPreset(
    "FLASH_ARB_EXECUTOR_UNISWAP_V2_FACTORY",
    process.env.FLASH_ARB_EXECUTOR_UNISWAP_V2_FACTORY,
    preset?.uniswapV2?.factory,
    chainName ?? "the active chain",
  );
  const uniswapV2Factory = requireHex(
    "FLASH_ARB_EXECUTOR_UNISWAP_V2_FACTORY",
    process.env.FLASH_ARB_EXECUTOR_UNISWAP_V2_FACTORY || preset?.uniswapV2?.factory,
    40,
  );
  env.FLASH_ARB_EXECUTOR_UNISWAP_V2_FACTORY = uniswapV2Factory;
  deploymentDetails = {
    ...deploymentDetails,
    uniswapV2Factory,
  };
} else {
  warnIfEnvOverridesPreset(
    "FLASH_ARB_EXECUTOR_UNISWAP_V3_FACTORY",
    process.env.FLASH_ARB_EXECUTOR_UNISWAP_V3_FACTORY,
    preset?.uniswapV3?.factory,
    chainName ?? "the active chain",
  );
  warnIfEnvOverridesPreset(
    "FLASH_ARB_EXECUTOR_UNISWAP_V3_POOL_INIT_CODE_HASH",
    process.env.FLASH_ARB_EXECUTOR_UNISWAP_V3_POOL_INIT_CODE_HASH,
    preset?.uniswapV3?.poolInitCodeHash ?? STANDARD_UNISWAP_V3_POOL_INIT_CODE_HASH,
    chainName ?? "the active chain",
  );
  const uniswapV3Factory = requireHex(
    "FLASH_ARB_EXECUTOR_UNISWAP_V3_FACTORY",
    process.env.FLASH_ARB_EXECUTOR_UNISWAP_V3_FACTORY || preset?.uniswapV3?.factory,
    40,
  );
  const uniswapV3PoolInitCodeHash = requireHex(
    "FLASH_ARB_EXECUTOR_UNISWAP_V3_POOL_INIT_CODE_HASH",
    process.env.FLASH_ARB_EXECUTOR_UNISWAP_V3_POOL_INIT_CODE_HASH ||
      preset?.uniswapV3?.poolInitCodeHash ||
      STANDARD_UNISWAP_V3_POOL_INIT_CODE_HASH,
    64,
  );
  env.FLASH_ARB_EXECUTOR_UNISWAP_V3_FACTORY = uniswapV3Factory;
  env.FLASH_ARB_EXECUTOR_UNISWAP_V3_POOL_INIT_CODE_HASH = uniswapV3PoolInitCodeHash;
  deploymentDetails = {
    ...deploymentDetails,
    uniswapV3Factory,
    uniswapV3PoolInitCodeHash,
  };
}

console.error("Preparing FlashArbExecutor deployment", {
  ...deploymentDetails,
});

const { configPath, cleanup } = createEphemeralFoundryRpcConfig("deploy", rpcUrl);
forgeArgs[3] = configPath;

let exitCode = 1;
try {
  const result = spawnSync("forge", forgeArgs, {
    stdio: "inherit",
    env,
  });
  exitCode = result.status ?? 1;
} finally {
  cleanup();
}

process.exit(exitCode);
