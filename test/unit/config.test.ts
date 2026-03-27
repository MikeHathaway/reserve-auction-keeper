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
    process.env.BASE_RPC_URL = "https://base-rpc.example.com";
  });

  afterEach(() => {
    try {
      unlinkSync(CONFIG_FILE);
    } catch {}
    delete process.env.PRIVATE_KEY;
    delete process.env.COINGECKO_API_KEY;
    delete process.env.BASE_RPC_URL;
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

  it("loads both chains when enabled", () => {
    process.env.MAINNET_RPC_URL = "https://mainnet-rpc.example.com";
    writeConfig({
      chains: {
        base: { enabled: true, rpcUrl: "https://base-rpc.example.com" },
        mainnet: { enabled: true, rpcUrl: "https://mainnet-rpc.example.com" },
      },
      funded: { targetExitPriceUsd: 0.1 },
    });

    const config = loadConfig(CONFIG_FILE);
    expect(config.chains).toHaveLength(2);
    delete process.env.MAINNET_RPC_URL;
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
});
