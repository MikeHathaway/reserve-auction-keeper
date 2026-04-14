import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAlchemyPricesClient } from "../../src/pricing/alchemy.js";

const NETWORK = "eth-mainnet";
const AJNA = "0x9a96ec9B57Fb64FbC60B423d1f4da7691Bd35079";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const STALE_ADDRESS = "0x1111111111111111111111111111111111111111";
const FRESH_CACHE_ADDRESS = "0x2222222222222222222222222222222222222222";

describe("alchemy prices", () => {
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

  it("fetches prices by address successfully", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          {
            network: NETWORK,
            address: AJNA.toLowerCase(),
            prices: [{ currency: "USD", value: "0.003", lastUpdatedAt: new Date().toISOString() }],
            error: null,
          },
          {
            network: NETWORK,
            address: USDC.toLowerCase(),
            prices: [{ currency: "USD", value: "1.00", lastUpdatedAt: new Date().toISOString() }],
            error: null,
          },
        ],
      }),
    });

    const client = createAlchemyPricesClient("test-key");
    const prices = await client.getPrices(NETWORK, [AJNA, USDC]);

    expect(prices.get(AJNA)).toBe(0.003);
    expect(prices.get(USDC)).toBe(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("returns cached prices on rate limit", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          {
            network: NETWORK,
            address: AJNA.toLowerCase(),
            prices: [{ currency: "USD", value: "0.003", lastUpdatedAt: new Date().toISOString() }],
            error: null,
          },
        ],
      }),
    });

    const client = createAlchemyPricesClient("test-key");
    await client.getPrices(NETWORK, [AJNA]);

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: async () => ({}),
    });

    const prices = await client.getPrices(NETWORK, [AJNA]);
    expect(prices.get(AJNA)).toBe(0.003);
  });

  it("marks stale prices using lastUpdatedAt", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          {
            network: NETWORK,
            address: STALE_ADDRESS.toLowerCase(),
            prices: [{ currency: "USD", value: "0.003", lastUpdatedAt: "2020-01-01T00:00:00.000Z" }],
            error: null,
          },
        ],
      }),
    });

    const client = createAlchemyPricesClient("test-key");
    await client.getPrices(NETWORK, [STALE_ADDRESS]);

    expect(client.isPriceStale(NETWORK, STALE_ADDRESS)).toBe(true);
  });

  it("reuses fresh cached prices without hitting the API again", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          {
            network: NETWORK,
            address: FRESH_CACHE_ADDRESS.toLowerCase(),
            prices: [{ currency: "USD", value: "0.003", lastUpdatedAt: new Date().toISOString() }],
            error: null,
          },
        ],
      }),
    });

    const client = createAlchemyPricesClient("test-key");
    await expect(client.getPrices(NETWORK, [FRESH_CACHE_ADDRESS])).resolves.toBeInstanceOf(Map);
    await expect(client.getPrices(NETWORK, [FRESH_CACHE_ADDRESS])).resolves.toBeInstanceOf(Map);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("accepts a large repricing after a second consistent observation", async () => {
    const confirmedAddress = "0x3333333333333333333333333333333333333333";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-31T00:00:00.000Z"));

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          {
            network: NETWORK,
            address: confirmedAddress.toLowerCase(),
            prices: [{ currency: "USD", value: "0.003", lastUpdatedAt: new Date().toISOString() }],
            error: null,
          },
        ],
      }),
    });

    const client = createAlchemyPricesClient("test-key");
    await expect(client.getPrices(NETWORK, [confirmedAddress])).resolves.toEqual(
      new Map([[confirmedAddress, 0.003]]),
    );
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          {
            network: NETWORK,
            address: confirmedAddress.toLowerCase(),
            prices: [{ currency: "USD", value: "0.01", lastUpdatedAt: new Date().toISOString() }],
            error: null,
          },
        ],
      }),
    });
    await expect(client.getPrices(NETWORK, [confirmedAddress])).resolves.toEqual(
      new Map([[confirmedAddress, null]]),
    );
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          {
            network: NETWORK,
            address: confirmedAddress.toLowerCase(),
            prices: [{ currency: "USD", value: "0.0102", lastUpdatedAt: new Date().toISOString() }],
            error: null,
          },
        ],
      }),
    });
    await expect(client.getPrices(NETWORK, [confirmedAddress])).resolves.toEqual(
      new Map([[confirmedAddress, 0.0102]]),
    );
  });
});
