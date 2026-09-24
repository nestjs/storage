import { StorageError } from './storage.error.js';

/** Why an app-served signed URL was refused. */
export type StorageSignedUrlFailure = 'missing' | 'invalid' | 'expired' | 'method';

/**
 * An app-served signed URL (see `signedUrls` on `LocalDisk` and `InMemoryDisk`) that is
 * missing its parameters, was tampered with, has expired, or is used with another method.
 * Status 403.
 */
export class StorageSignedUrlError extends StorageError {
  readonly status = 403;
  constructor(readonly reason: StorageSignedUrlFailure) {
    super(
      reason === 'expired'
        ? 'The signed URL has expired'
        : reason === 'method'
          ? 'The signed URL was issued for another method'
          : 'The signed URL is invalid',
    );
  }
}
