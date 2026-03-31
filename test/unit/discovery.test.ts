import { describe, expect, it, vi } from "vitest";
import { parseEther } from "viem";
import {
  discoverPools,
  getPoolReserveStates,
} from "../../src/auction/discovery.js";
import { BASE_CONFIG } from "../../src/chains/index.js";

vi.mock("viem", async () => {
  const actual = await vi.importActual<typeof import("viem")>("viem");

  return {
    ...actual,
    getContract: vi.fn(() => ({
      read: {
        getNumberOfDeployedPools: vi.fn().mockResolvedValue(2n),
      },
    })),
  };
});

const POOL_A = "0x1111111111111111111111111111111111111111";
const POOL_B = "0x2222222222222222222222222222222222222222";

describe("discovery", () => {
  it("returns configured pools without hitting RPC discovery", async () => {
    const client = {
      multicall: vi.fn(),
    };

    const pools = await discoverPools(
      client as never,
      BASE_CONFIG,
      [POOL_A, POOL_B],
    );

    expect(pools).toEqual([POOL_A, POOL_B]);
    expect(client.multicall).not.toHaveBeenCalled();
  });

  it("classifies active auctions and kickable pools from reserve state", async () => {
    const client = {
      multicall: vi.fn()
        .mockResolvedValueOnce([
          {
            status: "success",
            result: [
              parseEther("10"),
              parseEther("5"),
              parseEther("2"),
              parseEther("1.5"),
              3600n,
            ],
          },
          {
            status: "success",
            result: [
              parseEther("10"),
              parseEther("3"),
              0n,
              0n,
              0n,
            ],
          },
        ])
        .mockResolvedValueOnce([
          { status: "success", result: BASE_CONFIG.quoteTokens.USDC },
          { status: "success", result: BASE_CONFIG.quoteTokens.WETH },
        ]),
    };

    const states = await getPoolReserveStates(
      client as never,
      BASE_CONFIG,
      [POOL_A, POOL_B],
    );

    expect(states).toHaveLength(2);
    expect(states[0]).toMatchObject({
      pool: POOL_A,
      quoteTokenSymbol: "USDC",
      hasActiveAuction: true,
      isKickable: false,
    });
    expect(states[1]).toMatchObject({
      pool: POOL_B,
      quoteTokenSymbol: "WETH",
      hasActiveAuction: false,
      isKickable: true,
    });
    expect(client.multicall).toHaveBeenNthCalledWith(1, {
      contracts: [
        {
          address: BASE_CONFIG.poolInfoUtils,
          abi: expect.any(Array),
          functionName: "poolReservesInfo",
          args: [POOL_A],
        },
        {
          address: BASE_CONFIG.poolInfoUtils,
          abi: expect.any(Array),
          functionName: "poolReservesInfo",
          args: [POOL_B],
        },
      ],
    });
  });

  it("retries reserve-state reads when RPC calls fail transiently", async () => {
    const client = {
      multicall: vi.fn()
        .mockRejectedValueOnce(new Error("rpc timeout"))
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            status: "success",
            result: [
              parseEther("10"),
              parseEther("5"),
              parseEther("2"),
              parseEther("1.5"),
              3600n,
            ],
          },
        ])
        .mockResolvedValueOnce([
          { status: "success", result: BASE_CONFIG.quoteTokens.USDC },
        ]),
    };

    const states = await getPoolReserveStates(
      client as never,
      BASE_CONFIG,
      [POOL_A],
    );

    expect(states).toHaveLength(1);
    expect(client.multicall).toHaveBeenCalledTimes(4);
  });
});
