import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createCoingeckoClient } from "../../src/pricing/coingecko.js";

describe("coingecko", () => {
  const mockFetch = vi.fn();
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = mockFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("fetches price successfully", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ "ajna-protocol": { usd: 0.003 } }),
    });

    const client = createCoingeckoClient("test-key");
    const price = await client.getPrice("ajna-protocol");
    expect(price).toBe(0.003);
  });

  it("returns cached price on rate limit (429)", async () => {
    // First call succeeds
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ "ajna-protocol": { usd: 0.003 } }),
    });

    const client = createCoingeckoClient("test-key");
    await client.getPrice("ajna-protocol");

    // Second call is rate limited
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: async () => ({}),
    });

    const price = await client.getPrice("ajna-protocol");
    expect(price).toBe(0.003); // cached
  });

  it("returns null when no cached price and API fails", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({}),
    });

    // Use a unique token ID to avoid cache leakage from other tests
    const client = createCoingeckoClient("test-key");
    const price = await client.getPrice("unknown-token-xyz");
    expect(price).toBeNull();
  });

  it("returns null on price deviation exceeding threshold", async () => {
    // First call sets baseline
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ "ajna-protocol": { usd: 0.003 } }),
    });

    const client = createCoingeckoClient("test-key");
    await client.getPrice("ajna-protocol");

    // Second call has huge deviation (>20%)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ "ajna-protocol": { usd: 0.01 } }),
    });

    const price = await client.getPrice("ajna-protocol");
    expect(price).toBeNull();
  });

  it("handles network errors gracefully", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network error"));

    // Use a unique token ID to avoid cache leakage
    const client = createCoingeckoClient("test-key");
    const price = await client.getPrice("network-error-token");
    expect(price).toBeNull();
  });

  it("detects stale prices", async () => {
    // Use unique token ID to avoid cache leakage
    const tokenId = "stale-test-token";
    const client = createCoingeckoClient("test-key");
    expect(client.isPriceStale(tokenId)).toBe(true); // no cache = stale

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ [tokenId]: { usd: 0.003 } }),
    });
    await client.getPrice(tokenId);

    expect(client.isPriceStale(tokenId)).toBe(false); // just fetched
  });
});
