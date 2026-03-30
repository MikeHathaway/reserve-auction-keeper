import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import { createFlashbotsSubmitter } from "../../src/execution/flashbots.js";

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
const SERIALIZED_TX =
  "0x02f86c0180843b9aca0084773594008252089411111111111111111111111111111111111111118084c2985578c001a0a11f5a8a0f4d8d25569d5e4f7f0626ab3f6fcb36ed3b1e4a3ec7fcbcb58f2c0aa02e42f6b9ba3d4f2836454dfd1d565f0a4b7a9f0c9865df2dd8d64f0d3f96b610";
const TX_HASH = keccak256(SERIALIZED_TX);

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

  it("simulates, submits, and retries until a bundle is included", async () => {
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
        .mockResolvedValueOnce({ blockNumber: 102n }),
    };

    const walletClient = {
      account: {
        address: "0x2222222222222222222222222222222222222222",
        signTransaction: vi.fn().mockResolvedValue(SERIALIZED_TX),
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
        pollIntervalMs: 0,
        sleep: () => Promise.resolve(),
      },
    );

    const submission = await submitter.submit({
      to: "0x1111111111111111111111111111111111111111",
      abi: SIMPLE_ABI,
      functionName: "poke",
      args: [],
      account: "0x2222222222222222222222222222222222222222",
    });

    expect(submitter.supportsLiveSubmission).toBe(true);
    expect(submission).toEqual({
      mode: "flashbots",
      txHash: TX_HASH,
      bundleHash: "bundle-2",
      targetBlock: 102n,
      privateSubmission: true,
      relayUrl: "https://relay.flashbots.net",
    });

    expect(mockFetch).toHaveBeenCalledTimes(4);

    const firstRequest = mockFetch.mock.calls[0][1];
    expect(firstRequest.headers["X-Flashbots-Signature"]).toContain(
      `${AUTH_ADDRESS}:`,
    );

    const firstBody = JSON.parse(firstRequest.body as string);
    expect(firstBody.method).toBe("eth_callBundle");
    expect(firstBody.params[0].txs).toEqual([SERIALIZED_TX]);

    const secondBody = JSON.parse(mockFetch.mock.calls[1][1].body as string);
    expect(secondBody.method).toBe("eth_sendBundle");
    expect(secondBody.params[0].blockNumber).toBe("0x65");
  });

  it("reports healthy when the relay responds to a probe", async () => {
    mockFetch.mockResolvedValue(makeResponse({ result: "0x1" }));

    const submitter = createFlashbotsSubmitter(
      { chain: mainnet } as never,
      {} as never,
      AUTH_KEY,
    );

    await expect(submitter.isHealthy()).resolves.toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
