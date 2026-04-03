import { describe, expect, it, vi } from "vitest";
import {
  estimateKickClaimableValueUsd,
  kickReserveAuction,
} from "../../src/auction/kick.js";
import { parseEther } from "viem";
import type { MevSubmitter } from "../../src/execution/mev-submitter.js";

const POOL = "0x1111111111111111111111111111111111111111";
const WALLET = "0x2222222222222222222222222222222222222222";

function makeSubmitter(): MevSubmitter {
  return {
    name: "private-rpc",
    supportsLiveSubmission: true,
    submit: vi.fn().mockResolvedValue({
      mode: "private-rpc",
      txHash: `0x${"ab".repeat(32)}`,
      privateSubmission: true,
    }),
    isHealthy: vi.fn().mockResolvedValue(true),
  };
}

describe("kick reserve auction", () => {
  it("estimates claimable reserve value in usd", () => {
    expect(estimateKickClaimableValueUsd(parseEther("0.00249"), 1)).toBeCloseTo(0.00249, 8);
  });

  it("submits through the configured submitter and waits for a successful receipt", async () => {
    const publicClient = {
      waitForTransactionReceipt: vi.fn().mockResolvedValue({
        status: "success",
        blockNumber: 123n,
      }),
    };
    const submitter = makeSubmitter();

    const result = await kickReserveAuction(
      publicClient as never,
      submitter,
      WALLET,
      POOL,
    );

    expect(submitter.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        to: POOL,
        functionName: "kickReserveAuction",
        args: [],
        account: WALLET,
      }),
    );
    expect(publicClient.waitForTransactionReceipt).toHaveBeenCalledWith({
      hash: `0x${"ab".repeat(32)}`,
    });
    expect(result).toMatchObject({
      mode: "private-rpc",
      txHash: `0x${"ab".repeat(32)}`,
      receiptBlockNumber: 123n,
    });
  });

  it("fails fast when the submitter does not return a transaction hash", async () => {
    const publicClient = {
      waitForTransactionReceipt: vi.fn(),
    };
    const submitter = makeSubmitter();
    vi.mocked(submitter.submit).mockResolvedValue({
      mode: "private-rpc",
      privateSubmission: true,
    });

    await expect(
      kickReserveAuction(publicClient as never, submitter, WALLET, POOL),
    ).rejects.toThrow("did not return a transaction hash");
    expect(publicClient.waitForTransactionReceipt).not.toHaveBeenCalled();
  });

  it("fails when the kick transaction reverts on-chain", async () => {
    const publicClient = {
      waitForTransactionReceipt: vi.fn().mockResolvedValue({
        status: "reverted",
        blockNumber: 321n,
      }),
    };
    const submitter = makeSubmitter();

    await expect(
      kickReserveAuction(publicClient as never, submitter, WALLET, POOL),
    ).rejects.toThrow("reverted on-chain");
  });
});
