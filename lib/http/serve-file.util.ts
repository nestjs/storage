import type { ServeFileOptions, ServeSignedUrlOptions } from '../interfaces/http-options.interface.js';
import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
  StreamableFile,
} from '@nestjs/common';
import { StorageFileNotFoundError } from '../errors/storage-file-not-found.error.js';
import { StorageInvalidKeyError } from '../errors/storage-invalid-key.error.js';
import { StorageRangeNotSatisfiableError } from '../errors/storage-range-not-satisfiable.error.js';
import { StorageSignedUrlError } from '../errors/storage-signed-url.error.js';
import { basename } from '../utils/keys.util.js';
import { contentDisposition, servesSignedUrls, type StorageDisk } from '../disks/storage.disk.js';
import type { StorageDownload, StorageRange } from '../interfaces/storage-disk.interface.js';

/**
 * Types a browser can't execute in your origin when shown inline. Everything else (HTML,
 * SVG, XML, JavaScript, unknown types) is forced to `attachment`, and `nosniff` stops the
 * browser from guessing a more dangerous type.
 */
const INLINE_SAFE = /^(image\/(png|jpeg|gif|webp|avif|heic|bmp)|application\/pdf|audio\/[\w.+-]+|video\/[\w.+-]+|text\/plain)(;|$)/i;

/**
 * Streams a file from a disk as the response, with `Content-Type`, `Content-Length`,
 * `Content-Disposition` (attachment unless the type is safe inline), `ETag`, `Last-Modified`,
 * `Cache-Control` (the stored one, else `private`), `X-Content-Type-Options: nosniff` and
 * `Accept-Ranges: bytes`. With `req`, a single `Range` gets a 206 and `If-None-Match` a 304.
 * A missing file is a `NotFoundException`, a range past the end a 416. A client that
 * disconnects mid-way releases the file (Express pipes a stream without doing that).
 *
 * ```ts
 * @Get(':id/invoice')
 * invoice(@Param('id') id: string, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
 *   return serveFile(this.invoices, `invoices/${id}.pdf`, { req, res, filename: `invoice-${id}.pdf` });
 * }
 * ```
 */
export async function serveFile(
  disk: StorageDisk,
  key: string,
  options: ServeFileOptions,
): Promise<StreamableFile | undefined> {
  return respond(disk, key, options, undefined);
}

/**
 * Serves a file behind an app-served signed URL (a `LocalDisk` or `InMemoryDisk` with
 * `signedUrls`): checks the signature, the expiry and the method, then answers like
 * `serveFile()`, with the `Content-Disposition` the URL was signed with (an attachment named
 * after the key when none was). A bad or expired URL is a `ForbiddenException`.
 */
export async function serveSignedUrl(disk: StorageDisk, options: ServeSignedUrlOptions): Promise<StreamableFile | undefined> {
  const claims = verify(disk, options.req, 'GET');
  return respond(disk, claims.key, options, claims.contentDisposition);
}

async function respond(
  disk: StorageDisk,
  key: string,
  options: ServeFileOptions,
  signedDisposition: string | undefined,
): Promise<StreamableFile | undefined> {
  const { req, res } = options;
  assertResponse(res); // before any I/O, so a wrong `res` never leaves a file open

  const headers = requestHeaders(req);
  let range = parseRange(headers.range);
  let download: StorageDownload;
  try {
    // If-Range: the range only applies to the version the client already has (RFC 9110 §13.1.5).
    if (range && headers['if-range'] !== undefined && headers['if-range'] !== (await disk.stat(key)).etag) {
      range = undefined;
    }
    download = await disk.get(key, range ? { range } : {});
  } catch (error) {
    throw toHttpError(error, res);
  }

  // Express pipes the stream into the response and leaves it open when the client goes away
  // mid-download; destroying it releases the file handle or the connection to the store.
  onResponseClose(res, () => download.body.destroy());

  const etag = download.etag;
  if (etag && headers['if-none-match'] !== undefined && matchesEtag(headers['if-none-match'], etag)) {
    download.body.destroy();
    setStatus(res, HttpStatus.NOT_MODIFIED);
    setHeader(res, 'ETag', etag);
    return undefined;
  }

  const type = download.contentType;
  const safeInline = INLINE_SAFE.test(type);
  let disposition: string;
  if (signedDisposition !== undefined) {
    // Built by signedUrl() from a file name; only the inline/attachment choice is checked again.
    disposition = safeInline ? signedDisposition : signedDisposition.replace(/^inline\b/, 'attachment');
  } else {
    disposition = contentDisposition(
      options.disposition === 'inline' && safeInline ? 'inline' : 'attachment',
      options.filename ?? basename(key),
    );
  }

  setHeader(res, 'X-Content-Type-Options', 'nosniff');
  setHeader(res, 'Accept-Ranges', 'bytes');
  if (etag) {
    setHeader(res, 'ETag', etag);
  }
  setHeader(res, 'Last-Modified', download.lastModified.toUTCString());
  setHeader(res, 'Cache-Control', options.cacheControl ?? download.cacheControl ?? 'private');

  let length = download.size;
  if (download.range) {
    setStatus(res, HttpStatus.PARTIAL_CONTENT);
    setHeader(res, 'Content-Range', `bytes ${download.range.start}-${download.range.end}/${download.size}`);
    length = download.range.end - download.range.start + 1;
  }

  return new StreamableFile(download.body, { type, disposition, length });
}

export function verify(disk: StorageDisk, req: unknown, method: 'GET' | 'PUT') {
  // A disk whose signed URLs point elsewhere (S3) has nothing to serve here.
  if (!servesSignedUrls(disk)) {
    throw new NotFoundException();
  }

  const url = requestUrl(req);
  try {
    return disk.verifySignedUrl(url, method);
  } catch (error) {
    if (error instanceof StorageSignedUrlError) {
      throw new ForbiddenException(error.reason === 'expired' ? 'The signed URL has expired' : 'Invalid signed URL');
    }
    if (error instanceof StorageInvalidKeyError) {
      throw new ForbiddenException('Invalid signed URL');
    }
    throw error;
  }
}

/** The one place the HTTP helpers turn storage errors into responses. */
export function toHttpError(error: unknown, res?: unknown): unknown {
  if (error instanceof StorageFileNotFoundError || error instanceof StorageInvalidKeyError) {
    return new NotFoundException();
  }
  if (error instanceof StorageRangeNotSatisfiableError) {
    if (res && error.size !== undefined) {
      setHeader(res, 'Content-Range', `bytes */${error.size}`);
    }
    return new HttpException('Range Not Satisfiable', HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE);
  }
  return error;
}

/** `bytes=a-b`, `bytes=a-` or `bytes=-n`. Several ranges, or anything else, are ignored (the whole file). */
function parseRange(header: string | undefined): StorageRange | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? '');
  if (!match || (match[1] === '' && match[2] === '')) {
    return undefined;
  }
  if (match[1] === '') {
    return Number.isSafeInteger(Number(match[2])) ? { suffix: Number(match[2]) } : undefined;
  }

  const start = Number(match[1]);
  const end = match[2] === '' ? undefined : Number(match[2]);
  if (!Number.isSafeInteger(start) || (end !== undefined && (!Number.isSafeInteger(end) || end < start))) {
    return undefined;
  }

  return end === undefined ? { start } : { start, end };
}

function matchesEtag(header: string, etag: string): boolean {
  if (header.trim() === '*') {
    return true;
  }
  const weak = (value: string) => value.trim().replace(/^W\//, '');
  return header.split(',').some((candidate) => weak(candidate) === weak(etag));
}

export function requestHeaders(req: unknown): Record<string, string | undefined> {
  const headers = (req as { headers?: Record<string, unknown> } | undefined)?.headers ?? {};
  const result: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(headers)) {
    result[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : typeof value === 'string' ? value : undefined;
  }
  return result;
}

/** Express keeps the full URL in `originalUrl` (`url` loses a mount path); Fastify in `url`. */
export function requestUrl(req: unknown): string {
  const r = req as { originalUrl?: string; url?: string; raw?: { url?: string } } | undefined;
  return r?.originalUrl ?? r?.url ?? r?.raw?.url ?? '';
}

interface ResponseLike {
  code?: unknown;
  header?: (n: string, v: string) => void;
  setHeader?: (n: string, v: string) => void;
  /** Fastify's reply wraps the Node response. */
  raw?: unknown;
  once?: (event: string, listener: () => void) => unknown;
}

function isFastifyReply(r: ResponseLike): boolean {
  return typeof r.code === 'function' && typeof r.header === 'function';
}

export function assertResponse(res: unknown): asserts res is ResponseLike {
  const r = res as ResponseLike | undefined;
  if (!r || (!isFastifyReply(r) && typeof r.setHeader !== 'function')) {
    throw new TypeError('Pass the response as `res` (@Res({ passthrough: true })): an Express response or a Fastify reply');
  }
}

/** Fastify's reply has `code()` and `header()`; Express's response has `setHeader()`. */
export function setHeader(res: unknown, name: string, value: string): void {
  assertResponse(res);
  if (isFastifyReply(res)) {
    res.header!(name, value);
  } else {
    res.setHeader!(name, value);
  }
}

/** Runs `listener` once the Node response closes: after it ended, or when the client went away. */
function onResponseClose(res: unknown, listener: () => void): void {
  const r = res as ResponseLike;
  const raw = (isFastifyReply(r) ? r.raw : r) as ResponseLike | undefined;
  if (typeof raw?.once === 'function') {
    raw.once('close', listener);
  }
}

export function setStatus(res: unknown, status: number): void {
  const r = res as { status?: (s: number) => unknown; statusCode?: number };
  if (typeof r.status === 'function') {
    r.status(status);
  } else {
    r.statusCode = status;
  }
}
