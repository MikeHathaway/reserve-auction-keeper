import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { loadConfig } from "../../src/config.js";
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const TMP_DIR = join(process.cwd(), "test", "tmp");
const CONFIG_FILE = join(TMP_DIR, "test-config.json");

function writeConfig(config: object) {
  if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config));
}

describe("config", () => {
  beforeEach(() => {
    process.env.PRIVATE_KEY = "0x" + "ab".repeat(32);
    process.env.COINGECKO_API_KEY = "test-api-key";
  });

  afterEach(() => {
    try {
      unlinkSync(CONFIG_FILE);
    } catch {}
    delete process.env.PRIVATE_KEY;
    delete process.env.COINGECKO_API_KEY;
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

  it("throws on missing PRIVATE_KEY", () => {
    delete process.env.PRIVATE_KEY;
    writeConfig({
      chains: {
        base: { enabled: true, rpcUrl: "https://base-rpc.example.com" },
      },
      funded: { targetExitPriceUsd: 0.1 },
    });

    expect(() => loadConfig(CONFIG_FILE)).toThrow("PRIVATE_KEY is required");
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
      quoteToAjnaPaths: {
        USDC: "0x01020304",
      },
    });
  });
});
