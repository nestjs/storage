import { StorageError } from './storage.error.js';

const MESSAGES: Record<string, string> = {
  NoSuchUpload: 'no longer exists: it was completed, aborted or expired',
  InvalidPart: 'has no uploaded part matching one of the listed part numbers and ETags',
  InvalidPartOrder: 'was given its parts out of order',
  EntityTooSmall: "has a part other than the last below the store's minimum part size",
};

/**
 * A multipart upload refused what the client sent: an upload id that no longer exists
 * (`NoSuchUpload`, status 404), or parts that don't match the ones uploaded (`InvalidPart`,
 * `InvalidPartOrder`, `EntityTooSmall`, status 400). Nothing was written.
 */
export class StorageMultipartUploadError extends StorageError {
  readonly status: 400 | 404;

  constructor(
    /** The store's error code. */
    readonly code: string,
    readonly uploadId: string,
    options?: { cause?: unknown },
  ) {
    super(`The multipart upload "${uploadId}" ${MESSAGES[code] ?? `was refused: ${code}`}`, options);
    this.status = code === 'NoSuchUpload' ? 404 : 400;
  }
}
