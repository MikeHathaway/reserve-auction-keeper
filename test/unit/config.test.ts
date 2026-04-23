import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { loadConfig } from "../../src/config.js";
import { BASE_CONFIG } from "../../src/chains/index.js";
import { logger } from "../../src/utils/logger.js";
import { createCipheriv, scryptSync } from "node:crypto";
import { writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { keccak256 } from "viem";

const TMP_DIR = join(process.cwd(), "test", "tmp");
const CONFIG_FILE = join(TMP_DIR, "test-config.json");
const DEFAULT_PRIVATE_KEY = "0x" + "ab".repeat(32);
const DEFAULT_FLASHBOTS_AUTH_KEY = "0x" + "cd".repeat(32);
const KEYSTORE_PASSWORD = "correct horse battery staple";
const TEST_SCRYPT_MAXMEM_BYTES = 512 * 1024 * 1024;

function encodeUniswapV3Path(tokenIn: string, fee: number, tokenOut: string): `0x${string}` {
  return `0x${tokenIn.slice(2)}${fee.toString(16).padStart(6, "0")}${tokenOut.slice(2)}` as `0x${string}`;
}

function writeConfig(config: object) {
  if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config));
}

function writeSecretFile(filename: string, contents: string): string {
  if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });
  const filePath = join(TMP_DIR, filename);
  writeFileSync(filePath, contents);
  return filePath;
}

function buildKeystore(
  privateKey: string,
  password: string,
  scryptParams: { n: number; r: number; p: number } = { n: 1024, r: 8, p: 1 },
): string {
  const salt = Buffer.from("11".repeat(32), "hex");
  const iv = Buffer.from("22".repeat(16), "hex");
  const derivedKey = scryptSync(password, salt, 32, {
    N: scryptParams.n,
    r: scryptParams.r,
    p: scryptParams.p,
    maxmem: TEST_SCRYPT_MAXMEM_BYTES,
  });

  const cipher = createCipheriv(
    "aes-128-ctr",
    derivedKey.subarray(0, 16),
    iv,
  );
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(privateKey.slice(2), "hex")),
    cipher.final(),
  ]);
  const mac = keccak256(
    `0x${Buffer.concat([derivedKey.subarray(16, 32), ciphertext]).toString("hex")}`,
  ).slice(2);

  return JSON.stringify({
    version: 3,
    crypto: {
      cipher: "aes-128-ctr",
      cipherparams: {
        iv: iv.toString("hex"),
      },
      ciphertext: ciphertext.toString("hex"),
      kdf: "scrypt",
      kdfparams: {
        dklen: 32,
        salt: salt.toString("hex"),
        n: scryptParams.n,
        r: scryptParams.r,
        p: scryptParams.p,
      },
      mac,
    },
  });
}

describe("config", () => {
  beforeEach(() => {
    process.env.PRIVATE_KEY = DEFAULT_PRIVATE_KEY;
    process.env.COINGECKO_API_KEY = "test-api-key";
    process.env.ALCHEMY_API_KEY = "test-alchemy-price-key";
  });

  afterEach(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
    delete process.env.PRIVATE_KEY;
    delete process.env.PRIVATE_KEY_FILE;
    delete process.env.KEYSTORE_PATH;
    delete process.env.KEYSTORE_PASSWORD;
    delete process.env.KEYSTORE_PASSWORD_FILE;
    delete process.env.FLASHBOTS_AUTH_KEY;
    delete process.env.FLASHBOTS_AUTH_KEY_FILE;
    delete process.env.ALCHEMY_API_KEY;
    delete process.env.ALCHEMY_API_KEY_FILE;
    delete process.env.COINGECKO_API_KEY;
    delete process.env.COINGECKO_API_KEY_FILE;
    delete process.env.COINGECKO_API_PLAN;
    delete process.env.RPC_PROVIDER;
    delete process.env.RPC_API_KEY;
    delete process.env.RPC_API_KEY_FILE;
  });

  it("loads valid config", () => {
    writeConfig({
      chains: {
        base: { enabled: true, rpcUrl: "https://base-rpc.example.com" },
      },
      strategy: "funded",
      funded: { targetExitPriceUsd: 0.1 },
      dryRun: true,
    });

    const config = loadConfig(CONFIG_FILE);
    expect(config.chains).toHaveLength(1);
    expect(config.chains[0].chainConfig.name).toBe("base");
    expect(config.strategy).toBe("funded");
    expect(config.dryRun).toBe(true);
    expect(config.chains[0].funded.targetExitPriceUsd).toBe(0.1);
    expect(config.pricing.provider).toBe("coingecko");
  });

  it("defaults dryRun to true", () => {
    writeConfig({
      chains: {
        base: { enabled: true, rpcUrl: "https://base-rpc.example.com" },
      },
      funded: { targetExitPriceUsd: 0.1 },
    });

    const config = loadConfig(CONFIG_FILE);
    expect(config.dryRun).toBe(true);
  });

  it("throws on missing trading key input", () => {
    delete process.env.PRIVATE_KEY;
    writeConfig({
      chains: {
        base: { enabled: true, rpcUrl: "https://base-rpc.example.com" },
      },
      funded: { targetExitPriceUsd: 0.1 },
    });

    expect(() => loadConfig(CONFIG_FILE)).toThrow(
      "One of PRIVATE_KEY, PRIVATE_KEY_FILE, or KEYSTORE_PATH is required",
    );
  });

  it("throws on missing COINGECKO_API_KEY", () => {
    delete process.env.COINGECKO_API_KEY;
    writeConfig({
      chains: {
        base: { enabled: true, rpcUrl: "https://base-rpc.example.com" },
      },
      funded: { targetExitPriceUsd: 0.1 },
    });

    expect(() => loadConfig(CONFIG_FILE)).toThrow(
      "COINGECKO_API_KEY or COINGECKO_API_KEY_FILE is required",
    );
  });

  it("does not require COINGECKO_API_KEY when pricing provider is alchemy", () => {
    delete process.env.COINGECKO_API_KEY;
    writeConfig({
      chains: {
        base: { enabled: true, rpcUrl: "https://base-rpc.example.com" },
      },
      pricing: {
        provider: "alchemy",
      },
      funded: { targetExitPriceUsd: 0.1 },
    });

    const config = loadConfig(CONFIG_FILE);
    expect(config.pricing.provider).toBe("alchemy");
    expect(config.secrets.alchemyApiKey).toBe("test-alchemy-price-key");
  });

  it("loads hybrid pricing provider", () => {
    writeConfig({
      chains: {
        base: { enabled: true, rpcUrl: "https://base-rpc.example.com" },
      },
      pricing: {
        provider: "hybrid",
      },
      funded: { targetExitPriceUsd: 0.1 },
    });

    const config = loadConfig(CONFIG_FILE);
    expect(config.pricing.provider).toBe("hybrid");
  });

  it("defaults COINGECKO_API_PLAN to auto", () => {
    writeConfig({
      chains: {
        base: { enabled: true, rpcUrl: "https://base-rpc.example.com" },
      },
      funded: { targetExitPriceUsd: 0.1 },
    });

    const config = loadConfig(CONFIG_FILE);
    expect(config.secrets.coingeckoApiPlan).toBe("auto");
  });

  it("loads explicit COINGECKO_API_PLAN", () => {
    process.env.COINGECKO_API_PLAN = "demo";
    writeConfig({
      chains: {
        base: { enabled: true, rpcUrl: "https://base-rpc.example.com" },
      },
      funded: { targetExitPriceUsd: 0.1 },
    });

    const config = loadConfig(CONFIG_FILE);
    expect(config.secrets.coingeckoApiPlan).toBe("demo");
  });

  it("rejects invalid COINGECKO_API_PLAN values", () => {
    process.env.COINGECKO_API_PLAN = "invalid";
    writeConfig({
      chains: {
        base: { enabled: true, rpcUrl: "https://base-rpc.example.com" },
      },
      funded: { targetExitPriceUsd: 0.1 },
    });

    expect(() => loadConfig(CONFIG_FILE)).toThrow(
      "COINGECKO_API_PLAN must be one of: auto, demo, pro",
    );
  });

  it("reuses RPC_API_KEY for Alchemy pricing when RPC_PROVIDER=alchemy", () => {
    delete process.env.ALCHEMY_API_KEY;
    delete process.env.COINGECKO_API_KEY;
    process.env.RPC_PROVIDER = "alchemy";
    process.env.RPC_API_KEY = "shared-alchemy-key";
    writeConfig({
      chains: {
        base: { enabled: true },
      },
      pricing: {
        provider: "alchemy",
      },
      funded: { targetExitPriceUsd: 0.1 },
    });

    const config = loadConfig(CONFIG_FILE);
    expect(config.secrets.alchemyApiKey).toBe("shared-alchemy-key");
  });

  it("loads COINGECKO_API_KEY_FILE when configured", () => {
    delete process.env.COINGECKO_API_KEY;
    process.env.COINGECKO_API_KEY_FILE = writeSecretFile("coingecko.key", "file-coingecko-key\n");
    writeConfig({
      chains: {
        base: { enabled: true, rpcUrl: "https://base-rpc.example.com" },
      },
      funded: { targetExitPriceUsd: 0.1 },
    });

    const config = loadConfig(CONFIG_FILE);
    expect(config.secrets.coingeckoApiKey).toBe("file-coingecko-key");
  });

  it("reuses RPC_API_KEY_FILE for Alchemy pricing when RPC_PROVIDER=alchemy", () => {
    delete process.env.ALCHEMY_API_KEY;
    delete process.env.COINGECKO_API_KEY;
    process.env.RPC_PROVIDER = "alchemy";
    process.env.RPC_API_KEY_FILE = writeSecretFile("rpc-provider.key", "shared-file-alchemy-key\n");
    writeConfig({
      chains: {
        base: { enabled: true },
      },
      pricing: {
        provider: "alchemy",
      },
      funded: { targetExitPriceUsd: 0.1 },
    });

    const config = loadConfig(CONFIG_FILE);
    expect(config.secrets.alchemyApiKey).toBe("shared-file-alchemy-key");
    expect(config.secrets.rpcApiKey).toBe("shared-file-alchemy-key");
  });

  it("throws on missing ALCHEMY_API_KEY when pricing provider needs it", () => {
    delete process.env.ALCHEMY_API_KEY;
    writeConfig({
      chains: {
        base: { enabled: true, rpcUrl: "https://base-rpc.example.com" },
      },
      pricing: {
        provider: "hybrid",
      },
      funded: { targetExitPriceUsd: 0.1 },
    });

    expect(() => loadConfig(CONFIG_FILE)).toThrow(
      "ALCHEMY_API_KEY or ALCHEMY_API_KEY_FILE is required",
    );
  });

  it("throws when no chains enabled", () => {
    writeConfig({
      chains: {
        base: { enabled: false, rpcUrl: "https://base-rpc.example.com" },
      },
      funded: { targetExitPriceUsd: 0.1 },
    });

    expect(() => loadConfig(CONFIG_FILE)).toThrow("No chains enabled");
  });

  it("throws on invalid JSON", () => {
    if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });
    writeFileSync(CONFIG_FILE, "not json");
    expect(() => loadConfig(CONFIG_FILE)).toThrow();
  });

  it("loads multiple chains when enabled", () => {
    writeConfig({
      chains: {
        base: { enabled: true, rpcUrl: "https://base-rpc.example.com" },
        mainnet: { enabled: true, rpcUrl: "https://mainnet-rpc.example.com" },
        arbitrum: { enabled: true, rpcUrl: "https://arb-rpc.example.com" },
      },
      funded: { targetExitPriceUsd: 0.1 },
    });

    const config = loadConfig(CONFIG_FILE);
    expect(config.chains).toHaveLength(3);
  });

  it("auto-constructs RPC URLs from provider API key", () => {
    process.env.RPC_PROVIDER = "alchemy";
    process.env.RPC_API_KEY = "test-alchemy-key";
    writeConfig({
      chains: {
        base: { enabled: true },
        arbitrum: { enabled: true },
        optimism: { enabled: true },
      },
      funded: { targetExitPriceUsd: 0.1 },
    });

    const config = loadConfig(CONFIG_FILE);
    expect(config.chains).toHaveLength(3);
    expect(config.chains[0].rpcUrl).toContain("alchemy.com");
    expect(config.chains[0].rpcUrl).toContain("test-alchemy-key");
    expect(config.chains[1].rpcUrl).toContain("alchemy.com");
    expect(config.chains[2].rpcUrl).toContain("alchemy.com");
  });

  it("falls back to default public RPC when no key or URL provided", () => {
    writeConfig({
      chains: {
        base: { enabled: true },
      },
      funded: { targetExitPriceUsd: 0.1 },
    });

    const config = loadConfig(CONFIG_FILE);
    expect(config.chains).toHaveLength(1);
    expect(config.chains[0].rpcUrl).toContain("llamarpc.com");
  });

  it("parses pool addresses from config", () => {
    writeConfig({
      chains: {
        base: {
          enabled: true,
          rpcUrl: "https://base-rpc.example.com",
          pools: ["0x1234567890123456789012345678901234567890"],
        },
      },
      funded: { targetExitPriceUsd: 0.1 },
    });

    const config = loadConfig(CONFIG_FILE);
    expect(config.chains[0].pools).toHaveLength(1);
  });

  it("defaults privateRpcTrusted to false", () => {
    writeConfig({
      chains: {
        base: {
          enabled: true,
          rpcUrl: "https://base-rpc.example.com",
          privateRpcUrl: "https://base-private.example.com",
        },
      },
      funded: { targetExitPriceUsd: 0.1 },
    });

    const config = loadConfig(CONFIG_FILE);
    expect(config.chains[0].privateRpcUrl).toBe("https://base-private.example.com");
    expect(config.chains[0].privateRpcTrusted).toBe(false);
  });

  it("loads privateRpcTrusted when configured", () => {
    writeConfig({
      chains: {
        base: {
          enabled: true,
          rpcUrl: "https://base-rpc.example.com",
          privateRpcUrl: "https://base-private.example.com",
          privateRpcTrusted: true,
        },
      },
      funded: { targetExitPriceUsd: 0.1 },
    });

    const config = loadConfig(CONFIG_FILE);
    expect(config.chains[0].privateRpcTrusted).toBe(true);
  });

  it("merges custom quote tokens into the chain config", () => {
    writeConfig({
      chains: {
        base: {
          enabled: true,
          rpcUrl: "https://base-rpc.example.com",
          quoteTokens: {
            cbbtc: {
              address: "0x1111111111111111111111111111111111111111",
              coingeckoId: "coinbase-wrapped-btc",
            },
          },
        },
      },
      funded: { targetExitPriceUsd: 0.1 },
    });

    const config = loadConfig(CONFIG_FILE);
    expect(config.chains[0].chainConfig.quoteTokens.CBBTC).toBe(
      "0x1111111111111111111111111111111111111111",
    );
    expect(config.chains[0].chainConfig.coingeckoIds.quoteTokens.CBBTC).toBe(
      "coinbase-wrapped-btc",
    );
    expect(config.chains[0].chainConfig.quoteTokens.USDC).toBeDefined();
  });

  it("allows reusing a built-in quote token symbol when the address is unchanged", () => {
    writeConfig({
      chains: {
        base: {
          enabled: true,
          rpcUrl: "https://base-rpc.example.com",
          quoteTokens: {
            usdc: {
              address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            },
          },
        },
      },
      funded: { targetExitPriceUsd: 0.1 },
    });

    const config = loadConfig(CONFIG_FILE);
    expect(config.chains[0].chainConfig.quoteTokens.USDC).toBe(
      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    );
    expect(config.chains[0].chainConfig.coingeckoIds.quoteTokens.USDC).toBe("usd-coin");
  });

  it("requires a new coingeckoId when overriding a built-in quote token address in coingecko mode", () => {
    writeConfig({
      chains: {
        base: {
          enabled: true,
          rpcUrl: "https://base-rpc.example.com",
          quoteTokens: {
            usdc: {
              address: "0x1111111111111111111111111111111111111111",
            },
          },
        },
      },
      funded: { targetExitPriceUsd: 0.1 },
    });

    expect(() => loadConfig(CONFIG_FILE)).toThrow(
      "chains.base.quoteTokens.usdc.coingeckoId is required",
    );
  });

  it("requires coingeckoId for new quote tokens in coingecko mode", () => {
    writeConfig({
      chains: {
        base: {
          enabled: true,
          rpcUrl: "https://base-rpc.example.com",
          quoteTokens: {
            cbbtc: {
              address: "0x1111111111111111111111111111111111111111",
            },
          },
        },
      },
      funded: { targetExitPriceUsd: 0.1 },
    });

    expect(() => loadConfig(CONFIG_FILE)).toThrow(
      "chains.base.quoteTokens.cbbtc.coingeckoId is required",
    );
  });

  it("allows address-only quote token overrides in alchemy mode", () => {
    delete process.env.COINGECKO_API_KEY;
    writeConfig({
      chains: {
        base: {
          enabled: true,
          rpcUrl: "https://base-rpc.example.com",
          quoteTokens: {
            cbbtc: {
              address: "0x1111111111111111111111111111111111111111",
            },
          },
        },
      },
      pricing: {
        provider: "alchemy",
      },
      funded: { targetExitPriceUsd: 0.1 },
    });

    const config = loadConfig(CONFIG_FILE);
    expect(config.chains[0].chainConfig.quoteTokens.CBBTC).toBe(
      "0x1111111111111111111111111111111111111111",
    );
    expect(config.chains[0].chainConfig.coingeckoIds.quoteTokens.CBBTC).toBeUndefined();
  });

  it("drops the inherited coingeckoId when overriding a built-in address in alchemy mode", () => {
    delete process.env.COINGECKO_API_KEY;
    writeConfig({
      chains: {
        base: {
          enabled: true,
          rpcUrl: "https://base-rpc.example.com",
          quoteTokens: {
            usdc: {
              address: "0x1111111111111111111111111111111111111111",
            },
          },
        },
      },
      pricing: {
        provider: "alchemy",
      },
      funded: { targetExitPriceUsd: 0.1 },
    });

    const config = loadConfig(CONFIG_FILE);
    expect(config.chains[0].chainConfig.quoteTokens.USDC).toBe(
      "0x1111111111111111111111111111111111111111",
    );
    expect(config.chains[0].chainConfig.coingeckoIds.quoteTokens.USDC).toBeUndefined();
  });

  it("loads PRIVATE_KEY_FILE when configured", () => {
    delete process.env.PRIVATE_KEY;
    process.env.PRIVATE_KEY_FILE = writeSecretFile("trading.key", `${DEFAULT_PRIVATE_KEY}\n`);
    writeConfig({
      chains: {
        base: { enabled: true, rpcUrl: "https://base-rpc.example.com" },
      },
      funded: { targetExitPriceUsd: 0.1 },
    });

    const config = loadConfig(CONFIG_FILE);
    expect(config.secrets.privateKey).toBe(DEFAULT_PRIVATE_KEY);
  });

  it("loads FLASHBOTS_AUTH_KEY_FILE when configured", () => {
    process.env.FLASHBOTS_AUTH_KEY_FILE = writeSecretFile(
      "flashbots-auth.key",
      DEFAULT_FLASHBOTS_AUTH_KEY,
    );
    writeConfig({
      chains: {
        mainnet: { enabled: true, rpcUrl: "https://mainnet-rpc.example.com" },
      },
      funded: { targetExitPriceUsd: 0.1 },
    });

    const config = loadConfig(CONFIG_FILE);
    expect(config.secrets.flashbotsAuthKey).toBe(DEFAULT_FLASHBOTS_AUTH_KEY);
  });

  it("loads KEYSTORE_PATH with KEYSTORE_PASSWORD_FILE", () => {
    delete process.env.PRIVATE_KEY;
    process.env.KEYSTORE_PATH = writeSecretFile(
      "trading.keystore.json",
      buildKeystore(DEFAULT_PRIVATE_KEY, KEYSTORE_PASSWORD),
    );
    process.env.KEYSTORE_PASSWORD_FILE = writeSecretFile(
      "trading.keystore.password",
      `${KEYSTORE_PASSWORD}\n`,
    );
    writeConfig({
      chains: {
        base: { enabled: true, rpcUrl: "https://base-rpc.example.com" },
      },
      funded: { targetExitPriceUsd: 0.1 },
    });

    const config = loadConfig(CONFIG_FILE);
    expect(config.secrets.privateKey).toBe(DEFAULT_PRIVATE_KEY);
  });

  it("loads KEYSTORE_PATH with realistic scrypt parameters", () => {
    delete process.env.PRIVATE_KEY;
    process.env.KEYSTORE_PATH = writeSecretFile(
      "trading.realistic.keystore.json",
      buildKeystore(DEFAULT_PRIVATE_KEY, KEYSTORE_PASSWORD, {
        n: 262144,
        r: 8,
        p: 1,
      }),
    );
    process.env.KEYSTORE_PASSWORD_FILE = writeSecretFile(
      "trading.realistic.keystore.password",
      `${KEYSTORE_PASSWORD}\n`,
    );
    writeConfig({
      chains: {
        base: { enabled: true, rpcUrl: "https://base-rpc.example.com" },
      },
      funded: { targetExitPriceUsd: 0.1 },
    });

    const config = loadConfig(CONFIG_FILE);
    expect(config.secrets.privateKey).toBe(DEFAULT_PRIVATE_KEY);
  });

  it("throws on invalid keystore password", () => {
    delete process.env.PRIVATE_KEY;
    process.env.KEYSTORE_PATH = writeSecretFile(
      "trading.keystore.json",
      buildKeystore(DEFAULT_PRIVATE_KEY, KEYSTORE_PASSWORD),
    );
    process.env.KEYSTORE_PASSWORD_FILE = writeSecretFile(
      "trading.keystore.password",
      "wrong-password\n",
    );
    writeConfig({
      chains: {
        base: { enabled: true, rpcUrl: "https://base-rpc.example.com" },
      },
      funded: { targetExitPriceUsd: 0.1 },
    });

    expect(() => loadConfig(CONFIG_FILE)).toThrow(
      "Invalid keystore password or MAC mismatch",
    );
  });

  it("throws when multiple trading key sources are configured", () => {
    process.env.PRIVATE_KEY_FILE = writeSecretFile("trading.key", DEFAULT_PRIVATE_KEY);
    writeConfig({
      chains: {
        base: { enabled: true, rpcUrl: "https://base-rpc.example.com" },
      },
      funded: { targetExitPriceUsd: 0.1 },
    });

    expect(() => loadConfig(CONFIG_FILE)).toThrow(
      "Configure exactly one of PRIVATE_KEY, PRIVATE_KEY_FILE, or KEYSTORE_PATH",
    );
  });

  it("loads flash-arb strategy configuration", () => {
    writeConfig({
      chains: {
        mainnet: { enabled: true, rpcUrl: "https://mainnet-rpc.example.com" },
      },
      strategy: "flash-arb",
      flashArb: {
        onChainSlippageFloorPercent: 0.5,
        minLiquidityUsd: 250,
        minProfitUsd: 5,
        executorAddress: "0x1234567890123456789012345678901234567890",
        routes: {
          base: {
            quoterAddress: "0x1111111111111111111111111111111111111111",
            flashLoanPools: {
              USDC: "0x2222222222222222222222222222222222222222",
            },
            quoteToAjnaPaths: {
              USDC: "0x01020304",
            },
          },
        },
      },
      dryRun: true,
    });

    const config = loadConfig(CONFIG_FILE);
    expect(config.strategy).toBe("flash-arb");
    expect(config.flashArb).toMatchObject({
      executorAddress: "0x1234567890123456789012345678901234567890",
    });
    // Thresholds live on the per-chain ResolvedChainConfig, not the top-level
    // AppConfig. The global values set here are the defaults the resolver
    // merges onto each chain.
    expect(config.chains[0].flashArb).toMatchObject({
      onChainSlippageFloorPercent: 0.5,
      minLiquidityUsd: 250,
      minProfitUsd: 5,
    });
    expect(config.flashArb.routes.base).toEqual({
      quoterAddress: "0x1111111111111111111111111111111111111111",
      uniswapV2FactoryAddress: undefined,
      executors: {
        v3v3: "0x1234567890123456789012345678901234567890",
        v2v3: undefined,
        v3v2: undefined,
      },
      sources: {
        USDC: [
          {
            protocol: "uniswap-v3",
            address: "0x2222222222222222222222222222222222222222",
          },
        ],
      },
      swapRoutes: {
        USDC: [
          {
            protocol: "uniswap-v3",
            path: "0x01020304",
          },
        ],
      },
    });
  });

  it("rejects a typo'd per-chain key (strict mode on chainConfigSchema)", () => {
    // Without .strict() on chainConfigSchema, `stratgey` would silently drop
    // and the per-chain strategy override would disappear — the operator
    // would think they enabled flash-arb on mainnet but the top-level funded
    // default would run instead.
    writeConfig({
      chains: {
        mainnet: {
          enabled: true,
          rpcUrl: "https://mainnet-rpc.example.com",
          stratgey: "flash-arb",
        },
      },
      strategy: "funded",
      funded: { targetExitPriceUsd: 0.1 },
    });

    expect(() => loadConfig(CONFIG_FILE)).toThrow(/stratgey/);
  });

  it("rejects a misspelled chain name (strict mode on chains object)", () => {
    writeConfig({
      chains: {
        arbitram: { enabled: true, rpcUrl: "https://arb-rpc.example.com" },
      },
      strategy: "funded",
      funded: { targetExitPriceUsd: 0.1 },
    });

    expect(() => loadConfig(CONFIG_FILE)).toThrow(/arbitram/);
  });

  it("rejects a typo'd top-level config key (strict mode on configFileSchema)", () => {
    writeConfig({
      chains: {
        base: { enabled: true, rpcUrl: "https://base-rpc.example.com" },
      },
      strategy: "funded",
      funded: { targetExitPriceUsd: 0.1 },
      drrunn: false,
    });

    expect(() => loadConfig(CONFIG_FILE)).toThrow(/drrunn/);
  });

  it("rejects the legacy flashArb.maxSlippagePercent key so stale configs fail loudly", () => {
    writeConfig({
      chains: {
        base: { enabled: true, rpcUrl: "https://base-rpc.example.com" },
      },
      strategy: "flash-arb",
      flashArb: {
        maxSlippagePercent: 5,
        minLiquidityUsd: 100,
        minProfitUsd: 0,
      },
    });

    expect(() => loadConfig(CONFIG_FILE)).toThrow(/maxSlippagePercent/);
  });

  it("resolves per-chain strategy overrides over the top-level default", () => {
    const MAINNET_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
    const MAINNET_AJNA = "0x9a96ec9B57Fb64FbC60B423d1f4da7691Bd35079";
    writeConfig({
      chains: {
        base: { enabled: true, rpcUrl: "https://base-rpc.example.com" },
        mainnet: {
          enabled: true,
          rpcUrl: "https://mainnet-rpc.example.com",
          strategy: "flash-arb",
        },
      },
      strategy: "funded",
      funded: { targetExitPriceUsd: 0.1 },
      flashArb: {
        executorAddress: "0x1234567890123456789012345678901234567890",
        routes: {
          mainnet: {
            quoterAddress: "0x1111111111111111111111111111111111111111",
            flashLoanPools: { USDC: "0x2222222222222222222222222222222222222222" },
            quoteToAjnaPaths: {
              USDC: encodeUniswapV3Path(MAINNET_USDC, 500, MAINNET_AJNA),
            },
          },
        },
      },
    });

    const config = loadConfig(CONFIG_FILE);
    const base = config.chains.find((c) => c.chainConfig.name === "base")!;
    const mainnet = config.chains.find((c) => c.chainConfig.name === "mainnet")!;
    expect(base.strategy).toBe("funded");
    expect(mainnet.strategy).toBe("flash-arb");
  });

  it("falls back to the global strategy when a chain omits its own override", () => {
    writeConfig({
      chains: {
        base: { enabled: true, rpcUrl: "https://base-rpc.example.com" },
      },
      strategy: "funded",
      funded: { targetExitPriceUsd: 0.1 },
    });

    const config = loadConfig(CONFIG_FILE);
    expect(config.chains[0].strategy).toBe("funded");
  });

  it("merges per-chain flashArb overrides on top of the global flashArb block", () => {
    const MAINNET_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
    const MAINNET_AJNA = "0x9a96ec9B57Fb64FbC60B423d1f4da7691Bd35079";
    const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
    writeConfig({
      chains: {
        base: {
          enabled: true,
          rpcUrl: "https://base-rpc.example.com",
          strategy: "flash-arb",
        },
        mainnet: {
          enabled: true,
          rpcUrl: "https://mainnet-rpc.example.com",
          strategy: "flash-arb",
          // Mainnet gas costs 10-50x Base; raise the profit floor for mainnet only.
          flashArb: { minProfitUsd: 50 },
        },
      },
      strategy: "flash-arb",
      flashArb: {
        minProfitUsd: 5,
        minLiquidityUsd: 100,
        executorAddress: "0x1234567890123456789012345678901234567890",
        routes: {
          base: {
            quoterAddress: "0x1111111111111111111111111111111111111111",
            flashLoanPools: { USDC: "0x2222222222222222222222222222222222222222" },
            quoteToAjnaPaths: {
              USDC: encodeUniswapV3Path(BASE_USDC, 500, BASE_CONFIG.ajnaToken),
            },
          },
          mainnet: {
            quoterAddress: "0x1111111111111111111111111111111111111111",
            flashLoanPools: { USDC: "0x2222222222222222222222222222222222222222" },
            quoteToAjnaPaths: {
              USDC: encodeUniswapV3Path(MAINNET_USDC, 500, MAINNET_AJNA),
            },
          },
        },
      },
    });

    const config = loadConfig(CONFIG_FILE);
    const base = config.chains.find((c) => c.chainConfig.name === "base")!;
    const mainnet = config.chains.find((c) => c.chainConfig.name === "mainnet")!;
    expect(base.flashArb.minProfitUsd).toBe(5);
    expect(mainnet.flashArb.minProfitUsd).toBe(50);
    // Unspecified fields inherit from the global block.
    expect(mainnet.flashArb.minLiquidityUsd).toBe(100);
  });

  it("rejects a typo'd key in a per-chain flashArb override (strict mode)", () => {
    writeConfig({
      chains: {
        base: {
          enabled: true,
          rpcUrl: "https://base-rpc.example.com",
          strategy: "flash-arb",
          flashArb: { maxSlippagePercent: 0.5 },
        },
      },
      strategy: "funded",
      funded: { targetExitPriceUsd: 0.1 },
    });

    expect(() => loadConfig(CONFIG_FILE)).toThrow(/maxSlippagePercent/);
  });

  it("rejects a typo'd key in the top-level funded block (strict mode)", () => {
    writeConfig({
      chains: {
        base: { enabled: true, rpcUrl: "https://base-rpc.example.com" },
      },
      strategy: "funded",
      // Typo: `tatgetExitPriceUsd` vs `targetExitPriceUsd`. Without strict mode
      // this would silently fall back to the default and the operator's
      // intended value would be ignored.
      funded: { targetExitPriceUsd: 0.1, tatgetExitPriceUsd: 0.5 },
    });

    expect(() => loadConfig(CONFIG_FILE)).toThrow(/tatgetExitPriceUsd/);
  });

  it("rejects a maxTakeAmount that is not a positive integer string", () => {
    for (const bad of ["0", "-1", "abc", "1.5", ""]) {
      writeConfig({
        chains: { base: { enabled: true, rpcUrl: "https://base-rpc.example.com" } },
        strategy: "funded",
        funded: { targetExitPriceUsd: 0.1, maxTakeAmount: bad },
      });
      expect(() => loadConfig(CONFIG_FILE), `maxTakeAmount=${JSON.stringify(bad)} should be rejected`).toThrow(/maxTakeAmount/);
    }
  });

  it("merges per-chain funded overrides on top of the global funded block", () => {
    writeConfig({
      chains: {
        base: {
          enabled: true,
          rpcUrl: "https://base-rpc.example.com",
          strategy: "funded",
          funded: { targetExitPriceUsd: 0.25, maxTakeAmount: "5000000000000000000" },
        },
        arbitrum: {
          enabled: true,
          rpcUrl: "https://arb-rpc.example.com",
          strategy: "funded",
        },
      },
      strategy: "funded",
      funded: { targetExitPriceUsd: 0.1, maxTakeAmount: "1000000000000000000", autoApprove: true },
    });

    const config = loadConfig(CONFIG_FILE);
    const base = config.chains.find((c) => c.chainConfig.name === "base")!;
    const arb = config.chains.find((c) => c.chainConfig.name === "arbitrum")!;
    expect(base.funded.targetExitPriceUsd).toBe(0.25);
    expect(base.funded.maxTakeAmount).toBe(5_000_000_000_000_000_000n);
    expect(base.funded.autoApprove).toBe(true);
    expect(arb.funded.targetExitPriceUsd).toBe(0.1);
    expect(arb.funded.maxTakeAmount).toBe(1_000_000_000_000_000_000n);
  });

  it("warns when a chain has flashArb overrides but resolves to funded", () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      writeConfig({
        chains: {
          base: {
            enabled: true,
            rpcUrl: "https://base-rpc.example.com",
            strategy: "funded",
            flashArb: { minProfitUsd: 5 },
          },
        },
        strategy: "funded",
        funded: { targetExitPriceUsd: 0.1 },
      });
      loadConfig(CONFIG_FILE);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/chains\.base\.flashArb.*strategy is "funded"/),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("warns when a chain has funded overrides but resolves to flash-arb", () => {
    const MAINNET_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
    const MAINNET_AJNA = "0x9a96ec9B57Fb64FbC60B423d1f4da7691Bd35079";
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      writeConfig({
        chains: {
          mainnet: {
            enabled: true,
            rpcUrl: "https://mainnet-rpc.example.com",
            strategy: "flash-arb",
            funded: { targetExitPriceUsd: 0.5 },
          },
        },
        strategy: "flash-arb",
        funded: { targetExitPriceUsd: 0.1 },
        flashArb: {
          executorAddress: "0x1234567890123456789012345678901234567890",
          routes: {
            mainnet: {
              quoterAddress: "0x1111111111111111111111111111111111111111",
              flashLoanPools: { USDC: "0x2222222222222222222222222222222222222222" },
              quoteToAjnaPaths: {
                USDC: encodeUniswapV3Path(MAINNET_USDC, 500, MAINNET_AJNA),
              },
            },
          },
        },
      });
      loadConfig(CONFIG_FILE);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/chains\.mainnet\.funded.*strategy is "flash-arb"/),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("warns when flashArb.routes.<chain> is stale on a funded-resolved chain", () => {
    const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      writeConfig({
        chains: {
          base: {
            enabled: true,
            rpcUrl: "https://base-rpc.example.com",
            strategy: "funded",
          },
        },
        strategy: "funded",
        funded: { targetExitPriceUsd: 0.1 },
        flashArb: {
          executorAddress: "0x1234567890123456789012345678901234567890",
          routes: {
            base: {
              quoterAddress: "0x1111111111111111111111111111111111111111",
              flashLoanPools: { USDC: "0x2222222222222222222222222222222222222222" },
              quoteToAjnaPaths: {
                USDC: encodeUniswapV3Path(BASE_USDC, 500, BASE_CONFIG.ajnaToken),
              },
            },
          },
        },
      });
      loadConfig(CONFIG_FILE);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/flashArb\.routes\.base.*resolves to "funded"/),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("does not require a flashArb route for a chain running the funded strategy", () => {
    writeConfig({
      chains: { base: { enabled: true, rpcUrl: "https://base-rpc.example.com", strategy: "funded" } },
      strategy: "funded",
      funded: { targetExitPriceUsd: 0.1 },
    });
    expect(() => loadConfig(CONFIG_FILE)).not.toThrow();
  });

  it("normalizes flash-arb route symbols to uppercase", () => {
    writeConfig({
      chains: {
        base: { enabled: true, rpcUrl: "https://base-rpc.example.com" },
      },
      strategy: "flash-arb",
      flashArb: {
        executorAddress: "0x1234567890123456789012345678901234567890",
        routes: {
          base: {
            quoterAddress: "0x1111111111111111111111111111111111111111",
            flashLoanPools: {
              usdc: "0x2222222222222222222222222222222222222222",
            },
            quoteToAjnaPaths: {
              usdc: encodeUniswapV3Path(
                BASE_CONFIG.quoteTokens.USDC,
                500,
                BASE_CONFIG.ajnaToken,
              ),
            },
          },
        },
      },
      dryRun: true,
    });

    const config = loadConfig(CONFIG_FILE);
    expect(config.flashArb.routes.base?.sources.USDC).toEqual([
      {
        protocol: "uniswap-v3",
        address: "0x2222222222222222222222222222222222222222",
      },
    ]);
    expect(config.flashArb.routes.base?.swapRoutes.USDC).toEqual([
      {
        protocol: "uniswap-v3",
        path: encodeUniswapV3Path(BASE_CONFIG.quoteTokens.USDC, 500, BASE_CONFIG.ajnaToken),
      },
    ]);
  });

  it("rejects enabled flash-arb routes whose swap path does not start with the quote token or end with AJNA", () => {
    writeConfig({
      chains: {
        base: { enabled: true, rpcUrl: "https://base-rpc.example.com" },
      },
      strategy: "flash-arb",
      flashArb: {
        routes: {
          base: {
            quoterAddress: "0x1111111111111111111111111111111111111111",
            flashLoanPools: {
              USDC: "0x2222222222222222222222222222222222222222",
            },
            quoteToAjnaPaths: {
              USDC: encodeUniswapV3Path(
                BASE_CONFIG.ajnaToken,
                500,
                BASE_CONFIG.quoteTokens.USDC,
              ),
            },
          },
        },
      },
      dryRun: true,
    });

    expect(() => loadConfig(CONFIG_FILE)).toThrow(
      "flashArb.routes.base.swapRoutes.USDC must encode a USDC -> AJNA route",
    );
  });
});
