import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sleep } from "../../src/keeper.js";

describe("keeper sleep", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("clears the wake interval when the timer completes naturally", async () => {
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");

    const pending = sleep(1_000, () => false, 100);
    await vi.advanceTimersByTimeAsync(1_000);
    await pending;

    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
  });

  it("clears timers when shutdown wakeup triggers early", async () => {
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    let shouldWake = false;

    const pending = sleep(10_000, () => shouldWake, 100);
    await vi.advanceTimersByTimeAsync(100);
    shouldWake = true;
    await vi.advanceTimersByTimeAsync(100);
    await pending;

    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    expect(clearTimeoutSpy).toHaveBeenCalled();
  });
});
