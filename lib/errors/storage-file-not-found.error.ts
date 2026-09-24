import { StorageError } from './storage.error.js';

/** No file at `key`. Carries `status` 404, so other packages treat it as the caller's mistake. */
export class StorageFileNotFoundError extends StorageError {
  readonly status = 404;
  constructor(readonly key: string) {
    super(`No file at "${key}"`);
  }
}
