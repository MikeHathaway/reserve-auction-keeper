import { describe, it, expect } from "vitest";
import {
  MAINNET_CONFIG,
  BASE_CONFIG,
  POLYGON_CONFIG,
  CHAIN_CONFIGS,
} from "../../src/chains/index.js";
import { isAddress } from "viem";

describe("chains", () => {
  it("mainnet config has valid addresses", () => {
    expect(isAddress(MAINNET_CONFIG.ajnaToken)).toBe(true);
    expect(isAddress(MAINNET_CONFIG.poolFactory)).toBe(true);
    expect(isAddress(MAINNET_CONFIG.poolInfoUtils)).toBe(true);
    for (const addr of Object.values(MAINNET_CONFIG.quoteTokens)) {
      expect(isAddress(addr)).toBe(true);
    }
  });

  it("base config has valid addresses", () => {
    expect(isAddress(BASE_CONFIG.ajnaToken)).toBe(true);
    expect(isAddress(BASE_CONFIG.poolFactory)).toBe(true);
    expect(isAddress(BASE_CONFIG.poolInfoUtils)).toBe(true);
    for (const addr of Object.values(BASE_CONFIG.quoteTokens)) {
      expect(isAddress(addr)).toBe(true);
    }
  });

  it("mainnet uses flashbots, base uses private-rpc", () => {
    expect(MAINNET_CONFIG.mevMethod).toBe("flashbots");
    expect(BASE_CONFIG.mevMethod).toBe("private-rpc");
  });

  it("both chains have WETH, USDC, DAI quote tokens", () => {
    for (const config of [MAINNET_CONFIG, BASE_CONFIG]) {
      expect(config.quoteTokens).toHaveProperty("WETH");
      expect(config.quoteTokens).toHaveProperty("USDC");
      expect(config.quoteTokens).toHaveProperty("DAI");
    }
  });

  it("CHAIN_CONFIGS contains both chains", () => {
    expect(CHAIN_CONFIGS).toHaveProperty("mainnet");
    expect(CHAIN_CONFIGS).toHaveProperty("base");
  });

  it("base uses bwAJNA (different from mainnet AJNA)", () => {
    expect(BASE_CONFIG.ajnaToken).not.toBe(MAINNET_CONFIG.ajnaToken);
  });

  it("mainnet gas estimate is higher than base", () => {
    expect(MAINNET_CONFIG.estimatedGasCostUsd).toBeGreaterThan(
      BASE_CONFIG.estimatedGasCostUsd,
    );
  });

  it("polygon uses a lower native-token USD price than ETH chains", () => {
    expect(POLYGON_CONFIG.nativeTokenPriceUsd).toBeLessThan(
      MAINNET_CONFIG.nativeTokenPriceUsd,
    );
    expect(BASE_CONFIG.nativeTokenPriceUsd).toBe(MAINNET_CONFIG.nativeTokenPriceUsd);
  });
});
