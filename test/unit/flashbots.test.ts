import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import { createFlashbotsSubmitter } from "../../src/execution/flashbots.js";
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

const AUTH_KEY =
  "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const AUTH_ADDRESS = privateKeyToAccount(AUTH_KEY).address;
const SERIALIZED_TX_1 =
  "0x02f86c0180843b9aca0084773594008252089411111111111111111111111111111111111111118084c2985578c001a0a11f5a8a0f4d8d25569d5e4f7f0626ab3f6fcb36ed3b1e4a3ec7fcbcb58f2c0aa02e42f6b9ba3d4f2836454dfd1d565f0a4b7a9f0c9865df2dd8d64f0d3f96b610";
const SERIALIZED_TX_2 =
  "0x02f86c0180843b9aca0184773594018252089411111111111111111111111111111111111111118084c2985578c001a03677777777777777777777777777777777777777777777777777777777777777a04788888888888888888888888888888888888888888888888888888888888888";
const TX_HASH_2 = keccak256(SERIALIZED_TX_2);

function makeResponse(payload: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

describe("flashbots submitter", () => {
  const originalFetch = globalThis.fetch;
  const mockFetch = vi.fn();

  beforeEach(() => {
    globalThis.fetch = mockFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("waits briefly for receipt visibility before deciding a bundle missed", async () => {
    mockFetch
      .mockResolvedValueOnce(makeResponse({ result: { results: [{}] } }))
      .mockResolvedValueOnce(makeResponse({ result: { bundleHash: "bundle-1" } }));

    const publicClient = {
      chain: mainnet,
      getBlockNumber: vi.fn()
        .mockResolvedValueOnce(100n)
        .mockResolvedValueOnce(100n)
        .mockResolvedValueOnce(101n),
      getTransactionReceipt: vi.fn()
        .mockRejectedValueOnce(new Error("transaction receipt not found"))
        .mockResolvedValueOnce({ blockNumber: 101n }),
    };

    const walletClient = {
      account: {
        address: "0x2222222222222222222222222222222222222222",
        signTransaction: vi.fn().mockResolvedValueOnce(SERIALIZED_TX_1),
      },
      prepareTransactionRequest: vi.fn()
        .mockResolvedValueOnce({
          to: "0x1111111111111111111111111111111111111111",
          data: "0x",
          type: "eip1559",
        })
        .mockResolvedValueOnce({
          to: "0x1111111111111111111111111111111111111111",
          data: "0x",
          type: "eip1559",
        }),
    };

    const submitter = createFlashbotsSubmitter(
      publicClient as never,
      walletClient as never,
      AUTH_KEY,
      {
        pollIntervalMs: 0,
        sleep: () => Promise.resolve(),
        receiptVisibilityTimeoutMs: 10,
      },
    );

    const submission = await submitter.submit({
      to: "0x1111111111111111111111111111111111111111",
      abi: SIMPLE_ABI,
      functionName: "poke",
      args: [],
      account: "0x2222222222222222222222222222222222222222",
      gasPriceWei: 3_000_000_000n,
    });

    expect(submitter.supportsLiveSubmission).toBe(true);
    expect(submission).toEqual({
      mode: "flashbots",
      txHash: keccak256(SERIALIZED_TX_1),
      bundleHash: "bundle-1",
      targetBlock: 101n,
      privateSubmission: true,
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(walletClient.prepareTransactionRequest).toHaveBeenCalledTimes(1);
    expect(walletClient.account.signTransaction).toHaveBeenCalledTimes(1);
    expect(walletClient.prepareTransactionRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        maxFeePerGas: 3_000_000_000n,
        maxPriorityFeePerGas: 3_000_000_000n,
      }),
    );

    const firstRequest = mockFetch.mock.calls[0][1];
    expect(firstRequest.headers["X-Flashbots-Signature"]).toContain(
      `${AUTH_ADDRESS}:`,
    );

    const firstBody = JSON.parse(firstRequest.body as string);
    expect(firstBody.method).toBe("eth_callBundle");
    expect(firstBody.params[0].txs).toEqual([SERIALIZED_TX_1]);

    const secondBody = JSON.parse(mockFetch.mock.calls[1][1].body as string);
    expect(secondBody.method).toBe("eth_sendBundle");
    expect(secondBody.params[0].blockNumber).toBe("0x65");

  });

  it("retries with a fresh transaction after the receipt-visibility grace window expires", async () => {
    let nowMs = 0;

    mockFetch
      .mockResolvedValueOnce(makeResponse({ result: { results: [{}] } }))
      .mockResolvedValueOnce(makeResponse({ result: { bundleHash: "bundle-1" } }))
      .mockResolvedValueOnce(makeResponse({ result: { results: [{}] } }))
      .mockResolvedValueOnce(makeResponse({ result: { bundleHash: "bundle-2" } }));

    const publicClient = {
      chain: mainnet,
      getBlockNumber: vi.fn()
        .mockResolvedValueOnce(100n)
        .mockResolvedValueOnce(100n)
        .mockResolvedValueOnce(101n)
        .mockResolvedValueOnce(101n)
        .mockResolvedValueOnce(102n),
      getTransactionReceipt: vi.fn()
        .mockRejectedValueOnce(new Error("transaction receipt not found"))
        .mockRejectedValueOnce(new Error("transaction receipt not found"))
        .mockRejectedValueOnce(new Error("transaction receipt not found"))
        .mockResolvedValueOnce({ blockNumber: 102n }),
    };

    const walletClient = {
      account: {
        address: "0x2222222222222222222222222222222222222222",
        signTransaction: vi.fn()
          .mockResolvedValueOnce(SERIALIZED_TX_1)
          .mockResolvedValueOnce(SERIALIZED_TX_2),
      },
      prepareTransactionRequest: vi.fn()
        .mockResolvedValueOnce({
          to: "0x1111111111111111111111111111111111111111",
          data: "0x",
          type: "eip1559",
        })
        .mockResolvedValueOnce({
          to: "0x1111111111111111111111111111111111111111",
          data: "0x",
          type: "eip1559",
        }),
    };

    const submitter = createFlashbotsSubmitter(
      publicClient as never,
      walletClient as never,
      AUTH_KEY,
      {
        pollIntervalMs: 0,
        receiptVisibilityTimeoutMs: 50,
        now: () => nowMs,
        sleep: async () => {
          nowMs += 25;
        },
      },
    );

    const submission = await submitter.submit({
      to: "0x1111111111111111111111111111111111111111",
      abi: SIMPLE_ABI,
      functionName: "poke",
      args: [],
      account: "0x2222222222222222222222222222222222222222",
    });

    expect(submission).toEqual({
      mode: "flashbots",
      txHash: TX_HASH_2,
      bundleHash: "bundle-2",
      targetBlock: 102n,
      privateSubmission: true,
    });

    expect(mockFetch).toHaveBeenCalledTimes(4);
    expect(walletClient.prepareTransactionRequest).toHaveBeenCalledTimes(2);
    expect(walletClient.account.signTransaction).toHaveBeenCalledTimes(2);

    const thirdBody = JSON.parse(mockFetch.mock.calls[2][1].body as string);
    expect(thirdBody.method).toBe("eth_callBundle");
    expect(thirdBody.params[0].txs).toEqual([SERIALIZED_TX_2]);
  });

  it("proves write-path health on the first runtime readiness check", async () => {
    mockFetch
      .mockResolvedValueOnce(makeResponse({ result: { results: [{}] } }))
      .mockResolvedValueOnce(
        makeResponse({ error: { message: "unable to decode txs" } }),
      );

    const walletClient = {
      account: {
        address: "0x2222222222222222222222222222222222222222",
        signTransaction: vi.fn().mockResolvedValue(SERIALIZED_TX_1),
      },
      prepareTransactionRequest: vi.fn().mockResolvedValue({
        to: "0x2222222222222222222222222222222222222222",
        data: "0x",
        type: "eip1559",
      }),
    };

    const submitter = createFlashbotsSubmitter(
      {
        chain: mainnet,
        getBlockNumber: vi.fn().mockResolvedValue(100n),
      } as never,
      walletClient as never,
      AUTH_KEY,
    );

    await expect(submitter.isHealthy()).resolves.toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    const simulationRequest = mockFetch.mock.calls[0][1];
    expect(simulationRequest.headers["X-Flashbots-Signature"]).toContain(
      `${AUTH_ADDRESS}:`,
    );

    const simulationBody = JSON.parse(simulationRequest.body as string);
    expect(simulationBody.method).toBe("eth_callBundle");
    expect(simulationBody.params[0].txs).toEqual([SERIALIZED_TX_1]);
    expect(simulationBody.params[0].blockNumber).toBe("0x65");

    const sendProbeBody = JSON.parse(mockFetch.mock.calls[1][1].body as string);
    expect(sendProbeBody.method).toBe("eth_sendBundle");
    expect(sendProbeBody.params[0].txs).toEqual(["0x00"]);
  });

  it("preflights live submission readiness with an authenticated send-path probe", async () => {
    mockFetch
      .mockResolvedValueOnce(makeResponse({ result: { results: [{}] } }))
      .mockResolvedValueOnce(
        makeResponse({ error: { message: "unable to decode txs" } }),
      );

    const walletClient = {
      account: {
        address: "0x2222222222222222222222222222222222222222",
        signTransaction: vi.fn().mockResolvedValue(SERIALIZED_TX_1),
      },
      prepareTransactionRequest: vi.fn().mockResolvedValue({
        to: "0x2222222222222222222222222222222222222222",
        data: "0x",
        type: "eip1559",
      }),
    };

    const submitter = createFlashbotsSubmitter(
      {
        chain: mainnet,
        getBlockNumber: vi.fn().mockResolvedValue(100n),
      } as never,
      walletClient as never,
      AUTH_KEY,
    );

    await expect(
      submitter.preflightLiveSubmissionReadiness?.(),
    ).resolves.toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    const sendProbeRequest = mockFetch.mock.calls[1][1];
    expect(sendProbeRequest.headers["X-Flashbots-Signature"]).toContain(
      `${AUTH_ADDRESS}:`,
    );

    const sendProbeBody = JSON.parse(sendProbeRequest.body as string);
    expect(sendProbeBody.method).toBe("eth_sendBundle");
    expect(sendProbeBody.params[0].txs).toEqual(["0x00"]);
  });

  it("revalidates the send path after the cached write-path check expires", async () => {
    let nowMs = 0;
    mockFetch
      .mockResolvedValueOnce(makeResponse({ result: { results: [{}] } }))
      .mockResolvedValueOnce(
        makeResponse({ error: { message: "unable to decode txs" } }),
      )
      .mockResolvedValueOnce(makeResponse({ result: { results: [{}] } }))
      .mockResolvedValueOnce(
        makeResponse({ error: { message: "relay unavailable" } }),
      );

    const walletClient = {
      account: {
        address: "0x2222222222222222222222222222222222222222",
        signTransaction: vi.fn().mockResolvedValue(SERIALIZED_TX_1),
      },
      prepareTransactionRequest: vi.fn().mockResolvedValue({
        to: "0x2222222222222222222222222222222222222222",
        data: "0x",
        type: "eip1559",
      }),
    };

    const submitter = createFlashbotsSubmitter(
      {
        chain: mainnet,
        getBlockNumber: vi.fn().mockResolvedValue(100n),
      } as never,
      walletClient as never,
      AUTH_KEY,
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
    expect(mockFetch).toHaveBeenCalledTimes(4);

    const revalidationProbeBody = JSON.parse(mockFetch.mock.calls[3][1].body as string);
    expect(revalidationProbeBody.method).toBe("eth_sendBundle");
    expect(revalidationProbeBody.params[0].txs).toEqual(["0x00"]);
  });

  it("does not stay red for the full healthy-cache window after one failed revalidation", async () => {
    let nowMs = 0;
    mockFetch
      .mockResolvedValueOnce(makeResponse({ result: { results: [{}] } }))
      .mockResolvedValueOnce(
        makeResponse({ error: { message: "unable to decode txs" } }),
      )
      .mockResolvedValueOnce(makeResponse({ result: { results: [{}] } }))
      .mockResolvedValueOnce(
        makeResponse({ error: { message: "relay unavailable" } }),
      )
      .mockResolvedValueOnce(makeResponse({ result: { results: [{}] } }))
      .mockResolvedValueOnce(
        makeResponse({ error: { message: "unable to decode txs" } }),
      );

    const walletClient = {
      account: {
        address: "0x2222222222222222222222222222222222222222",
        signTransaction: vi.fn().mockResolvedValue(SERIALIZED_TX_1),
      },
      prepareTransactionRequest: vi.fn().mockResolvedValue({
        to: "0x2222222222222222222222222222222222222222",
        data: "0x",
        type: "eip1559",
      }),
    };

    const submitter = createFlashbotsSubmitter(
      {
        chain: mainnet,
        getBlockNumber: vi.fn().mockResolvedValue(100n),
      } as never,
      walletClient as never,
      AUTH_KEY,
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
    expect(mockFetch).toHaveBeenCalledTimes(6);
  });

  it("marks the write path unhealthy immediately after a live sendBundle failure", async () => {
    let nowMs = 0;
    mockFetch
      .mockResolvedValueOnce(makeResponse({ result: { results: [{}] } }))
      .mockResolvedValueOnce(
        makeResponse({ error: { message: "unable to decode txs" } }),
      )
      .mockResolvedValueOnce(makeResponse({ result: { results: [{}] } }))
      .mockResolvedValueOnce(
        makeResponse({ error: { message: "relay unavailable" } }),
      )
      .mockResolvedValueOnce(makeResponse({ result: { results: [{}] } }));

    const publicClient = {
      chain: mainnet,
      getBlockNumber: vi.fn()
        .mockResolvedValueOnce(100n)
        .mockResolvedValueOnce(100n),
      getTransactionReceipt: vi.fn(),
    };

    const walletClient = {
      account: {
        address: "0x2222222222222222222222222222222222222222",
        signTransaction: vi.fn().mockResolvedValue(SERIALIZED_TX_1),
      },
      prepareTransactionRequest: vi.fn().mockResolvedValue({
        to: "0x1111111111111111111111111111111111111111",
        data: "0x",
        type: "eip1559",
      }),
    };

    const submitter = createFlashbotsSubmitter(
      publicClient as never,
      walletClient as never,
      AUTH_KEY,
      {
        maxBlockRetries: 3,
        now: () => nowMs,
        writePathFailureRetryMs: 60_000,
      },
    );

    await expect(
      submitter.preflightLiveSubmissionReadiness?.(),
    ).resolves.toBe(true);

    await expect(submitter.submit({
      to: "0x1111111111111111111111111111111111111111",
      abi: SIMPLE_ABI,
      functionName: "poke",
      args: [],
      account: "0x2222222222222222222222222222222222222222",
    })).rejects.toThrow(
      "Flashbots relay unhealthy, aborting remaining bundle retries until the next health revalidation window: Flashbots RPC error: relay unavailable",
    );

    nowMs = 1;
    await expect(submitter.isHealthy()).resolves.toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it("refuses a second bundle submission while a recent relay write-path failure is cached", async () => {
    let nowMs = 0;
    mockFetch
      .mockResolvedValueOnce(makeResponse({ result: { results: [{}] } }))
      .mockResolvedValueOnce(
        makeResponse({ error: { message: "unable to decode txs" } }),
      )
      .mockResolvedValueOnce(makeResponse({ result: { results: [{}] } }))
      .mockResolvedValueOnce(
        makeResponse({ error: { message: "relay unavailable" } }),
      );

    const publicClient = {
      chain: mainnet,
      getBlockNumber: vi.fn()
        .mockResolvedValueOnce(100n)
        .mockResolvedValueOnce(100n),
      getTransactionReceipt: vi.fn(),
    };

    const walletClient = {
      account: {
        address: "0x2222222222222222222222222222222222222222",
        signTransaction: vi.fn().mockResolvedValue(SERIALIZED_TX_1),
      },
      prepareTransactionRequest: vi.fn().mockResolvedValue({
        to: "0x1111111111111111111111111111111111111111",
        data: "0x",
        type: "eip1559",
      }),
    };

    const request = {
      to: "0x1111111111111111111111111111111111111111",
      abi: SIMPLE_ABI,
      functionName: "poke",
      args: [],
      account: "0x2222222222222222222222222222222222222222",
    } as const;

    const submitter = createFlashbotsSubmitter(
      publicClient as never,
      walletClient as never,
      AUTH_KEY,
      {
        maxBlockRetries: 1,
        now: () => nowMs,
        writePathFailureRetryMs: 60_000,
      },
    );

    await expect(
      submitter.preflightLiveSubmissionReadiness?.(),
    ).resolves.toBe(true);

    await expect(submitter.submit(request)).rejects.toThrow("relay unavailable");

    nowMs = 1;

    await expect(submitter.submit(request)).rejects.toThrow(
      "Flashbots relay unhealthy, aborting bundle submission until the next health revalidation window.",
    );
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it("does not retry with a second bundle when public-RPC monitoring fails after relay acceptance", async () => {
    mockFetch
      .mockResolvedValueOnce(makeResponse({ result: { results: [{}] } }))
      .mockResolvedValueOnce(makeResponse({ result: { bundleHash: "bundle-1" } }));

    const publicClient = {
      chain: mainnet,
      getBlockNumber: vi.fn()
        .mockResolvedValueOnce(100n)
        .mockResolvedValueOnce(100n)
        .mockResolvedValueOnce(101n),
      getTransactionReceipt: vi.fn()
        .mockRejectedValueOnce(new Error("gateway timeout")),
    };

    const walletClient = {
      account: {
        address: "0x2222222222222222222222222222222222222222",
        signTransaction: vi.fn().mockResolvedValueOnce(SERIALIZED_TX_1),
      },
      prepareTransactionRequest: vi.fn().mockResolvedValueOnce({
        to: "0x1111111111111111111111111111111111111111",
        data: "0x",
        type: "eip1559",
      }),
    };

    const submitter = createFlashbotsSubmitter(
      publicClient as never,
      walletClient as never,
      AUTH_KEY,
      {
        maxBlockRetries: 3,
        pollIntervalMs: 0,
        sleep: () => Promise.resolve(),
      },
    );

    let thrownError: unknown;
    try {
      await submitter.submit({
        to: "0x1111111111111111111111111111111111111111",
        abi: SIMPLE_ABI,
        functionName: "poke",
        args: [],
        account: "0x2222222222222222222222222222222222222222",
      });
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(PendingSubmissionError);
    expect(thrownError).toMatchObject({
      message:
        "Flashbots bundle submission accepted by relay, but inclusion monitoring failed: gateway timeout",
      pendingSubmission: {
        txHash: keccak256(SERIALIZED_TX_1),
        label: "poke",
        mode: "flashbots",
        bundleHash: "bundle-1",
        targetBlock: 101n,
        privateSubmission: true,
      },
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(walletClient.prepareTransactionRequest).toHaveBeenCalledTimes(1);
    expect(walletClient.account.signTransaction).toHaveBeenCalledTimes(1);
  });
});
