import type { Readable } from 'node:stream';
import type { Duration } from './duration.interface.js';

/**
 * What `put()` accepts: bytes, text (written as UTF-8), a Node `Readable`, a web
 * `ReadableStream`, or any async iterable of byte chunks (such as a generator).
 */
export type StorageBody =
  | Buffer
  | Uint8Array
  | string
  | Readable
  | ReadableStream<Uint8Array>
  | AsyncIterable<Uint8Array>;

/** A file's metadata, as `stat()` returns it and `get()` returns it next to the body. */
export interface StorageFile {
  key: string;
  /** Bytes. */
  size: number;
  contentType: string;
  lastModified: Date;
  /** Changes whenever the content does. Quoted, as in an HTTP `ETag` header. */
  etag?: string;
  cacheControl?: string;
  contentDisposition?: string;
  /** Your own metadata, from `put()`. Names are lowercase. */
  metadata: Record<string, string>;
}

/** What `put()`, `copy()` and `move()` resolve to. */
export interface StorageWriteResult {
  key: string;
  size: number;
  contentType: string;
  etag?: string;
}

/** A byte range to read: `{ start, end }` (inclusive, `end` defaults to the last byte) or the last `suffix` bytes. */
export type StorageRange = { start: number; end?: number } | { suffix: number };

/** What `get()` resolves to: the metadata and the body as a Node `Readable`. */
export interface StorageDownload extends StorageFile {
  /** Read it to the end, or destroy it, so the file handle or connection is released. */
  body: Readable;
  /** With a `range`: the bytes returned, inclusive, and the file's full size. `size` is the whole file's. */
  range?: { start: number; end: number };
}

export interface StoragePutOptions {
  /** Default: from the key's extension (a small built-in table), else `application/octet-stream`. */
  contentType?: string;
  /** Stored and sent back as `Cache-Control` by `serveFile()`, by S3 and by CDNs in front of it. */
  cacheControl?: string;
  /** Stored and sent back as `Content-Disposition`. */
  contentDisposition?: string;
  /** Your own string metadata: names of letters, digits, `-` and `_`; printable ASCII values; 2 KB in total. */
  metadata?: Record<string, string>;
  /**
   * The body's length in bytes, when known. A body that turns out longer or shorter fails with
   * `StorageBodyLengthError` and nothing is written. S3 uses it to size multipart parts.
   */
  contentLength?: number;
  /** Aborts the write; nothing is written. */
  signal?: AbortSignal;
}

export interface StorageGetOptions {
  range?: StorageRange;
}

export interface StorageListOptions {
  /** Only keys that start with this string (not necessarily at a `/`). */
  prefix?: string;
  /** The `cursor` of the previous page. */
  cursor?: string;
  /** Up to 1000 entries per page (the default). */
  limit?: number;
}

/** One file in a listing. Listings don't carry content types or metadata; `stat()` a file for them. */
export interface StorageListEntry {
  key: string;
  size: number;
  lastModified: Date;
  etag?: string;
}

export interface StorageListPage {
  /** In ascending UTF-8 byte order of their keys, on every disk. */
  entries: StorageListEntry[];
  /** Pass it to the next `list()` call; absent on the last page. */
  cursor?: string;
}

export interface StorageSignedUrlRequest {
  /** Default 15 minutes; at most 7 days, S3's limit, on every disk. */
  expiresIn?: Duration;
  /** Downloads as this file name (`Content-Disposition: attachment; filename=...`). */
  filename?: string;
  /** `inline` shows the file in the browser, when its type allows. Default `attachment` when `filename` is set. */
  disposition?: 'attachment' | 'inline';
}

export interface StorageSignedUploadRequest {
  /** The upload must be sent with exactly this `Content-Type`. */
  contentType: string;
  /** The upload must be exactly this many bytes. Without it, the size isn't limited: check it afterwards with `stat()`. */
  contentLength?: number;
  /** Default 15 minutes; at most 7 days. */
  expiresIn?: Duration;
}

/** What `signedUpload()` returns: hand it to the client, which sends `PUT url` with `headers`. */
export interface StorageSignedUpload {
  url: string;
  method: 'PUT';
  /** Headers the client must send as they are (`Content-Length` is set by every HTTP client). */
  headers: Record<string, string>;
  expiresAt: Date;
}

/** What a disk's `writeObject()` receives besides the body: validated, with defaults applied. */
export interface StorageObjectWrite {
  contentType: string;
  cacheControl?: string;
  contentDisposition?: string;
  metadata: Record<string, string>;
  /** Known when the caller declared it, or the body was in memory. */
  contentLength?: number;
  /** Whether the caller set `contentType` (a local disk stores only what it can't infer). */
  explicitContentType: boolean;
  signal?: AbortSignal;
}
