import { fetchWithTimeout } from "./http.js";

export type LogLevel = "debug" | "info" | "warn" | "error" | "alert" | "fatal";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  alert: 4,
  fatal: 5,
};

let minLevel: LogLevel = "info";
let alertWebhookUrl: string | undefined;
const URL_PATTERN = /https?:\/\/[^\s"'`]+/g;

export function redactUrlForLogs(url?: string): string | undefined {
  if (!url) return url;
  try {
    const parsed = new URL(url);
    const suffix = parsed.pathname && parsed.pathname !== "/" ? "/..." : "";
    return `${parsed.protocol}//${parsed.host}${suffix}`;
  } catch {
    return "[redacted-url]";
  }
}

export function redactSensitiveTextForLogs(value: string): string {
  return value.replace(URL_PATTERN, (url) => redactUrlForLogs(url) ?? "[redacted-url]");
}

export function formatErrorForLogs(error: unknown): string {
  if (error instanceof Error) {
    return redactSensitiveTextForLogs(error.message);
  }
  return redactSensitiveTextForLogs(String(error));
}

function sanitizeLogValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactSensitiveTextForLogs(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeLogValue(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [key, sanitizeLogValue(nestedValue)]),
    );
  }

  return value;
}

export function setLogLevel(level: LogLevel) {
  minLevel = level;
}

export function setAlertWebhookUrl(webhookUrl?: string) {
  alertWebhookUrl = webhookUrl;
}

function log(level: LogLevel, message: string, data?: Record<string, unknown>) {
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[minLevel]) return;

  const safeMessage = redactSensitiveTextForLogs(message);
  const safeData = data ? sanitizeLogValue(data) as Record<string, unknown> : undefined;
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg: safeMessage,
    ...safeData,
  };

  const output = JSON.stringify(entry);

  if (LEVEL_PRIORITY[level] >= LEVEL_PRIORITY["error"]) {
    process.stderr.write(output + "\n");
  } else {
    process.stdout.write(output + "\n");
  }

  if ((level === "alert" || level === "fatal") && alertWebhookUrl) {
    void sendWebhookAlert(alertWebhookUrl, safeMessage, {
      level,
      ...safeData,
    });
  }
}

export const logger = {
  debug: (msg: string, data?: Record<string, unknown>) => log("debug", msg, data),
  info: (msg: string, data?: Record<string, unknown>) => log("info", msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => log("warn", msg, data),
  error: (msg: string, data?: Record<string, unknown>) => log("error", msg, data),
  alert: (msg: string, data?: Record<string, unknown>) => log("alert", msg, data),
  fatal: (msg: string, data?: Record<string, unknown>) => log("fatal", msg, data),
};

export async function sendWebhookAlert(
  webhookUrl: string,
  message: string,
  data?: Record<string, unknown>,
) {
  try {
    const response = await fetchWithTimeout(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: message, ...data }),
      label: "alert-webhook",
    });
    if (!response.ok) {
      logger.error("Failed to send webhook alert", {
        webhookUrl: redactUrlForLogs(webhookUrl),
        status: response.status,
        statusText: response.statusText,
      });
    }
  } catch {
    logger.error("Failed to send webhook alert", {
      webhookUrl: redactUrlForLogs(webhookUrl),
    });
  }
}
