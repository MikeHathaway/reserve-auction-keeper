import { describe, expect, it, vi } from "vitest";
import { parseEther } from "viem";
import {
  getAuctionPrice,
  getAuctionPrices,
} from "../../src/auction/auction-price.js";
import { BASE_CONFIG } from "../../src/chains/index.js";

const POOL_A = "0x1111111111111111111111111111111111111111";
const POOL_B = "0x2222222222222222222222222222222222222222";

describe("auction price", () => {
  it("fetches a single auction price", async () => {
    const client = {
      readContract: vi.fn().mockResolvedValue([
        0n,
        0n,
        0n,
        parseEther("1.25"),
        7200n,
      ]),
    };

    const result = await getAuctionPrice(client as never, BASE_CONFIG, POOL_A);

    expect(result).toMatchObject({
      pool: POOL_A,
      auctionPrice: parseEther("1.25"),
      auctionPriceFormatted: "1.25",
      timeRemaining: 7200n,
      timeRemainingHours: 2,
    });
  });

  it("batch-fetches prices and skips failed multicall entries", async () => {
    const client = {
      multicall: vi.fn().mockResolvedValue([
        {
          status: "success",
          result: [0n, 0n, 0n, parseEther("2"), 3600n],
        },
        {
          status: "failure",
          error: new Error("reverted"),
        },
      ]),
    };

    const result = await getAuctionPrices(
      client as never,
      BASE_CONFIG,
      [POOL_A, POOL_B],
    );

    expect(result.size).toBe(1);
    expect(result.get(POOL_A)?.auctionPriceFormatted).toBe("2");
    expect(result.has(POOL_B)).toBe(false);
  });

  it("retries multicall reads before succeeding", async () => {
    const client = {
      multicall: vi.fn()
        .mockRejectedValueOnce(new Error("503 service unavailable"))
        .mockResolvedValueOnce([
          {
            status: "success",
            result: [0n, 0n, 0n, parseEther("1.1"), 1800n],
          },
        ]),
    };

    const result = await getAuctionPrices(
      client as never,
      BASE_CONFIG,
      [POOL_A],
    );

    expect(client.multicall).toHaveBeenCalledTimes(2);
    expect(result.get(POOL_A)?.auctionPriceFormatted).toBe("1.1");
  });
});
