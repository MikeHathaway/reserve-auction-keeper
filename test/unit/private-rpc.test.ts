import { beforeEach, describe, expect, it, vi } from "vitest";
import { base } from "viem/chains";
import type * as ViemModule from "viem";

const { mockCreatePublicClient, mockHttp } = vi.hoisted(() => ({
  mockCreatePublicClient: vi.fn(),
  mockHttp: vi.fn(() => ({})),
}));

vi.mock("viem", async () => {
  const actual = await vi.importActual<typeof ViemModule>("viem");
  return {
    ...actual,
    createPublicClient: mockCreatePublicClient,
    http: mockHttp,
  };
});

import { createPrivateRpcSubmitter } from "../../src/execution/private-rpc.js";

const SIMPLE_ABI = [
  {
    inputs: [],
    name: "poke",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

const REQUEST = {
  to: "0x1111111111111111111111111111111111111111",
  abi: SIMPLE_ABI,
  functionName: "poke",
  args: [],
  account: "0x2222222222222222222222222222222222222222",
} as const;

describe("private-rpc submitter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects live submission when no private RPC URL is configured", async () => {
    const walletClient = {
      account: { address: REQUEST.account },
      sendTransaction: vi.fn(),
    };
    const publicClient = { chain: base };

    const submitter = createPrivateRpcSubmitter(
      publicClient as never,
      walletClient as never,
    );

    expect(submitter.supportsLiveSubmission).toBe(false);
    await expect(submitter.submit(REQUEST)).rejects.toThrow(
      "Private RPC URL is required for live private-rpc submission.",
    );
    expect(walletClient.sendTransaction).not.toHaveBeenCalled();
  });

  it("rejects live submission when the URL is not explicitly trusted", async () => {
    const walletClient = {
      account: { address: REQUEST.account },
      sendTransaction: vi.fn(),
    };
    const publicClient = { chain: base };

    const submitter = createPrivateRpcSubmitter(
      publicClient as never,
      walletClient as never,
      "https://private-rpc.example",
    );

    expect(submitter.supportsLiveSubmission).toBe(false);
    await expect(submitter.submit(REQUEST)).rejects.toThrow(
      "privateRpcTrusted: true is required for live private-rpc submission.",
    );
    expect(walletClient.sendTransaction).not.toHaveBeenCalled();
  });

  it("retries transient submission failures", async () => {
    const walletClient = {
      account: { address: REQUEST.account },
      sendTransaction: vi.fn()
        .mockRejectedValueOnce(new Error("fetch failed"))
        .mockResolvedValueOnce(
          "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ),
    };
    const publicClient = { chain: base };

    const submitter = createPrivateRpcSubmitter(
      publicClient as never,
      walletClient as never,
      "https://private-rpc.example",
      true,
    );
    vi.spyOn(submitter, "isHealthy").mockResolvedValue(true);

    const submission = await submitter.submit(REQUEST);

    expect(submission).toEqual({
      mode: "private-rpc",
      txHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      privateSubmission: true,
    });
    expect(walletClient.sendTransaction).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-transient submission failures", async () => {
    const walletClient = {
      account: { address: REQUEST.account },
      sendTransaction: vi.fn().mockRejectedValue(new Error("insufficient funds")),
    };
    const publicClient = { chain: base };

    const submitter = createPrivateRpcSubmitter(
      publicClient as never,
      walletClient as never,
      "https://private-rpc.example",
      true,
    );
    vi.spyOn(submitter, "isHealthy").mockResolvedValue(true);

    await expect(submitter.submit(REQUEST)).rejects.toThrow("insufficient funds");
    expect(walletClient.sendTransaction).toHaveBeenCalledTimes(1);
  });

  it("applies the requested gas-price cap to live submissions", async () => {
    const walletClient = {
      account: { address: REQUEST.account },
      sendTransaction: vi.fn().mockResolvedValue(
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ),
    };
    const publicClient = { chain: base };

    const submitter = createPrivateRpcSubmitter(
      publicClient as never,
      walletClient as never,
      "https://private-rpc.example",
      true,
    );
    vi.spyOn(submitter, "isHealthy").mockResolvedValue(true);

    await submitter.submit({
      ...REQUEST,
      gasPriceWei: 1_500_000_000n,
    });

    expect(walletClient.sendTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        maxFeePerGas: 1_500_000_000n,
        maxPriorityFeePerGas: 1_500_000_000n,
      }),
    );
  });

  it("proves write-path health on the first runtime readiness check", async () => {
    const request = vi.fn().mockRejectedValue(
      new Error("failed to decode signed transaction"),
    );
    mockCreatePublicClient.mockReturnValue({
      getBlockNumber: vi.fn().mockResolvedValue(123n),
      request,
    });

    const submitter = createPrivateRpcSubmitter(
      { chain: base } as never,
      {
        account: { address: REQUEST.account },
        sendTransaction: vi.fn(),
      } as never,
      "https://private-rpc.example",
      true,
    );

    await expect(submitter.isHealthy()).resolves.toBe(true);
    expect(request).toHaveBeenCalledWith({
      method: "eth_sendRawTransaction",
      params: ["0x00"],
    });
  });

  it("treats an invalid raw-transaction probe rejection as ready during startup preflight", async () => {
    const request = vi.fn().mockRejectedValue(
      new Error("failed to decode signed transaction"),
    );
    mockCreatePublicClient.mockReturnValue({
      getBlockNumber: vi.fn().mockResolvedValue(123n),
      request,
    });

    const submitter = createPrivateRpcSubmitter(
      { chain: base } as never,
      {
        account: { address: REQUEST.account },
        sendTransaction: vi.fn(),
      } as never,
      "https://private-rpc.example",
      true,
    );

    await expect(
      submitter.preflightLiveSubmissionReadiness?.(),
    ).resolves.toBe(true);
    expect(request).toHaveBeenCalledWith({
      method: "eth_sendRawTransaction",
      params: ["0x00"],
    });
    expect(mockCreatePublicClient).toHaveBeenCalled();
  });

  it("revalidates the write path after the cached probe expires", async () => {
    let nowMs = 0;
    const firstRequest = vi.fn().mockRejectedValue(
      new Error("failed to decode signed transaction"),
    );
    const secondRequest = vi.fn().mockRejectedValue(
      new Error("403 forbidden"),
    );
    mockCreatePublicClient
      .mockReturnValueOnce({
        getBlockNumber: vi.fn().mockResolvedValue(123n),
        request: firstRequest,
      })
      .mockReturnValueOnce({
        getBlockNumber: vi.fn().mockResolvedValue(123n),
        request: secondRequest,
      });

    const submitter = createPrivateRpcSubmitter(
      { chain: base } as never,
      {
        account: { address: REQUEST.account },
        sendTransaction: vi.fn(),
      } as never,
      "https://private-rpc.example",
      true,
      {
        now: () => nowMs,
        writePathRevalidationIntervalMs: 1,
      },
    );

    await expect(
      submitter.preflightLiveSubmissionReadiness?.(),
    ).resolves.toBe(true);

    nowMs = 10;

    await expect(submitter.isHealthy()).resolves.toBe(false);
    expect(firstRequest).toHaveBeenCalledWith({
      method: "eth_sendRawTransaction",
      params: ["0x00"],
    });
    expect(secondRequest).toHaveBeenCalledWith({
      method: "eth_sendRawTransaction",
      params: ["0x00"],
    });
  });

  it("does not stay red for the full healthy-cache window after one failed revalidation", async () => {
    let nowMs = 0;
    const firstRequest = vi.fn().mockRejectedValue(
      new Error("failed to decode signed transaction"),
    );
    const secondRequest = vi.fn().mockRejectedValue(
      new Error("403 forbidden"),
    );
    const thirdRequest = vi.fn().mockRejectedValue(
      new Error("failed to decode signed transaction"),
    );
    mockCreatePublicClient
      .mockReturnValueOnce({
        getBlockNumber: vi.fn().mockResolvedValue(123n),
        request: firstRequest,
      })
      .mockReturnValueOnce({
        getBlockNumber: vi.fn().mockResolvedValue(123n),
        request: secondRequest,
      })
      .mockReturnValueOnce({
        getBlockNumber: vi.fn().mockResolvedValue(123n),
        request: thirdRequest,
      });

    const submitter = createPrivateRpcSubmitter(
      { chain: base } as never,
      {
        account: { address: REQUEST.account },
        sendTransaction: vi.fn(),
      } as never,
      "https://private-rpc.example",
      true,
      {
        now: () => nowMs,
        writePathRevalidationIntervalMs: 1,
        writePathFailureRetryMs: 0,
      },
    );

    await expect(
      submitter.preflightLiveSubmissionReadiness?.(),
    ).resolves.toBe(true);

    nowMs = 10;
    await expect(submitter.isHealthy()).resolves.toBe(false);
    await expect(submitter.isHealthy()).resolves.toBe(true);
    expect(firstRequest).toHaveBeenCalledTimes(1);
    expect(secondRequest).toHaveBeenCalledTimes(1);
    expect(thirdRequest).toHaveBeenCalledTimes(1);
  });

  it("marks the write path unhealthy immediately after a live sendTransaction endpoint failure", async () => {
    const healthRequest = vi.fn().mockRejectedValue(
      new Error("failed to decode signed transaction"),
    );
    mockCreatePublicClient.mockReturnValue({
      getBlockNumber: vi.fn().mockResolvedValue(123n),
      request: healthRequest,
    });

    const walletClient = {
      account: { address: REQUEST.account },
      sendTransaction: vi.fn().mockRejectedValue(new Error("403 forbidden")),
    };

    const submitter = createPrivateRpcSubmitter(
      { chain: base } as never,
      walletClient as never,
      "https://private-rpc.example",
      true,
      {
        writePathFailureRetryMs: 60_000,
      },
    );

    await expect(submitter.submit(REQUEST)).rejects.toThrow("403 forbidden");
    await expect(submitter.isHealthy()).resolves.toBe(false);
  });

  it("marks the write path unhealthy after a generic private RPC server-side submission failure", async () => {
    const healthRequest = vi.fn().mockRejectedValue(
      new Error("failed to decode signed transaction"),
    );
    mockCreatePublicClient.mockReturnValue({
      getBlockNumber: vi.fn().mockResolvedValue(123n),
      request: healthRequest,
    });

    const walletClient = {
      account: { address: REQUEST.account },
      sendTransaction: vi.fn().mockRejectedValue(new Error("500 internal server error")),
    };

    const submitter = createPrivateRpcSubmitter(
      { chain: base } as never,
      walletClient as never,
      "https://private-rpc.example",
      true,
      {
        writePathFailureRetryMs: 60_000,
      },
    );

    await expect(submitter.submit(REQUEST)).rejects.toThrow("500 internal server error");
    await expect(submitter.isHealthy()).resolves.toBe(false);
  });
});
