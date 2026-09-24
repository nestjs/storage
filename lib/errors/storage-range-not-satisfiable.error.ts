import { StorageError } from './storage.error.js';

/**
 * The requested byte range starts beyond the end of the file (or asks for zero bytes).
 * Status 416. `size` is the file's size, for a `Content-Range: bytes *\/size` header.
 */
export class StorageRangeNotSatisfiableError extends StorageError {
  readonly status = 416;
  constructor(
    readonly key: string,
    readonly size: number | undefined,
  ) {
    super(`The requested range of "${key}" is not satisfiable`);
  }
}
