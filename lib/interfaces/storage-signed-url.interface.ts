/**
 * App-served signed URLs, for disks that can't presign on their own (`LocalDisk`,
 * `InMemoryDisk`): the app verifies them in the route that serves `baseUrl`.
 */
export interface StorageSignedUrlOptions {
  /**
   * The absolute URL of the route that serves the disk's files, e.g.
   * `https://api.example.com/files`. The key and the signature go in its query string.
   */
  baseUrl: string | URL;
  /**
   * HMAC keys. The first signs; every key verifies, so a new key goes first and the old
   * one stays until the URLs it signed have expired. String keys have at least 32
   * characters; Buffers at least 32 bytes.
   */
  keys: (string | Buffer)[];
}

/** What an app-served signed URL grants, as `verifySignedUrl()` returns it. */
export interface StorageSignedUrlClaims {
  key: string;
  method: 'GET' | 'PUT';
  expiresAt: Date;
  /** PUT: the `Content-Type` the upload must have. */
  contentType?: string;
  /** PUT: the exact `Content-Length` the upload must have. */
  contentLength?: number;
  /** GET: the `Content-Disposition` to answer with. */
  contentDisposition?: string;
}
