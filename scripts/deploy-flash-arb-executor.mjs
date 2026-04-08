import "dotenv/config";
import { spawnSync } from "node:child_process";

const DEFAULT_UNISWAP_V3_SWAP_ROUTER = "0xE592427A0AEce92De3Edee1F18E0157C05861564";
const DEFAULT_UNISWAP_V3_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
const DEFAULT_UNISWAP_V3_POOL_INIT_CODE_HASH =
  "0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54";

const CHAIN_PRESETS = {
  mainnet: {
    ajnaToken: "0x9a96ec9B57Fb64FbC60B423d1f4da7691Bd35079",
    explicitRpcEnv: "MAINNET_RPC_URL",
    alchemySlug: "eth-mainnet",
    infuraSlug: "mainnet",
  },
  base: {
    ajnaToken: "0xf0f326af3b1Ed943ab95C29470730CC8Cf66ae47",
    explicitRpcEnv: "BASE_RPC_URL",
    alchemySlug: "base-mainnet",
    infuraSlug: null,
  },
  arbitrum: {
    ajnaToken: "0xA98c94d67D9dF259Bee2E7b519dF75aB00E3E2A8",
    explicitRpcEnv: "ARBITRUM_RPC_URL",
    alchemySlug: "arb-mainnet",
    infuraSlug: "arbitrum-mainnet",
  },
  optimism: {
    ajnaToken: "0x6c518f9D1a163379235816c543E62922a79863Fa",
    explicitRpcEnv: "OPTIMISM_RPC_URL",
    alchemySlug: "opt-mainnet",
    infuraSlug: "optimism-mainnet",
  },
  polygon: {
    ajnaToken: "0xA63b19647787Da652D0826424460D1BBf43Bf9c6",
    explicitRpcEnv: "POLYGON_RPC_URL",
    alchemySlug: "polygon-mainnet",
    infuraSlug: "polygon-mainnet",
  },
};

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
  const apiKey = process.env.RPC_API_KEY?.trim();
  if (!provider || !apiKey || !preset) {
    throw new Error(
      "DEPLOY_RPC_URL or DEPLOY_CHAIN plus RPC_PROVIDER/RPC_API_KEY is required for deployment.",
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

const ajnaToken = requireHex(
  "FLASH_ARB_EXECUTOR_AJNA_TOKEN",
  process.env.FLASH_ARB_EXECUTOR_AJNA_TOKEN || preset?.ajnaToken,
  40,
);
const swapRouter = requireHex(
  "FLASH_ARB_EXECUTOR_SWAP_ROUTER",
  process.env.FLASH_ARB_EXECUTOR_SWAP_ROUTER || DEFAULT_UNISWAP_V3_SWAP_ROUTER,
  40,
);
const uniswapV3Factory = requireHex(
  "FLASH_ARB_EXECUTOR_UNISWAP_V3_FACTORY",
  process.env.FLASH_ARB_EXECUTOR_UNISWAP_V3_FACTORY || DEFAULT_UNISWAP_V3_FACTORY,
  40,
);
const uniswapV3PoolInitCodeHash = requireHex(
  "FLASH_ARB_EXECUTOR_UNISWAP_V3_POOL_INIT_CODE_HASH",
  process.env.FLASH_ARB_EXECUTOR_UNISWAP_V3_POOL_INIT_CODE_HASH || DEFAULT_UNISWAP_V3_POOL_INIT_CODE_HASH,
  64,
);
const rpcUrl = resolveRpcUrl(chainName, preset);

const forgeArgs = [
  "script",
  "script/DeployFlashArbExecutor.s.sol:DeployFlashArbExecutorScript",
  "--rpc-url",
  rpcUrl,
  ...process.argv.slice(2),
];

console.error("Preparing FlashArbExecutor deployment", {
  chain: chainName ?? "custom",
  ajnaToken,
  swapRouter,
  uniswapV3Factory,
  uniswapV3PoolInitCodeHash,
  rpcUrlSource: process.env.DEPLOY_RPC_URL
    ? "DEPLOY_RPC_URL"
    : preset?.explicitRpcEnv && process.env[preset.explicitRpcEnv]
    ? preset.explicitRpcEnv
    : "RPC_PROVIDER/RPC_API_KEY",
  forgeArgs,
});

const result = spawnSync("forge", forgeArgs, {
  stdio: "inherit",
  env: {
    ...process.env,
    FLASH_ARB_EXECUTOR_AJNA_TOKEN: ajnaToken,
    FLASH_ARB_EXECUTOR_SWAP_ROUTER: swapRouter,
    FLASH_ARB_EXECUTOR_UNISWAP_V3_FACTORY: uniswapV3Factory,
    FLASH_ARB_EXECUTOR_UNISWAP_V3_POOL_INIT_CODE_HASH: uniswapV3PoolInitCodeHash,
  },
});

process.exit(result.status ?? 1);
