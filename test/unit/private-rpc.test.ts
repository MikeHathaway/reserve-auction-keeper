import { describe, expect, it, vi } from "vitest";
import { base } from "viem/chains";
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
    );
    vi.spyOn(submitter, "isHealthy").mockResolvedValue(true);

    const submission = await submitter.submit(REQUEST);

    expect(submission).toEqual({
      mode: "private-rpc",
      txHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      privateSubmission: true,
      relayUrl: "https://private-rpc.example",
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
    );
    vi.spyOn(submitter, "isHealthy").mockResolvedValue(true);

    await expect(submitter.submit(REQUEST)).rejects.toThrow("insufficient funds");
    expect(walletClient.sendTransaction).toHaveBeenCalledTimes(1);
  });
});
