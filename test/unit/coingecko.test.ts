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
    vi.useRealTimers();
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

  it("uses demo host and header when configured explicitly", async () => {
    const tokenId = "demo-plan-token";
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ [tokenId]: { usd: 0.003 } }),
    });

    const client = createCoingeckoClient("test-key", "demo");
    await expect(client.getPrice(tokenId)).resolves.toBe(0.003);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0]?.[0]).toContain("https://api.coingecko.com/api/v3");
    expect(mockFetch.mock.calls[0]?.[1]?.headers).toMatchObject({
      "x-cg-demo-api-key": "test-key",
    });
  });

  it("auto-switches from pro to demo host on auth host mismatch", async () => {
    const tokenId = "auto-plan-switch-token";
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({
          error_code: 10011,
          message: "This request must use the non-Pro API host with a Demo API key.",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ [tokenId]: { usd: 0.003 } }),
      });

    const client = createCoingeckoClient("test-key", "auto");
    await expect(client.getPrice(tokenId)).resolves.toBe(0.003);
    await expect(client.getPrice(tokenId)).resolves.toBe(0.003);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[0]?.[0]).toContain("https://pro-api.coingecko.com/api/v3");
    expect(mockFetch.mock.calls[0]?.[1]?.headers).toMatchObject({
      "x-cg-pro-api-key": "test-key",
    });
    expect(mockFetch.mock.calls[1]?.[0]).toContain("https://api.coingecko.com/api/v3");
    expect(mockFetch.mock.calls[1]?.[1]?.headers).toMatchObject({
      "x-cg-demo-api-key": "test-key",
    });
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

  it("returns fresh cached price without re-fetching", async () => {
    const tokenId = "fresh-cache-token";
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ [tokenId]: { usd: 0.003 } }),
    });

    const client = createCoingeckoClient("test-key");
    await expect(client.getPrice(tokenId)).resolves.toBe(0.003);
    await expect(client.getPrice(tokenId)).resolves.toBe(0.003);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("batches multiple token ids into one request", async () => {
    const ajnaTokenId = "batch-ajna-token";
    const quoteTokenId = "batch-quote-token";
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        [ajnaTokenId]: { usd: 0.003 },
        [quoteTokenId]: { usd: 1 },
      }),
    });

    const client = createCoingeckoClient("test-key");
    const prices = await client.getPrices([ajnaTokenId, quoteTokenId]);

    expect(prices.get(ajnaTokenId)).toBe(0.003);
    expect(prices.get(quoteTokenId)).toBe(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0]?.[0]).toContain(`ids=${ajnaTokenId}%2C${quoteTokenId}`);
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
    const tokenId = "deviation-token";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-31T00:00:00.000Z"));

    // First call sets baseline
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ [tokenId]: { usd: 0.003 } }),
    });

    const client = createCoingeckoClient("test-key");
    await client.getPrice(tokenId);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);

    // Second call has huge deviation (>20%)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ [tokenId]: { usd: 0.01 } }),
    });

    const price = await client.getPrice(tokenId);
    expect(price).toBeNull();
  });

  it("accepts a large repricing after a second consistent observation", async () => {
    const tokenId = "confirmed-deviation-token";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-31T00:00:00.000Z"));

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ [tokenId]: { usd: 0.003 } }),
    });

    const client = createCoingeckoClient("test-key");
    await expect(client.getPrice(tokenId)).resolves.toBe(0.003);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ [tokenId]: { usd: 0.01 } }),
    });
    await expect(client.getPrice(tokenId)).resolves.toBeNull();
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ [tokenId]: { usd: 0.0102 } }),
    });
    await expect(client.getPrice(tokenId)).resolves.toBe(0.0102);
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
