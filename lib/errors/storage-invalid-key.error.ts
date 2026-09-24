import { StorageError } from './storage.error.js';

/**
 * The key can't be used on any disk: empty, longer than 1024 bytes, absolute, with a `.`,
 * `..` or empty segment, a backslash, or a control character. Status 400. The key isn't
 * quoted in the message: it usually comes from user input.
 */
export class StorageInvalidKeyError extends StorageError {
  readonly status = 400;
  constructor(readonly reason: string) {
    super(`Invalid storage key: ${reason}`);
  }
}
