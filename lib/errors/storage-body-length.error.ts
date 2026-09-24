import { StorageError } from './storage.error.js';

/**
 * The body passed to `put()` didn't match `contentLength`, or went over a disk's limit.
 * Nothing was written. Status 400.
 */
export class StorageBodyLengthError extends StorageError {
  readonly status = 400;
  constructor(
    readonly expected: number,
    readonly received: number,
  ) {
    super(
      received > expected
        ? `The body is longer than the declared ${expected} bytes`
        : `The body ended after ${received} of the declared ${expected} bytes`,
    );
  }
}
