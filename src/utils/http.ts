export interface FetchWithTimeoutOptions extends RequestInit {
  timeoutMs?: number;
  label?: string;
}

const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

export async function fetchWithTimeout(
  input: URL | RequestInfo,
  options: FetchWithTimeoutOptions = {},
): Promise<Response> {
  const {
    timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
    label = "HTTP request",
    signal,
    ...init
  } = options;

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return fetch(input, { ...init, signal });
  }

  const controller = new AbortController();
  let timedOut = false;
  let abortFromCaller: (() => void) | undefined;

  if (signal) {
    abortFromCaller = () => controller.abort(signal.reason);
    if (signal.aborted) {
      abortFromCaller();
    } else {
      signal.addEventListener("abort", abortFromCaller, { once: true });
    }
  }

  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (timedOut) {
      throw new Error(`${label} timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    if (signal && abortFromCaller) {
      signal.removeEventListener("abort", abortFromCaller);
    }
  }
}
