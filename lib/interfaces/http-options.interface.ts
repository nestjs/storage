export interface ServeFileOptions {
  /** The request: enables `Range` (206 partial responses) and `If-None-Match` (304). */
  req?: unknown;
  /** The response (`@Res({ passthrough: true })`), for the status and headers. Required. */
  res: unknown;
  /**
   * `inline` lets a browser display the file, but only for types that can't run script in
   * your origin (images other than SVG, PDF, audio, video, plain text); others are sent as
   * `attachment` anyway. Default `attachment`.
   */
  disposition?: 'attachment' | 'inline';
  /** The download's file name. Default: the key's last segment. */
  filename?: string;
  /**
   * Overrides the file's stored `Cache-Control`. Without either, the response is `private`:
   * a proxy or CDN never keeps a file that may be one user's.
   */
  cacheControl?: string;
}

export interface ServeSignedUrlOptions extends Omit<ServeFileOptions, 'filename' | 'disposition'> {
  req: unknown;
}

export interface ReceiveSignedUploadOptions {
  /** The request (`@Req()`). Its body must not have been parsed. */
  req: unknown;
  /** The response (`@Res({ passthrough: true })`), to send the new file's `ETag`, as S3 does. */
  res?: unknown;
  /** Refuse bodies over this many bytes when the URL was signed without a `contentLength`. */
  maxSize?: number;
}
