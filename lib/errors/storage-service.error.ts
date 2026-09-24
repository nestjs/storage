import { StorageError } from './storage.error.js';

/**
 * An object store refused a request or couldn't be reached: access denied, a missing
 * bucket, throttling that outlasted the retries, a network failure or a timeout. It
 * signals a configuration problem or an outage, so it carries no 4xx `status`;
 * `upstreamStatus` has the store's HTTP status, when there was one.
 */
export class StorageServiceError extends StorageError {
  /** The store's error code (`AccessDenied`, `NoSuchBucket`, `SlowDown`), or `NetworkError`, `Timeout`. */
  readonly code: string;
  readonly upstreamStatus: number | undefined;
  readonly requestId: string | undefined;
  readonly operation: string;

  constructor(init: {
    operation: string;
    code: string;
    message?: string;
    upstreamStatus?: number;
    requestId?: string;
    cause?: unknown;
  }) {
    super(
      `${init.operation} failed: ${init.code}${init.upstreamStatus ? ` (${init.upstreamStatus})` : ''}` +
        (init.message ? `: ${init.message}` : ''),
      init.cause === undefined ? undefined : { cause: init.cause },
    );
    this.operation = init.operation;
    this.code = init.code;
    this.upstreamStatus = init.upstreamStatus;
    this.requestId = init.requestId;
  }
}
