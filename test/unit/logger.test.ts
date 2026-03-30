import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  logger,
  setAlertWebhookUrl,
  setLogLevel,
} from "../../src/utils/logger.js";

describe("logger", () => {
  const originalFetch = globalThis.fetch;
  const mockFetch = vi.fn();

  beforeEach(() => {
    globalThis.fetch = mockFetch;
    setLogLevel("debug");
    setAlertWebhookUrl(undefined);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    setAlertWebhookUrl(undefined);
    vi.restoreAllMocks();
  });

  it("sends webhook payloads for alert logs", () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
    });

    setAlertWebhookUrl("https://alerts.example.com/hook");
    logger.alert("Price feed unavailable", { chain: "base", pool: "0xpool" });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://alerts.example.com/hook",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );

    const payload = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(payload).toMatchObject({
      text: "Price feed unavailable",
      level: "alert",
      chain: "base",
      pool: "0xpool",
    });
  });

  it("does not send webhook payloads for info logs", () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
    });

    setAlertWebhookUrl("https://alerts.example.com/hook");
    logger.info("Keeper started", { chain: "base" });

    expect(mockFetch).not.toHaveBeenCalled();
  });
});
