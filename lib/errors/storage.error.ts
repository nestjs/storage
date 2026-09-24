/**
 * Base class of every error a disk raises itself. Errors from the body you pass to `put()`
 * (a stream that fails mid-way) and a caller's abort (`signal.reason`) propagate unchanged.
 */
export class StorageError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}
