import type { StorageRetryOptions } from '../interfaces/storage-retry-options.interface.js';
import { toMs } from '../utils/duration.util.js';
import type { Duration } from '../interfaces/duration.interface.js';

export interface ResolvedRetry {
  attempts: number;
  delay: (attempt: number, error: unknown) => number;
  retryIf?: (error: unknown, attempt: number) => boolean;
}

export function resolveRetry(input: number | false | StorageRetryOptions | undefined, owner: string): ResolvedRetry {
  if (input === false) {
    return { attempts: 1, delay: () => 0 };
  }

  const options: StorageRetryOptions = typeof input === 'number' ? { attempts: input } : (input ?? {});
  const attempts = options.attempts ?? 3;
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new TypeError(`${owner} \`retry.attempts\` must be a whole number of at least 1`);
  }

  const backoff = options.backoff;
  if (typeof backoff === 'function') {
    return {
      attempts,
      retryIf: options.retryIf,
      delay: (attempt, error) => duration(backoff(attempt, error), `${owner} \`retry.backoff()\``),
    };
  }

  const delay = duration(backoff?.delay ?? 100, `${owner} \`retry.backoff.delay\``);
  const maxDelay = duration(backoff?.maxDelay ?? 20_000, `${owner} \`retry.backoff.maxDelay\``);
  const factor = backoff?.factor ?? 2;
  const jitter = backoff?.jitter ?? 'full';

  return {
    attempts,
    retryIf: options.retryIf,
    delay: (attempt) => {
      const ceiling = Math.min(maxDelay, delay * factor ** (attempt - 1));
      if (jitter === 'none') {
        return Math.floor(ceiling);
      }
      if (jitter === 'equal') {
        return Math.floor(ceiling / 2 + (Math.random() * ceiling) / 2);
      }
      return Math.floor(Math.random() * ceiling);
    },
  };
}

export function duration(value: Duration, option: string): number {
  try {
    return toMs(value);
  } catch (error) {
    throw new TypeError(`${option}: ${(error as Error).message}`);
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(signal.reason);
    }

    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
