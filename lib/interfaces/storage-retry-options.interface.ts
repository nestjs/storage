import type { Duration } from './duration.interface.js';

/** How long to wait between attempts. */
export interface StorageBackoffOptions {
  /** Wait before the first retry. Default 100 ms. */
  delay?: Duration;
  /** Growth per retry; `1` = constant. Default 2. */
  factor?: number;
  /** Cap for a single wait. Default 20 s. */
  maxDelay?: Duration;
  /** Default `full`: a random wait in [0, computed], so clients don't retry in lockstep. */
  jitter?: 'full' | 'equal' | 'none';
}

/**
 * Retries for an object store's transient failures: connection errors, timeouts, 429, 500,
 * 502, 503 and 504 responses, and S3's `SlowDown`, `InternalError` and `RequestTimeout`.
 * Every field replaces its default; unset fields keep it.
 */
export interface StorageRetryOptions {
  /** Total attempts, including the first. Default 3. */
  attempts?: number;
  /** A function gets the attempt that just failed (1-based) and its error. */
  backoff?: StorageBackoffOptions | ((attempt: number, error: unknown) => Duration);
  /** Asked about every failure that would be retried; return `false` to stop. */
  retryIf?: (error: unknown, attempt: number) => boolean;
}
