import { describe, it, expect, vi } from "vitest";
import {
  isTransientRpcError,
  retryAsync,
} from "../../src/utils/retry.js";

describe("retry", () => {
  it("retries until the operation succeeds", async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(new Error("rpc timeout"))
      .mockResolvedValueOnce("ok");
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await retryAsync(operation, {
      retries: 3,
      initialDelayMs: 25,
      jitterMs: 0,
      sleep,
      label: "test-op",
    });

    expect(result).toBe("ok");
    expect(operation).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(25);
  });

  it("stops after the configured number of attempts", async () => {
    const operation = vi.fn().mockRejectedValue(new Error("still broken"));
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      retryAsync(operation, {
        retries: 3,
        initialDelayMs: 10,
        jitterMs: 0,
        sleep,
      }),
    ).rejects.toThrow("still broken");

    expect(operation).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("respects shouldRetry when an error is not retryable", async () => {
    const operation = vi.fn().mockRejectedValue(new Error("insufficient funds"));
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      retryAsync(operation, {
        retries: 3,
        sleep,
        shouldRetry: isTransientRpcError,
      }),
    ).rejects.toThrow("insufficient funds");

    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("detects transient transport errors", () => {
    expect(isTransientRpcError(new Error("fetch failed"))).toBe(true);
    expect(isTransientRpcError(new Error("503 service unavailable"))).toBe(true);
    expect(isTransientRpcError(new Error("execution reverted"))).toBe(false);
  });
});
