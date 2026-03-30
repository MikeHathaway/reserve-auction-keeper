import { logger } from "./logger.js";

export interface RetryOptions {
  retries?: number;
  initialDelayMs?: number;
  factor?: number;
  maxDelayMs?: number;
  jitterMs?: number;
  label?: string;
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isTransientRpcError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();

  const nonRetryableMarkers = [
    "insufficient funds",
    "nonce too low",
    "replacement transaction underpriced",
    "execution reverted",
    "revert",
    "user rejected",
    "denied",
    "already known",
    "intrinsic gas too low",
  ];

  if (nonRetryableMarkers.some((marker) => message.includes(marker))) {
    return false;
  }

  const retryableMarkers = [
    "timeout",
    "timed out",
    "fetch failed",
    "failed to fetch",
    "network error",
    "socket hang up",
    "connection reset",
    "temporarily unavailable",
    "service unavailable",
    "gateway timeout",
    "rate limit",
    "429",
    "502",
    "503",
    "504",
    "econnreset",
    "etimedout",
    "enotfound",
  ];

  return retryableMarkers.some((marker) => message.includes(marker));
}

export async function retryAsync<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    retries = 3,
    initialDelayMs = 250,
    factor = 2,
    maxDelayMs = 5_000,
    jitterMs = 100,
    label = "operation",
    shouldRetry = () => true,
    sleep = defaultSleep,
  } = options;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= retries || !shouldRetry(error, attempt)) {
        throw error;
      }

      const baseDelay = Math.min(
        maxDelayMs,
        initialDelayMs * factor ** (attempt - 1),
      );
      const jitter = jitterMs > 0 ? Math.floor(Math.random() * jitterMs) : 0;
      const delayMs = Math.min(maxDelayMs, baseDelay + jitter);

      logger.warn("Retrying failed operation", {
        label,
        attempt,
        retries,
        delayMs,
        error: getErrorMessage(error),
      });

      await sleep(delayMs);
    }
  }

  throw new Error(`Retry loop exited unexpectedly for ${label}`);
}
