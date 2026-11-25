export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  /** Upper bound for a single backoff delay. */
  maxDelayMs: number;
  /** Decides whether an error is worth retrying. Defaults to isRetryable. */
  shouldRetry?: (err: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
}

export class HttpStatusError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

/** Retries on 429, 5xx responses and transient network errors; never on other 4xx. */
export function isRetryable(err: unknown): boolean {
  if (err instanceof HttpStatusError) return err.status === 429 || err.status >= 500;
  const code = (err as { code?: string } | null)?.code;
  return code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ECONNREFUSED";
}

/**
 * Exponential backoff with "full jitter": the delay before attempt n is a random
 * value in [0, min(maxDelayMs, baseDelayMs * 2^(n-1))].
 */
export function backoffDelay(attempt: number, baseDelayMs: number, maxDelayMs: number, random = Math.random): number {
  const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  return Math.floor(random() * ceiling);
}

export async function retry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  const shouldRetry = opts.shouldRetry ?? isRetryable;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastError: unknown;
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt === opts.maxAttempts || !shouldRetry(err)) break;
      await sleep(backoffDelay(attempt, opts.baseDelayMs, opts.maxDelayMs));
    }
  }
  throw lastError;
}
