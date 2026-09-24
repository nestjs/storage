import type { StorageDiskOptions } from '../interfaces/disk-options.interface.js';
import type {
  StorageBody,
  StorageDownload,
  StorageFile,
  StorageGetOptions,
  StorageListEntry,
  StorageListOptions,
  StorageListPage,
  StorageObjectWrite,
  StoragePutOptions,
  StorageRange,
  StorageSignedUpload,
  StorageSignedUploadRequest,
  StorageSignedUrlRequest,
  StorageWriteResult,
} from '../interfaces/storage-disk.interface.js';
import { abortable, checkLength, knownLength, readAll, toChunks } from '../utils/body.util.js';
import { contentTypeFromKey } from '../utils/content-type.util.js';
import { toMs } from '../utils/duration.util.js';
import type { Duration } from '../interfaces/duration.interface.js';
import { StorageError } from '../errors/storage.error.js';
import { StorageFileNotFoundError } from '../errors/storage-file-not-found.error.js';
import { assertValidKey, assertValidPrefix, basename, encodeKeyPath } from '../utils/keys.util.js';
import { type SignedUrlQuery, UrlSigner } from '../utils/url-signer.util.js';
import type { StorageSignedUrlClaims } from '../interfaces/storage-signed-url.interface.js';

const MAX_SIGNED_MS = 7 * 24 * 3_600_000;
const DEFAULT_SIGNED_MS = 15 * 60_000;
const MAX_METADATA_BYTES = 2048;
const HEADER_VALUE = /^[\x20-\x7e]*$/;
const METADATA_NAME = /^[a-z0-9][a-z0-9_-]*$/i;

/**
 * A place files live: a local directory, a bucket, memory. The abstract class is the
 * contract, and the injection token of the default disk (`@InjectDisk(name)` for the others).
 *
 * The public methods are implemented here: they validate keys (one rule for every disk, so
 * a key that works in development works in production), normalize bodies and options, and
 * then call the protected `*Object` methods a disk implements. A custom disk (Azure Blob,
 * GCS's JSON API) extends this class, implements those, and gets the rest.
 */
export abstract class StorageDisk {
  private readonly publicBase?: URL;
  private readonly signer?: UrlSigner;

  protected constructor(options: StorageDiskOptions = {}) {
    const owner = new.target.name;

    if (options.publicUrl !== undefined) {
      let url: URL | undefined;
      try {
        url = new URL(options.publicUrl);
      } catch {
        url = undefined;
      }
      if (!url || !/^https?:$/.test(url.protocol) || url.search || url.hash) {
        throw new TypeError(`${owner} \`publicUrl\` must be an absolute http(s) URL without a query`);
      }
      this.publicBase = url;
    }

    if (options.signedUrls !== undefined) {
      this.signer = new UrlSigner(options.signedUrls, owner);
    }
  }

  // ---------------------------------------------------------------------------------------
  // What a disk implements. Keys and options arrive validated.

  /** Writes the whole body, then makes it visible at `key` at once, replacing any file there. */
  protected abstract writeObject(key: string, body: AsyncIterable<Buffer>, file: StorageObjectWrite): Promise<StorageWriteResult>;
  /** Throws `StorageFileNotFoundError`, or `StorageRangeNotSatisfiableError` for a range past the end. */
  protected abstract readObject(key: string, range: StorageRange | undefined): Promise<StorageDownload>;
  /** Throws `StorageFileNotFoundError`. */
  protected abstract headObject(key: string): Promise<StorageFile>;
  /** Deletes the keys that exist; missing keys are not an error. */
  protected abstract deleteObjects(keys: string[]): Promise<void>;
  protected abstract listObjects(options: { prefix: string; cursor?: string; limit: number }): Promise<StorageListPage>;
  /** Copies content and metadata. Throws `StorageFileNotFoundError` for a missing source. */
  protected abstract copyObject(from: string, to: string): Promise<StorageWriteResult>;

  /** Default: copy, then delete the source. A disk that can rename atomically overrides it. */
  protected async moveObject(from: string, to: string): Promise<StorageWriteResult> {
    const result = await this.copyObject(from, to);
    await this.deleteObjects([from]);
    return result;
  }

  /** A disk that presigns natively (S3) overrides these two; the others use `signedUrls`. */
  protected async presignGet(key: string, expiresAt: Date, contentDisposition: string | undefined): Promise<string> {
    return this.requireSigner('signedUrl').sign({ key, method: 'GET', expiresAt, contentDisposition });
  }

  protected async presignPut(
    key: string,
    expiresAt: Date,
    request: StorageSignedUploadRequest,
  ): Promise<StorageSignedUpload> {
    const url = this.requireSigner('signedUpload').sign({
      key,
      method: 'PUT',
      expiresAt,
      contentType: request.contentType,
      contentLength: request.contentLength,
    });
    return { url, method: 'PUT', headers: { 'content-type': request.contentType }, expiresAt };
  }

  /** Optional. Releases what the disk opened itself. Called on application shutdown. */
  close?(): Promise<void>;

  // ---------------------------------------------------------------------------------------
  // The API

  /** Stores `body` at `key`, replacing what was there. Readers see the old file or the new one, never a partial one. */
  async put(key: string, body: StorageBody, options: StoragePutOptions = {}): Promise<StorageWriteResult> {
    assertValidKey(key);
    const file = normalizePut(key, body, options);
    const chunks = abortable(checkLength(toChunks(body), file.contentLength), options.signal);
    return this.writeObject(key, chunks, file);
  }

  /** The file's body as a stream, and its metadata. Throws `StorageFileNotFoundError`. */
  async get(key: string, options: StorageGetOptions = {}): Promise<StorageDownload> {
    assertValidKey(key);
    return this.readObject(key, options.range === undefined ? undefined : normalizeRange(options.range));
  }

  async getBuffer(key: string): Promise<Buffer> {
    const { body } = await this.get(key);
    return readAll(body);
  }

  async getText(key: string): Promise<string> {
    return (await this.getBuffer(key)).toString('utf8');
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.stat(key);
      return true;
    } catch (error) {
      if (error instanceof StorageFileNotFoundError) {
        return false;
      }
      throw error;
    }
  }

  /** Throws `StorageFileNotFoundError`. */
  async stat(key: string): Promise<StorageFile> {
    assertValidKey(key);
    return this.headObject(key);
  }

  /** Deletes one key or several. Deleting a missing key is not an error. */
  async delete(keys: string | readonly string[]): Promise<void> {
    const list = typeof keys === 'string' ? [keys] : [...keys];
    list.forEach((key) => assertValidKey(key));
    if (list.length > 0) {
      await this.deleteObjects([...new Set(list)]);
    }
  }

  /** One page of files, in key order. */
  async list(options: StorageListOptions = {}): Promise<StorageListPage> {
    const prefix = options.prefix ?? '';
    assertValidPrefix(prefix);

    const limit = options.limit ?? 1000;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new TypeError('list(): `limit` must be a whole number from 1 to 1000');
    }
    if (options.cursor !== undefined && (typeof options.cursor !== 'string' || options.cursor === '')) {
      throw new TypeError('list(): `cursor` must be the cursor of a previous page');
    }

    return this.listObjects({ prefix, cursor: options.cursor, limit });
  }

  /** Every file under `prefix`, page by page. */
  async *listAll(options: Omit<StorageListOptions, 'cursor'> = {}): AsyncIterable<StorageListEntry> {
    let cursor: string | undefined;
    do {
      const page = await this.list({ ...options, cursor });
      yield* page.entries;
      cursor = page.cursor;
    } while (cursor);
  }

  /** Copies content and metadata within this disk. Throws `StorageFileNotFoundError`. */
  async copy(from: string, to: string): Promise<StorageWriteResult> {
    assertValidKey(from);
    assertValidKey(to);
    if (from === to) {
      return this.touchResult(from);
    }
    return this.copyObject(from, to);
  }

  /** Moves within this disk. Atomic on a local disk; a copy and a delete on S3. */
  async move(from: string, to: string): Promise<StorageWriteResult> {
    assertValidKey(from);
    assertValidKey(to);
    if (from === to) {
      return this.touchResult(from);
    }
    return this.moveObject(from, to);
  }

  /** The public URL of `key` under `publicUrl`. The file must be publicly readable there. */
  url(key: string): string {
    assertValidKey(key);
    if (!this.publicBase) {
      throw new StorageError(
        `${this.constructor.name} has no \`publicUrl\`, so url() can't build a public URL. ` +
          'Configure one, or use signedUrl() for files that are not public.',
      );
    }

    const base = this.publicBase.href.endsWith('/') ? this.publicBase.href : `${this.publicBase.href}/`;
    return base + encodeKeyPath(key);
  }

  /** A time-limited download link for a private file. */
  async signedUrl(key: string, options: StorageSignedUrlRequest = {}): Promise<string> {
    assertValidKey(key);
    const expiresAt = expiry(options.expiresIn);
    let disposition: string | undefined;
    if (options.filename !== undefined || options.disposition !== undefined) {
      disposition = contentDisposition(options.disposition ?? 'attachment', options.filename);
    }
    return this.presignGet(key, expiresAt, disposition);
  }

  /** A time-limited upload URL: the client `PUT`s the file straight to the disk. */
  async signedUpload(key: string, options: StorageSignedUploadRequest): Promise<StorageSignedUpload> {
    assertValidKey(key);
    assertHeaderValue('contentType', options?.contentType, true);
    const length = options.contentLength;
    if (length !== undefined && (!Number.isSafeInteger(length) || length < 0)) {
      throw new TypeError('signedUpload(): `contentLength` must be a whole number of bytes');
    }
    return this.presignPut(key, expiry(options.expiresIn), options);
  }

  /**
   * Checks an app-served signed URL (the full request URL, or its query) and returns what it
   * grants. Throws `StorageSignedUrlError` (status 403). `serveSignedUrl()` and
   * `receiveSignedUpload()` call it for you.
   */
  verifySignedUrl(url: SignedUrlQuery, method: 'GET' | 'PUT' = 'GET'): StorageSignedUrlClaims {
    const claims = this.requireSigner('verifySignedUrl').verify(url, method);
    assertValidKey(claims.key);
    return claims;
  }

  private requireSigner(method: string): UrlSigner {
    if (!this.signer) {
      throw new StorageError(
        `${this.constructor.name} has no \`signedUrls\` option, so ${method}() can't be used. ` +
          'Pass signedUrls: { baseUrl, keys } with the URL of the route that serves this disk.',
      );
    }
    return this.signer;
  }

  private async touchResult(key: string): Promise<StorageWriteResult> {
    const file = await this.headObject(key);
    return { key, size: file.size, contentType: file.contentType, etag: file.etag };
  }
}

/** Whether a disk signs its URLs for the app to serve (internal, for the HTTP helpers). */
export function servesSignedUrls(disk: StorageDisk): boolean {
  return (disk as unknown as { signer?: unknown }).signer !== undefined;
}

function normalizePut(key: string, body: StorageBody, options: StoragePutOptions): StorageObjectWrite {
  if (options.contentType !== undefined) {
    assertHeaderValue('contentType', options.contentType, true);
  }
  if (options.cacheControl !== undefined) {
    assertHeaderValue('cacheControl', options.cacheControl);
  }
  if (options.contentDisposition !== undefined) {
    assertHeaderValue('contentDisposition', options.contentDisposition);
  }
  const metadata = normalizeMetadata(options.metadata);

  const inMemory = knownLength(body);
  let contentLength = options.contentLength;
  if (contentLength !== undefined && (!Number.isSafeInteger(contentLength) || contentLength < 0)) {
    throw new TypeError('put(): `contentLength` must be a whole number of bytes');
  }
  contentLength ??= inMemory;

  return {
    contentType: options.contentType ?? contentTypeFromKey(key),
    cacheControl: options.cacheControl,
    contentDisposition: options.contentDisposition,
    metadata,
    contentLength,
    explicitContentType: options.contentType !== undefined,
    signal: options.signal,
  };
}

function normalizeMetadata(metadata: Record<string, string> | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  let bytes = 0;

  for (const [name, value] of Object.entries(metadata ?? {})) {
    if (!METADATA_NAME.test(name)) {
      throw new TypeError(`put(): metadata name "${name}" may only contain letters, digits, "-" and "_"`);
    }
    if (typeof value !== 'string' || !HEADER_VALUE.test(value)) {
      throw new TypeError(`put(): metadata "${name}" must be a string of printable ASCII characters`);
    }
    const lower = name.toLowerCase();
    if (lower in result) {
      throw new TypeError(`put(): metadata "${name}" is set twice (names are case-insensitive)`);
    }
    result[lower] = value;
    bytes += lower.length + value.length;
  }

  if (bytes > MAX_METADATA_BYTES) {
    throw new TypeError(`put(): metadata can't exceed ${MAX_METADATA_BYTES} bytes (names and values)`);
  }

  return result;
}

/** Values that end up in HTTP headers: printable ASCII only, so no header injection. */
function assertHeaderValue(option: string, value: unknown, required = false) {
  if (typeof value !== 'string' || !HEADER_VALUE.test(value) || (required && value.trim() === '')) {
    throw new TypeError(`\`${option}\` must be a non-empty string of printable ASCII characters`);
  }
}

function normalizeRange(range: StorageRange): StorageRange {
  const whole = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  if ('suffix' in range) {
    if (!whole(range.suffix)) {
      throw new TypeError('get(): `range.suffix` must be a whole number of bytes');
    }
    return { suffix: range.suffix };
  }

  if (!whole(range.start) || (range.end !== undefined && !whole(range.end))) {
    throw new TypeError('get(): `range.start` and `range.end` must be whole numbers of bytes');
  }
  if (range.end !== undefined && range.end < range.start) {
    throw new TypeError('get(): `range.end` must not be before `range.start`');
  }

  return range.end === undefined ? { start: range.start } : { start: range.start, end: range.end };
}

/**
 * Resolves a range against a file size, the way S3 does: `end` is clamped to the last byte,
 * a suffix longer than the file is the whole file, and a start at or past the end (or a
 * zero-length suffix, or any range on an empty file) is unsatisfiable (`undefined`).
 */
export function resolveRange(range: StorageRange, size: number): { start: number; end: number } | undefined {
  if (size === 0) {
    return undefined;
  }

  if ('suffix' in range) {
    if (range.suffix === 0) {
      return undefined;
    }
    return { start: Math.max(0, size - range.suffix), end: size - 1 };
  }

  if (range.start >= size) {
    return undefined;
  }

  return { start: range.start, end: Math.min(range.end ?? size - 1, size - 1) };
}

function expiry(expiresIn: Duration | undefined): Date {
  let ms: number;
  try {
    ms = expiresIn === undefined ? DEFAULT_SIGNED_MS : toMs(expiresIn);
  } catch (error) {
    throw new TypeError(`\`expiresIn\`: ${(error as Error).message}`);
  }

  if (ms < 1000 || ms > MAX_SIGNED_MS) {
    throw new TypeError('`expiresIn` must be between 1 second and 7 days');
  }
  return new Date(Date.now() + ms);
}

/**
 * `attachment; filename="..."; filename*=UTF-8''...`: an ASCII fallback for old clients and the
 * exact name for the rest (RFC 6266). Quotes, backslashes and control characters can't break out.
 */
export function contentDisposition(type: 'attachment' | 'inline', filename?: string): string {
  if (filename === undefined) {
    return type;
  }
  if (typeof filename !== 'string' || filename === '') {
    throw new TypeError('`filename` must be a non-empty string');
  }

  const name = basename(filename.replace(/\\/g, '/')) || 'download';
  const fallback = name.replace(/[^\x20-\x7e]|["\\%]/g, '_');
  const exact = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

  return fallback === name
    ? `${type}; filename="${name}"`
    : `${type}; filename="${fallback}"; filename*=UTF-8''${exact}`;
}
