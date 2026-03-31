import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ViemModule from "viem";
import { parseEther } from "viem";
import {
  discoverPools,
  getPoolReserveStates,
} from "../../src/auction/discovery.js";
import { BASE_CONFIG } from "../../src/chains/index.js";

const mockGetNumberOfDeployedPools = vi.fn();

vi.mock("viem", async () => {
  const actual = await vi.importActual<typeof ViemModule>("viem");

  return {
    ...actual,
    getContract: vi.fn(() => ({
      read: {
        getNumberOfDeployedPools: mockGetNumberOfDeployedPools,
      },
    })),
  };
});

const POOL_A = "0x1111111111111111111111111111111111111111";
const POOL_B = "0x2222222222222222222222222222222222222222";
const POOL_C = "0x3333333333333333333333333333333333333333";
const POOL_D = "0x4444444444444444444444444444444444444444";

describe("discovery", () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), "discovery-cache-"));
    mockGetNumberOfDeployedPools.mockReset();
  });

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

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

  it("persists a full discovery snapshot on cold start", async () => {
    mockGetNumberOfDeployedPools.mockResolvedValue(3n);

    const client = {
      multicall: vi.fn()
        .mockResolvedValueOnce([
          { status: "success", result: POOL_A },
          { status: "success", result: POOL_B },
          { status: "success", result: POOL_C },
        ])
        .mockResolvedValueOnce([
          { status: "success", result: BASE_CONFIG.quoteTokens.USDC },
          { status: "success", result: "0x9999999999999999999999999999999999999999" },
          { status: "success", result: BASE_CONFIG.quoteTokens.WETH },
        ]),
      getBlockNumber: vi.fn().mockResolvedValue(123n),
    };

    const pools = await discoverPools(
      client as never,
      BASE_CONFIG,
      undefined,
      cacheDir,
    );

    expect(pools).toEqual([POOL_A, POOL_C]);
    expect(client.multicall).toHaveBeenCalledTimes(2);

    const snapshot = JSON.parse(
      await readFile(join(cacheDir, `${BASE_CONFIG.name}.json`), "utf8"),
    ) as {
      lastPoolCount: string;
      pools: string[];
      updatedAtBlock: string;
    };

    expect(snapshot.lastPoolCount).toBe("3");
    expect(snapshot.pools).toEqual([POOL_A, POOL_C]);
    expect(snapshot.updatedAtBlock).toBe("123");
  });

  it("reuses the persisted snapshot when pool count is unchanged", async () => {
    await writeFile(
      join(cacheDir, `${BASE_CONFIG.name}.json`),
      JSON.stringify({
        version: 1,
        chain: BASE_CONFIG.name,
        factory: BASE_CONFIG.poolFactory,
        quoteTokens: Object.values(BASE_CONFIG.quoteTokens).map((address) =>
          address.toLowerCase()
        ).sort(),
        lastPoolCount: "2",
        pools: [POOL_A, POOL_B],
        updatedAtBlock: "100",
      }),
    );
    mockGetNumberOfDeployedPools.mockResolvedValue(2n);

    const client = {
      multicall: vi.fn(),
      getBlockNumber: vi.fn(),
    };

    const pools = await discoverPools(
      client as never,
      BASE_CONFIG,
      undefined,
      cacheDir,
    );

    expect(pools).toEqual([POOL_A, POOL_B]);
    expect(client.multicall).not.toHaveBeenCalled();
    expect(client.getBlockNumber).not.toHaveBeenCalled();
  });

  it("incrementally appends newly discovered pools when factory count grows", async () => {
    await writeFile(
      join(cacheDir, `${BASE_CONFIG.name}.json`),
      JSON.stringify({
        version: 1,
        chain: BASE_CONFIG.name,
        factory: BASE_CONFIG.poolFactory,
        quoteTokens: Object.values(BASE_CONFIG.quoteTokens).map((address) =>
          address.toLowerCase()
        ).sort(),
        lastPoolCount: "2",
        pools: [POOL_A],
        updatedAtBlock: "100",
      }),
    );
    mockGetNumberOfDeployedPools.mockResolvedValue(4n);

    const client = {
      multicall: vi.fn()
        .mockResolvedValueOnce([
          { status: "success", result: POOL_C },
          { status: "success", result: POOL_D },
        ])
        .mockResolvedValueOnce([
          { status: "success", result: BASE_CONFIG.quoteTokens.USDC },
          { status: "success", result: "0x9999999999999999999999999999999999999999" },
        ]),
      getBlockNumber: vi.fn().mockResolvedValue(200n),
    };

    const pools = await discoverPools(
      client as never,
      BASE_CONFIG,
      undefined,
      cacheDir,
    );

    expect(pools).toEqual([POOL_A, POOL_C]);
    expect(client.multicall).toHaveBeenNthCalledWith(1, {
      contracts: [
        {
          address: BASE_CONFIG.poolFactory,
          abi: expect.any(Array),
          functionName: "deployedPoolsList",
          args: [2n],
        },
        {
          address: BASE_CONFIG.poolFactory,
          abi: expect.any(Array),
          functionName: "deployedPoolsList",
          args: [3n],
        },
      ],
    });
  });

  it("falls back to a full rebuild when the persisted snapshot is unreadable", async () => {
    await writeFile(join(cacheDir, `${BASE_CONFIG.name}.json`), "{not-json");
    mockGetNumberOfDeployedPools.mockResolvedValue(1n);

    const client = {
      multicall: vi.fn()
        .mockResolvedValueOnce([
          { status: "success", result: POOL_A },
        ])
        .mockResolvedValueOnce([
          { status: "success", result: BASE_CONFIG.quoteTokens.USDC },
        ]),
      getBlockNumber: vi.fn().mockResolvedValue(300n),
    };

    const pools = await discoverPools(
      client as never,
      BASE_CONFIG,
      undefined,
      cacheDir,
    );

    expect(pools).toEqual([POOL_A]);
    expect(client.multicall).toHaveBeenCalledTimes(2);
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
        ])
        .mockResolvedValueOnce([
          { status: "success", result: 1_000_000_000_000n },
          { status: "success", result: 1n },
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
      quoteTokenScale: 1_000_000_000_000n,
      quoteTokenSymbol: "USDC",
      hasActiveAuction: true,
      isKickable: false,
    });
    expect(states[1]).toMatchObject({
      pool: POOL_B,
      quoteTokenScale: 1n,
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
    expect(client.multicall).toHaveBeenNthCalledWith(3, {
      contracts: [
        {
          address: POOL_A,
          abi: expect.any(Array),
          functionName: "quoteTokenScale",
        },
        {
          address: POOL_B,
          abi: expect.any(Array),
          functionName: "quoteTokenScale",
        },
      ],
    });
  });

  it("retries reserve-state reads when RPC calls fail transiently", async () => {
    const client = {
      multicall: vi.fn()
        .mockRejectedValueOnce(new Error("rpc timeout"))
        .mockResolvedValueOnce([])
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
        ])
        .mockResolvedValueOnce([
          { status: "success", result: 1_000_000_000_000n },
        ]),
    };

    const states = await getPoolReserveStates(
      client as never,
      BASE_CONFIG,
      [POOL_A],
    );

    expect(states).toHaveLength(1);
    expect(client.multicall).toHaveBeenCalledTimes(6);
  });
});
