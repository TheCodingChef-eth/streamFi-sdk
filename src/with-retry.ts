import { RateLimitError } from './errors.js';

export interface WithRetryOptions {
  /** Maximum number of retry attempts after the initial failure. Default: 3 */
  maxRetries?: number;
  /** Initial backoff delay in milliseconds when Retry-After is absent. Default: 500 */
  baseDelayMs?: number;
  /** Backoff multiplier applied after each retry. Default: 2 */
  backoffFactor?: number;
}

/**
 * Retry an async operation when it throws a RateLimitError.
 *
 * Honours the server Retry-After header (exposed on the error as
 * retryAfterMs) by waiting at least that long before the next attempt.
 * When no Retry-After is provided, falls back to exponential backoff
 * starting at baseDelayMs.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: WithRetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const backoffFactor = options.backoffFactor ?? 2;

  let delay = baseDelayMs;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await operation();
    } catch (err) {
      const classified = RateLimitError.fromRpcError(err);
      if (!(classified instanceof RateLimitError) || attempt === maxRetries) {
        throw classified ?? err;
      }
      const waitTime = classified.retryAfterMs ?? delay;
      await sleep(waitTime);
      delay *= backoffFactor;
    }
  }

  // Unreachable, but satisfies TypeScript flow analysis.
  throw new Error('withRetry exhausted all retries');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
