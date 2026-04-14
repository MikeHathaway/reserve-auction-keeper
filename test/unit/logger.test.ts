import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatErrorForLogs,
  logger,
  redactUrlForLogs,
  redactSensitiveTextForLogs,
  sendWebhookAlert,
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

  it("redacts sensitive URLs before logging them", () => {
    expect(redactUrlForLogs("https://hooks.example.com/services/a/b/c?token=secret")).toBe(
      "https://hooks.example.com/...",
    );
    expect(redactUrlForLogs("not-a-url")).toBe("[redacted-url]");
  });

  it("redacts embedded provider URLs in free-form text", () => {
    expect(
      redactSensitiveTextForLogs(
        "RPC Request failed. URL: https://base-mainnet.g.alchemy.com/v2/secret-key",
      ),
    ).toBe("RPC Request failed. URL: https://base-mainnet.g.alchemy.com/...");
    expect(
      formatErrorForLogs(
        new Error("HTTP request failed.\nURL: https://mainnet.infura.io/v3/secret-key"),
      ),
    ).toBe("HTTP request failed.\nURL: https://mainnet.infura.io/...");
  });

  it("sanitizes alert payloads before sending them to the webhook sink", () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
    });

    setAlertWebhookUrl("https://alerts.example.com/hook");
    logger.alert("Private RPC unhealthy", {
      error: "RPC Request failed. URL: https://base-mainnet.g.alchemy.com/v2/secret-key",
    });

    const payload = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(payload.error).toBe("RPC Request failed. URL: https://base-mainnet.g.alchemy.com/...");
  });

  it("logs webhook delivery failures when the endpoint rejects the request", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Server Error",
    });

    await sendWebhookAlert("https://alerts.example.com/hook", "Price feed unavailable");

    expect(process.stderr.write).toHaveBeenCalledWith(
      expect.stringContaining("\"msg\":\"Failed to send webhook alert\""),
    );
    expect(process.stderr.write).toHaveBeenCalledWith(
      expect.stringContaining("\"status\":500"),
    );
  });
});
