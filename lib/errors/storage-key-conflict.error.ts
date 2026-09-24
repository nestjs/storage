import { StorageError } from './storage.error.js';

/**
 * A local disk can't hold both `a` and `a/b`: one of them would have to be a file and a
 * directory at once. Object stores allow it, so keep keys that are also prefixes out of
 * designs that must run on a local disk. Status 409.
 */
export class StorageKeyConflictError extends StorageError {
  readonly status = 409;
  constructor(readonly key: string) {
    super(`"${key}" conflicts with an existing file or directory on this disk`);
  }
}
