import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../../src/config.js";
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
    delete process.env.COINGECKO_API_KEY;
    delete process.env.COINGECKO_API_PLAN;
    delete process.env.RPC_PROVIDER;
    delete process.env.RPC_API_KEY;
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
    expect(config.funded.targetExitPriceUsd).toBe(0.1);
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

    expect(() => loadConfig(CONFIG_FILE)).toThrow("COINGECKO_API_KEY is required");
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

  it("throws on missing ALCHEMY_API_KEY when pricing provider needs it", () => {
    delete process.env.ALCHEMY_API_KEY;
    writeConfig({
      chains: {
        base: { enabled: true, rpcUrl: "https://base-rpc.example.com" },
      },
      pricing: {
        provider: "alchemy",
      },
      funded: { targetExitPriceUsd: 0.1 },
    });

    expect(() => loadConfig(CONFIG_FILE)).toThrow("ALCHEMY_API_KEY is required");
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
        maxSlippagePercent: 0.5,
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
      maxSlippagePercent: 0.5,
      minLiquidityUsd: 250,
      minProfitUsd: 5,
      executorAddress: "0x1234567890123456789012345678901234567890",
    });
    expect(config.flashArb.routes.base).toEqual({
      quoterAddress: "0x1111111111111111111111111111111111111111",
      flashLoanPools: {
        USDC: "0x2222222222222222222222222222222222222222",
      },
      quoteToAjnaPaths: {
        USDC: "0x01020304",
      },
    });
  });

  it("normalizes flash-arb route symbols to uppercase", () => {
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
              usdc: "0x2222222222222222222222222222222222222222",
            },
            quoteToAjnaPaths: {
              usdc: "0x01020304",
            },
          },
        },
      },
      dryRun: true,
    });

    const config = loadConfig(CONFIG_FILE);
    expect(config.flashArb.routes.base?.flashLoanPools.USDC).toBe(
      "0x2222222222222222222222222222222222222222",
    );
    expect(config.flashArb.routes.base?.quoteToAjnaPaths.USDC).toBe("0x01020304");
  });
});
