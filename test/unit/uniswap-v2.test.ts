import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearUniswapV2PairAddressCache,
  getUniswapV2PairAddress,
} from "../../src/utils/uniswap-v2.js";

const FACTORY = "0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac" as const;
const TOKEN_A = "0x1111111111111111111111111111111111111111" as const;
const TOKEN_B = "0x2222222222222222222222222222222222222222" as const;
const TOKEN_C = "0x3333333333333333333333333333333333333333" as const;
const PAIR_AB = "0x4444444444444444444444444444444444444444" as const;
const ZERO = "0x0000000000000000000000000000000000000000" as const;

describe("getUniswapV2PairAddress", () => {
  afterEach(() => {
    clearUniswapV2PairAddressCache();
  });

  it("caches resolved pair address across calls", async () => {
    const publicClient = {
      readContract: vi.fn().mockResolvedValue(PAIR_AB),
    };

    const first = await getUniswapV2PairAddress(
      publicClient as never,
      FACTORY,
      TOKEN_A,
      TOKEN_B,
    );
    const second = await getUniswapV2PairAddress(
      publicClient as never,
      FACTORY,
      TOKEN_A,
      TOKEN_B,
    );

    expect(first).toBe(PAIR_AB);
    expect(second).toBe(PAIR_AB);
    expect(publicClient.readContract).toHaveBeenCalledTimes(1);
  });

  it("treats reversed token order as the same cache entry", async () => {
    const publicClient = {
      readContract: vi.fn().mockResolvedValue(PAIR_AB),
    };

    await getUniswapV2PairAddress(
      publicClient as never,
      FACTORY,
      TOKEN_A,
      TOKEN_B,
    );
    const reversed = await getUniswapV2PairAddress(
      publicClient as never,
      FACTORY,
      TOKEN_B,
      TOKEN_A,
    );

    expect(reversed).toBe(PAIR_AB);
    expect(publicClient.readContract).toHaveBeenCalledTimes(1);
  });

  it("does not cache null (missing pair) so newly created pairs are picked up", async () => {
    const publicClient = {
      readContract: vi
        .fn()
        .mockResolvedValueOnce(ZERO)
        .mockResolvedValueOnce(PAIR_AB),
    };

    const first = await getUniswapV2PairAddress(
      publicClient as never,
      FACTORY,
      TOKEN_A,
      TOKEN_B,
    );
    const second = await getUniswapV2PairAddress(
      publicClient as never,
      FACTORY,
      TOKEN_A,
      TOKEN_B,
    );

    expect(first).toBeNull();
    expect(second).toBe(PAIR_AB);
    expect(publicClient.readContract).toHaveBeenCalledTimes(2);
  });

  it("scopes cache by factory and token pair", async () => {
    const publicClient = {
      readContract: vi
        .fn()
        .mockResolvedValueOnce(PAIR_AB)
        .mockResolvedValueOnce("0x5555555555555555555555555555555555555555"),
    };

    const ab = await getUniswapV2PairAddress(
      publicClient as never,
      FACTORY,
      TOKEN_A,
      TOKEN_B,
    );
    const ac = await getUniswapV2PairAddress(
      publicClient as never,
      FACTORY,
      TOKEN_A,
      TOKEN_C,
    );

    expect(ab).toBe(PAIR_AB);
    expect(ac).toBe("0x5555555555555555555555555555555555555555");
    expect(publicClient.readContract).toHaveBeenCalledTimes(2);
  });
});
