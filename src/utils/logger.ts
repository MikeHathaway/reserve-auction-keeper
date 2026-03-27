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

export function setLogLevel(level: LogLevel) {
  minLevel = level;
}

function log(level: LogLevel, message: string, data?: Record<string, unknown>) {
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[minLevel]) return;

  const entry = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...data,
  };

  const output = JSON.stringify(entry);

  if (LEVEL_PRIORITY[level] >= LEVEL_PRIORITY["error"]) {
    process.stderr.write(output + "\n");
  } else {
    process.stdout.write(output + "\n");
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
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: message, ...data }),
    });
  } catch {
    logger.error("Failed to send webhook alert", { webhookUrl });
  }
}
