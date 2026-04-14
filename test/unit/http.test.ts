import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchWithTimeout } from "../../src/utils/http.js";

describe("fetchWithTimeout", () => {
  const originalFetch = globalThis.fetch;
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    globalThis.fetch = mockFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("rejects with a timeout error when the request hangs", async () => {
    mockFetch.mockImplementation((_, init?: RequestInit) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          { once: true },
        );
      }));

    const pending = fetchWithTimeout("https://example.com", {
      timeoutMs: 100,
      label: "unit-test-fetch",
    });
    const assertion = expect(pending).rejects.toThrow(
      "unit-test-fetch timed out after 100ms",
    );

    await vi.advanceTimersByTimeAsync(100);

    await assertion;
  });
});
