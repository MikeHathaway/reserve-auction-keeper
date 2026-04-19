import { beforeEach, describe, expect, it, vi } from "vitest";
import { keccak256 } from "viem";
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
import { PendingSubmissionError } from "../../src/execution/receipt.js";

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

const SERIALIZED_TX =
  "0x02f86c0180843b9aca0084773594008252089411111111111111111111111111111111111111118084c2985578c001a0a11f5a8a0f4d8d25569d5e4f7f0626ab3f6fcb36ed3b1e4a3ec7fcbcb58f2c0aa02e42f6b9ba3d4f2836454dfd1d565f0a4b7a9f0c9865df2dd8d64f0d3f96b610";
const SERIALIZED_TX_HASH = keccak256(SERIALIZED_TX);

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

  it("retries transient submission failures with the same signed raw transaction", async () => {
    const nowMs = 123_456;
    const request = vi.fn()
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce(SERIALIZED_TX_HASH);
    const walletClient = {
      account: {
        address: REQUEST.account,
        signTransaction: vi.fn().mockResolvedValue(SERIALIZED_TX),
      },
      prepareTransactionRequest: vi.fn().mockResolvedValue({
        to: REQUEST.to,
        data: "0x",
        type: "eip1559",
        nonce: 7n,
      }),
    };
    const publicClient = { chain: base };
    mockCreatePublicClient.mockReturnValue({
      getBlockNumber: vi.fn().mockResolvedValue(123n),
      getTransactionCount: vi.fn().mockResolvedValue(7n),
      request,
    });

    const submitter = createPrivateRpcSubmitter(
      publicClient as never,
      walletClient as never,
      "https://private-rpc.example",
      true,
      {
        now: () => nowMs,
      },
    );
    vi.spyOn(submitter, "isHealthy").mockResolvedValue(true);

    const submission = await submitter.submit(REQUEST);

    expect(submission).toEqual(expect.objectContaining({
      mode: "private-rpc",
      txHash: SERIALIZED_TX_HASH,
      privateSubmission: true,
      account: REQUEST.account,
      nonce: 7n,
      submittedAtMs: nowMs,
    }));
    expect(walletClient.prepareTransactionRequest).toHaveBeenCalledTimes(1);
    expect(walletClient.account.signTransaction).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(1, {
      method: "eth_sendRawTransaction",
      params: [SERIALIZED_TX],
    });
    expect(request).toHaveBeenNthCalledWith(2, {
      method: "eth_sendRawTransaction",
      params: [SERIALIZED_TX],
    });
  });

  it("surfaces ambiguous transient send failures as pending submissions instead of creating new transactions", async () => {
    const walletClient = {
      account: {
        address: REQUEST.account,
        signTransaction: vi.fn().mockResolvedValue(SERIALIZED_TX),
      },
      prepareTransactionRequest: vi.fn().mockResolvedValue({
        to: REQUEST.to,
        data: "0x",
        type: "eip1559",
        nonce: 7n,
      }),
    };
    const publicClient = { chain: base };
    const request = vi.fn().mockRejectedValue(new Error("fetch failed"));
    mockCreatePublicClient.mockReturnValue({
      getBlockNumber: vi.fn().mockResolvedValue(123n),
      getTransactionCount: vi.fn().mockResolvedValue(7n),
      request,
    });

    const submitter = createPrivateRpcSubmitter(
      publicClient as never,
      walletClient as never,
      "https://private-rpc.example",
      true,
    );
    vi.spyOn(submitter, "isHealthy").mockResolvedValue(true);

    const thrownError = await submitter.submit(REQUEST).catch((error: unknown) => error);

    expect(thrownError).toBeInstanceOf(PendingSubmissionError);
    expect((thrownError as PendingSubmissionError).pendingSubmission).toEqual({
      txHash: SERIALIZED_TX_HASH,
      label: "poke",
      mode: "private-rpc",
      privateSubmission: true,
      account: REQUEST.account,
      nonce: 7n,
      submittedAtMs: expect.any(Number),
    });
    expect(walletClient.prepareTransactionRequest).toHaveBeenCalledTimes(1);
    expect(walletClient.account.signTransaction).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(3);
    expect(request).toHaveBeenNthCalledWith(1, {
      method: "eth_sendRawTransaction",
      params: [SERIALIZED_TX],
    });
    expect(request).toHaveBeenNthCalledWith(3, {
      method: "eth_sendRawTransaction",
      params: [SERIALIZED_TX],
    });
  });

  it("does not retry non-transient submission failures", async () => {
    const request = vi.fn().mockRejectedValue(new Error("insufficient funds"));
    const walletClient = {
      account: {
        address: REQUEST.account,
        signTransaction: vi.fn().mockResolvedValue(SERIALIZED_TX),
      },
      prepareTransactionRequest: vi.fn().mockResolvedValue({
        to: REQUEST.to,
        data: "0x",
        type: "eip1559",
        nonce: 7n,
      }),
    };
    const publicClient = { chain: base };
    mockCreatePublicClient.mockReturnValue({
      getBlockNumber: vi.fn().mockResolvedValue(123n),
      getTransactionCount: vi.fn().mockResolvedValue(7n),
      request,
    });

    const submitter = createPrivateRpcSubmitter(
      publicClient as never,
      walletClient as never,
      "https://private-rpc.example",
      true,
    );
    vi.spyOn(submitter, "isHealthy").mockResolvedValue(true);

    await expect(submitter.submit(REQUEST)).rejects.toThrow("insufficient funds");
    expect(walletClient.prepareTransactionRequest).toHaveBeenCalledTimes(1);
    expect(walletClient.account.signTransaction).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("applies the requested gas-price cap to live submissions", async () => {
    const request = vi.fn().mockResolvedValue(SERIALIZED_TX_HASH);
    const walletClient = {
      account: {
        address: REQUEST.account,
        signTransaction: vi.fn().mockResolvedValue(SERIALIZED_TX),
      },
      prepareTransactionRequest: vi.fn().mockResolvedValue({
        to: REQUEST.to,
        data: "0x",
        type: "eip1559",
        nonce: 7n,
      }),
    };
    const publicClient = { chain: base };
    mockCreatePublicClient.mockReturnValue({
      getBlockNumber: vi.fn().mockResolvedValue(123n),
      getTransactionCount: vi.fn().mockResolvedValue(7n),
      request,
    });

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

    expect(walletClient.prepareTransactionRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        nonce: 7,
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

  it("marks the write path unhealthy immediately after a live raw-transaction endpoint failure", async () => {
    const submissionRequest = vi.fn().mockRejectedValue(new Error("403 forbidden"));
    mockCreatePublicClient.mockReturnValue({
      getBlockNumber: vi.fn().mockResolvedValue(123n),
      getTransactionCount: vi.fn().mockResolvedValue(7n),
      request: submissionRequest,
    });

    const walletClient = {
      account: {
        address: REQUEST.account,
        signTransaction: vi.fn().mockResolvedValue(SERIALIZED_TX),
      },
      prepareTransactionRequest: vi.fn().mockResolvedValue({
        to: REQUEST.to,
        data: "0x",
        type: "eip1559",
        nonce: 7n,
      }),
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
    vi.spyOn(submitter, "isHealthy").mockResolvedValueOnce(true);

    await expect(submitter.submit(REQUEST)).rejects.toThrow("403 forbidden");
    expect(submissionRequest).toHaveBeenCalledWith({
      method: "eth_sendRawTransaction",
      params: [SERIALIZED_TX],
    });
    await expect(submitter.isHealthy()).resolves.toBe(false);
  });

  it("marks the write path unhealthy after a generic private RPC server-side submission failure", async () => {
    const submissionRequest = vi.fn().mockRejectedValue(new Error("500 internal server error"));
    mockCreatePublicClient.mockReturnValue({
      getBlockNumber: vi.fn().mockResolvedValue(123n),
      getTransactionCount: vi.fn().mockResolvedValue(7n),
      request: submissionRequest,
    });

    const walletClient = {
      account: {
        address: REQUEST.account,
        signTransaction: vi.fn().mockResolvedValue(SERIALIZED_TX),
      },
      prepareTransactionRequest: vi.fn().mockResolvedValue({
        to: REQUEST.to,
        data: "0x",
        type: "eip1559",
        nonce: 7n,
      }),
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
    vi.spyOn(submitter, "isHealthy").mockResolvedValueOnce(true);

    await expect(submitter.submit(REQUEST)).rejects.toThrow("500 internal server error");
    expect(submissionRequest).toHaveBeenCalledWith({
      method: "eth_sendRawTransaction",
      params: [SERIALIZED_TX],
    });
    await expect(submitter.isHealthy()).resolves.toBe(false);
  });

  it("skips the read-path probe when the cached result is still healthy", async () => {
    let nowMs = 0;
    const getBlockNumber = vi.fn().mockResolvedValue(123n);
    const request = vi.fn().mockRejectedValue(
      new Error("failed to decode signed transaction"),
    );
    mockCreatePublicClient.mockReturnValue({
      getBlockNumber,
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
      {
        now: () => nowMs,
        readPathRevalidationIntervalMs: 60_000,
        writePathRevalidationIntervalMs: 60_000,
      },
    );

    await expect(
      submitter.preflightLiveSubmissionReadiness?.(),
    ).resolves.toBe(true);
    expect(getBlockNumber).toHaveBeenCalledTimes(1);

    nowMs = 5_000;

    await expect(submitter.isHealthy()).resolves.toBe(true);
    expect(getBlockNumber).toHaveBeenCalledTimes(1);

    nowMs = 70_000;

    await expect(submitter.isHealthy()).resolves.toBe(true);
    expect(getBlockNumber).toHaveBeenCalledTimes(2);
  });

  it("preflight records a read-path failure (not write) when verifyReadPath fails", async () => {
    const getBlockNumber = vi.fn().mockRejectedValue(
      new Error("read endpoint rejected"),
    );
    const request = vi.fn();
    mockCreatePublicClient.mockReturnValue({
      getBlockNumber,
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
      {
        readPathRevalidationIntervalMs: 60_000,
        readPathFailureRetryMs: 60_000,
      },
    );

    await expect(
      submitter.preflightLiveSubmissionReadiness?.(),
    ).resolves.toBe(false);

    expect(request).not.toHaveBeenCalled();

    await expect(submitter.isHealthy()).resolves.toBe(false);
    expect(request).not.toHaveBeenCalled();
  });
});
