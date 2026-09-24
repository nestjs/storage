import type { S3Credentials, S3DiskOptions } from '../interfaces/disk-options.interface.js';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { StorageError } from '../errors/storage.error.js';
import { StorageFileNotFoundError } from '../errors/storage-file-not-found.error.js';
import { StorageRangeNotSatisfiableError } from '../errors/storage-range-not-satisfiable.error.js';
import { StorageServiceError } from '../errors/storage-service.error.js';
import { assertValidKey, assertValidPrefix, encodeKeyPath, encodeRfc3986 } from '../utils/keys.util.js';
import { StorageDisk } from '../disks/storage.disk.js';
import type {
  StorageDownload,
  StorageFile,
  StorageListEntry,
  StorageListPage,
  StorageObjectWrite,
  StorageRange,
  StorageSignedUpload,
  StorageSignedUploadRequest,
  StorageWriteResult,
} from '../interfaces/storage-disk.interface.js';
import { duration, type ResolvedRetry, resolveRetry, sleep } from './retry.util.js';
import { EMPTY_SHA256, presignUrl, sha256Hex, signRequest } from './sigv4.util.js';
import { encodeXml, xmlElements, xmlText } from './xml.util.js';

const MiB = 1024 * 1024;
const MAX_PARTS = 10_000;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRYABLE_CODES = new Set(['SlowDown', 'InternalError', 'RequestTimeout', 'ServiceUnavailable', 'Throttling', 'ThrottlingException']);

interface RequestInit {
  operation: string;
  method: string;
  /** The full key (prefix included), or undefined for a bucket-level request. */
  key?: string;
  query?: [string, string][];
  headers?: Record<string, string>;
  body?: Buffer;
  /** Leave the body unread (GET): the timeout stops at the headers. */
  stream?: boolean;
  /** The disk key to name in a `StorageFileNotFoundError` for a 404. */
  notFoundKey?: string;
  signal?: AbortSignal;
}

/**
 * Amazon S3 and S3-compatible stores (Cloudflare R2, MinIO, Backblaze B2, Google Cloud
 * Storage's interoperability API), over `fetch` with Signature Version 4 on `node:crypto`.
 */
export class S3Disk extends StorageDisk {
  readonly bucket: string;
  readonly region: string;
  private readonly endpoint: URL;
  private readonly pathStyle: boolean;
  private readonly credentials: () => Promise<S3Credentials>;
  private readonly prefix: string;
  private readonly encryptionHeaders: Record<string, string>;
  private readonly partSize: number;
  private readonly concurrency: number;
  private readonly retry: ResolvedRetry;
  private readonly timeoutMs: number;
  private readonly batchDelete: boolean;
  private readonly fetchFn?: typeof globalThis.fetch;

  constructor(options: S3DiskOptions) {
    super(options);

    if (typeof options?.bucket !== 'string' || !/^[a-zA-Z0-9._-]{3,255}$/.test(options.bucket)) {
      throw new TypeError('S3Disk needs a `bucket` name (3 to 255 letters, digits, ".", "-" or "_")');
    }
    this.bucket = options.bucket;

    this.region = options.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1';
    if (!/^[a-z0-9-]+$/.test(this.region)) {
      throw new TypeError(`S3Disk \`region\`: "${this.region}" is not a region name`);
    }

    let endpoint: URL;
    try {
      endpoint = new URL(options.endpoint ?? `https://s3.${this.region}.amazonaws.com`);
    } catch {
      throw new TypeError('S3Disk `endpoint` must be an absolute http(s) URL, such as "https://<account>.r2.cloudflarestorage.com"');
    }
    if (!/^https?:$/.test(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || (endpoint.pathname !== '/' && endpoint.pathname !== '')) {
      throw new TypeError('S3Disk `endpoint` must be an absolute http(s) URL without a path, credentials or query');
    }
    this.endpoint = endpoint;

    const hostIsIp = isIP(endpoint.hostname.replace(/^\[|\]$/g, '')) !== 0;
    const dnsCompatible =
      /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(this.bucket) ||
      (endpoint.protocol === 'http:' && /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(this.bucket) && !this.bucket.includes('..'));
    this.pathStyle = options.forcePathStyle === true || hostIsIp || !dnsCompatible;

    this.credentials = resolveCredentials(options.credentials);

    const prefix = options.prefix ?? '';
    try {
      assertValidPrefix(prefix);
    } catch {
      throw new TypeError('S3Disk `prefix` must be a valid key prefix, such as "uploads/"');
    }
    this.prefix = prefix;

    this.encryptionHeaders = {};
    if (options.serverSideEncryption !== undefined) {
      if (!['AES256', 'aws:kms', 'aws:kms:dsse'].includes(options.serverSideEncryption)) {
        throw new TypeError('S3Disk `serverSideEncryption` must be "AES256", "aws:kms" or "aws:kms:dsse"');
      }
      this.encryptionHeaders['x-amz-server-side-encryption'] = options.serverSideEncryption;
    }
    if (options.kmsKeyId !== undefined) {
      if (!options.serverSideEncryption?.startsWith('aws:kms')) {
        throw new TypeError('S3Disk `kmsKeyId` needs `serverSideEncryption: "aws:kms"`');
      }
      this.encryptionHeaders['x-amz-server-side-encryption-aws-kms-key-id'] = options.kmsKeyId;
    }

    this.partSize = options.multipart?.partSize ?? 8 * MiB;
    if (!Number.isSafeInteger(this.partSize) || this.partSize < 5 * MiB || this.partSize > 5 * 1024 * MiB) {
      throw new TypeError('S3Disk `multipart.partSize` must be a number of bytes from 5 MiB to 5 GiB');
    }

    this.concurrency = options.multipart?.concurrency ?? 4;
    if (!Number.isInteger(this.concurrency) || this.concurrency < 1) {
      throw new TypeError('S3Disk `multipart.concurrency` must be a whole number of at least 1');
    }

    this.retry = resolveRetry(options.retry, 'S3Disk');
    this.timeoutMs = options.timeout === undefined ? 0 : duration(options.timeout, 'S3Disk `timeout`');
    this.batchDelete = options.batchDelete ?? true;
    this.fetchFn = options.fetch;
  }

  // --- writes --------------------------------------------------------------------------

  protected async writeObject(key: string, body: AsyncIterable<Buffer>, file: StorageObjectWrite): Promise<StorageWriteResult> {
    const fullKey = this.prefix + key;
    const headers = this.writeHeaders(file);
    const partSize =
      file.contentLength === undefined ? this.partSize : Math.max(this.partSize, Math.ceil(file.contentLength / MAX_PARTS));
    const parts = new PartReader(body[Symbol.asyncIterator](), partSize);

    try {
      const first = await parts.next();
      const second = first && first.length === partSize ? await parts.next() : undefined;

      if (!second) {
        const data = first ?? Buffer.alloc(0);
        const res = await this.send({
          operation: 'PutObject',
          method: 'PUT',
          key: fullKey,
          headers: { ...headers, 'content-length': String(data.length) },
          body: data,
          signal: file.signal,
        });
        return { key, size: data.length, contentType: file.contentType, etag: res.headers.get('etag') ?? undefined };
      }

      return await this.multipartUpload(key, fullKey, headers, [first!, second], parts, file);
    } catch (error) {
      await parts.release();
      throw error;
    }
  }

  private async multipartUpload(
    key: string,
    fullKey: string,
    headers: Record<string, string>,
    firstParts: Buffer[],
    parts: PartReader,
    file: StorageObjectWrite,
  ): Promise<StorageWriteResult> {
    const init = await this.send({
      operation: 'CreateMultipartUpload',
      method: 'POST',
      key: fullKey,
      query: [['uploads', '']],
      headers,
      signal: file.signal,
    });
    const uploadId = xmlText(await init.text(), 'UploadId');
    if (!uploadId) {
      throw new StorageServiceError({ operation: 'CreateMultipartUpload', code: 'InvalidResponse', message: 'no UploadId' });
    }

    const etags: string[] = [];
    const inFlight = new Set<Promise<void>>();
    let failure: { error: unknown } | undefined;
    let size = 0;
    let partNumber = 0;
    const upload = (data: Buffer) => {
      const number = ++partNumber;
      if (number > MAX_PARTS) {
        throw new StorageError(
          `The body needs more than ${MAX_PARTS} parts of ${this.partSize} bytes: pass \`contentLength\` to put(), or a larger \`multipart.partSize\``,
        );
      }

      size += data.length;
      const task = this.send({
        operation: 'UploadPart',
        method: 'PUT',
        key: fullKey,
        query: [['partNumber', String(number)], ['uploadId', uploadId]],
        headers: { 'content-length': String(data.length) },
        body: data,
        signal: file.signal,
      }).then(
        (res) => {
          const etag = res.headers.get('etag');
          if (!etag) {
            throw new StorageServiceError({ operation: 'UploadPart', code: 'InvalidResponse', message: 'no ETag' });
          }
          etags[number - 1] = etag;
        },
        (error) => {
          failure ??= { error };
        },
      );

      const tracked = task.finally(() => inFlight.delete(tracked));
      inFlight.add(tracked);
    };

    try {
      for (const data of firstParts) {
        upload(data);
      }

      for (;;) {
        while (inFlight.size >= this.concurrency && !failure) {
          await Promise.race(inFlight);
        }
        if (failure) {
          throw failure.error;
        }

        const data = await parts.next();
        if (!data) {
          break;
        }
        upload(data);
      }

      await Promise.all(inFlight);
      if (failure) {
        throw (failure as { error: unknown }).error;
      }

      const xml =
        '<CompleteMultipartUpload>' +
        etags.map((etag, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${encodeXml(etag)}</ETag></Part>`).join('') +
        '</CompleteMultipartUpload>';
      const res = await this.send({
        operation: 'CompleteMultipartUpload',
        method: 'POST',
        key: fullKey,
        query: [['uploadId', uploadId]],
        headers: { 'content-type': 'application/xml' },
        body: Buffer.from(xml),
        signal: file.signal,
      });

      // S3 answers 200 and may still report an error in the body.
      const result = await res.text();
      throwIfErrorDocument(result, 'CompleteMultipartUpload', res);

      return { key, size, contentType: file.contentType, etag: xmlText(result, 'ETag') };
    } catch (error) {
      await Promise.allSettled(inFlight);
      await this.send({
        operation: 'AbortMultipartUpload',
        method: 'DELETE',
        key: fullKey,
        query: [['uploadId', uploadId]],
      }).catch(() => undefined); // best effort: a lifecycle rule cleans up what this misses
      throw error;
    }
  }

  protected async copyObject(from: string, to: string): Promise<StorageWriteResult> {
    const source = `/${this.bucket}/${encodeKeyPath(this.prefix + from)}`;
    const res = await this.send({
      operation: 'CopyObject',
      method: 'PUT',
      key: this.prefix + to,
      headers: { 'x-amz-copy-source': source, 'x-amz-metadata-directive': 'COPY', ...this.encryptionHeaders },
      notFoundKey: from,
    });
    const result = await res.text();
    throwIfErrorDocument(result, 'CopyObject', res);

    const file = await this.headObject(to);
    return { key: to, size: file.size, contentType: file.contentType, etag: file.etag };
  }

  protected async deleteObjects(keys: string[]): Promise<void> {
    if (!this.batchDelete || keys.length === 1) {
      for (const key of keys) {
        await this.send({ operation: 'DeleteObject', method: 'DELETE', key: this.prefix + key });
      }
      return;
    }

    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000);
      const xml = Buffer.from(
        '<Delete><Quiet>true</Quiet>' +
          batch.map((key) => `<Object><Key>${encodeXml(this.prefix + key)}</Key></Object>`).join('') +
          '</Delete>',
      );

      const res = await this.send({
        operation: 'DeleteObjects',
        method: 'POST',
        query: [['delete', '']],
        headers: {
          'content-type': 'application/xml',
          'content-md5': createHash('md5').update(xml).digest('base64'),
        },
        body: xml,
      });

      const result = await res.text();
      const errors = xmlElements(result, 'Error');
      if (errors.length > 0) {
        const code = xmlText(errors[0], 'Code') ?? 'Error';
        throw new StorageServiceError({
          operation: 'DeleteObjects',
          code,
          message: `${errors.length} of ${batch.length} keys were not deleted`,
          upstreamStatus: res.status,
        });
      }
    }
  }

  // --- reads ---------------------------------------------------------------------------

  protected async readObject(key: string, range: StorageRange | undefined): Promise<StorageDownload> {
    const headers: Record<string, string> = {};
    if (range) {
      headers.range = 'suffix' in range ? `bytes=-${range.suffix}` : `bytes=${range.start}-${range.end ?? ''}`;
    }
    if (range && 'suffix' in range && range.suffix === 0) {
      throw new StorageRangeNotSatisfiableError(key, undefined);
    }

    const res = await this.send({ operation: 'GetObject', method: 'GET', key: this.prefix + key, headers, stream: true, notFoundKey: key });
    const file = fileFromHeaders(key, res.headers);
    const body = res.body ? Readable.fromWeb(res.body as import('node:stream/web').ReadableStream) : Readable.from([]);

    // fetch decodes a gzip/br/deflate body on the way, so the bytes would no longer match
    // `size` (a download would be cut short); the object can't be streamed as it is stored.
    const encoding = res.headers.get('content-encoding');
    if (encoding && encoding.toLowerCase() !== 'identity') {
      body.destroy();
      throw new StorageError(
        `"${key}" is stored with Content-Encoding: ${encoding}, which this disk can't stream as stored ` +
          '(fetch decodes it on the way). Store the object without a Content-Encoding, or read it with a client that leaves the body encoded.',
      );
    }

    const contentRange = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(res.headers.get('content-range') ?? '');
    if (res.status === 206 && contentRange) {
      return {
        ...file,
        size: Number(contentRange[3]),
        range: { start: Number(contentRange[1]), end: Number(contentRange[2]) },
        body,
      };
    }
    return { ...file, body };
  }

  protected async headObject(key: string): Promise<StorageFile> {
    const res = await this.send({ operation: 'HeadObject', method: 'HEAD', key: this.prefix + key, notFoundKey: key });
    return fileFromHeaders(key, res.headers);
  }

  protected async listObjects(options: { prefix: string; cursor?: string; limit: number }): Promise<StorageListPage> {
    const query: [string, string][] = [
      ['list-type', '2'],
      ['max-keys', String(options.limit)],
    ];
    const prefix = this.prefix + options.prefix;
    if (prefix) {
      query.push(['prefix', prefix]);
    }
    if (options.cursor) {
      query.push(['continuation-token', options.cursor]);
    }

    const res = await this.send({ operation: 'ListObjectsV2', method: 'GET', query });
    const xml = await res.text();

    const entries: StorageListEntry[] = [];
    for (const item of xmlElements(xml, 'Contents')) {
      const fullKey = xmlText(item, 'Key') ?? '';
      if (!fullKey.startsWith(this.prefix)) {
        continue;
      }
      const key = fullKey.slice(this.prefix.length);

      // Objects other tools wrote under names no disk accepts ("folder/" markers, "a//b") are skipped.
      try {
        assertValidKey(key);
      } catch {
        continue;
      }

      entries.push({
        key,
        size: Number(xmlText(item, 'Size') ?? 0),
        lastModified: new Date(xmlText(item, 'LastModified') ?? 0),
        etag: xmlText(item, 'ETag'),
      });
    }

    const truncated = xmlText(xml, 'IsTruncated') === 'true';
    return { entries, cursor: truncated ? xmlText(xml, 'NextContinuationToken') : undefined };
  }

  // --- signing -------------------------------------------------------------------------

  protected override async presignGet(key: string, expiresAt: Date, contentDisposition: string | undefined): Promise<string> {
    const url = this.objectUrl(this.prefix + key, contentDisposition ? [['response-content-disposition', contentDisposition]] : []);
    return presignUrl({
      method: 'GET',
      url,
      expiresInSeconds: secondsUntil(expiresAt),
      credentials: await this.credentials(),
      region: this.region,
    }).toString();
  }

  protected override async presignPut(key: string, expiresAt: Date, request: StorageSignedUploadRequest): Promise<StorageSignedUpload> {
    const headers: Record<string, string> = { 'content-type': request.contentType, ...this.encryptionHeaders };
    if (request.contentLength !== undefined) {
      headers['content-length'] = String(request.contentLength);
    }

    const url = presignUrl({
      method: 'PUT',
      url: this.objectUrl(this.prefix + key, []),
      headers,
      expiresInSeconds: secondsUntil(expiresAt),
      credentials: await this.credentials(),
      region: this.region,
    });
    return { url: url.toString(), method: 'PUT', headers, expiresAt };
  }

  // --- transport -----------------------------------------------------------------------

  private writeHeaders(file: StorageObjectWrite): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': file.contentType, ...this.encryptionHeaders };
    if (file.cacheControl !== undefined) {
      headers['cache-control'] = file.cacheControl;
    }
    if (file.contentDisposition !== undefined) {
      headers['content-disposition'] = file.contentDisposition;
    }
    for (const [name, value] of Object.entries(file.metadata)) {
      headers[`x-amz-meta-${name}`] = value;
    }

    return headers;
  }

  private objectUrl(fullKey: string | undefined, query: [string, string][]): URL {
    const path = fullKey === undefined ? '' : encodeKeyPath(fullKey);
    const search = query.length
      ? '?' + query.map(([name, value]) => (value === '' && isFlag(name) ? encodeRfc3986(name) : `${encodeRfc3986(name)}=${encodeRfc3986(value)}`)).join('&')
      : '';
    const origin = `${this.endpoint.protocol}//${this.pathStyle ? this.endpoint.host : `${this.bucket}.${this.endpoint.host}`}`;
    return new URL(`${origin}/${this.pathStyle ? `${this.bucket}/${path}` : path}${search}`);
  }

  /** One request, signed and retried. Resolves with a 2xx response; throws the mapped error otherwise. */
  private async send(init: RequestInit): Promise<Response> {
    const url = this.objectUrl(init.key, init.query ?? []);
    const payloadHash = init.body ? sha256Hex(init.body) : EMPTY_SHA256;

    for (let attempt = 1; ; attempt++) {
      let error: unknown;
      try {
        return await this.attempt(init, url, payloadHash);
      } catch (caught) {
        error = caught;
      }

      if (attempt >= this.retry.attempts || !isRetryable(error) || init.signal?.aborted) {
        throw error;
      }
      if (this.retry.retryIf && !this.retry.retryIf(error, attempt)) {
        throw error;
      }

      await sleep(this.retry.delay(attempt, error), init.signal);
    }
  }

  private async attempt(init: RequestInit, url: URL, payloadHash: string): Promise<Response> {
    const headers = signRequest({
      method: init.method,
      url,
      headers: { ...init.headers, 'x-amz-content-sha256': payloadHash },
      payloadHash,
      credentials: await this.credentials(),
      region: this.region,
    });

    const controller = new AbortController();
    const timer = this.timeoutMs > 0 ? setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), this.timeoutMs) : undefined;
    const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;

    try {
      let res: Response;
      try {
        res = await (this.fetchFn ?? globalThis.fetch)(url, { method: init.method, headers, body: init.body as RequestInit['body'], signal, redirect: 'manual' });
      } catch (error) {
        throw this.transportError(init, error);
      }

      if (res.ok) {
        if (!init.stream && init.method !== 'HEAD') {
          // Read under the timeout, and hand back a response whose body is already in memory.
          const data = await res.arrayBuffer().catch((error) => {
            throw this.transportError(init, error);
          });
          return new Response(res.status === 204 ? null : data, { status: res.status, headers: res.headers });
        }
        return res;
      }

      const text = init.method === 'HEAD' ? '' : await res.text().catch(() => '');
      throw this.responseError(init, res, text);
    } finally {
      clearTimeout(timer);
    }
  }

  private transportError(init: RequestInit, error: unknown): unknown {
    if (init.signal?.aborted) {
      return init.signal.reason;
    }

    const name = (error as Error)?.name;
    if (name === 'TimeoutError' || (name === 'AbortError' && (error as { cause?: Error })?.cause?.name === 'TimeoutError')) {
      return new StorageServiceError({ operation: init.operation, code: 'Timeout', message: `no response within ${this.timeoutMs}ms`, cause: error });
    }
    const cause = (error as { cause?: { code?: string } })?.cause;
    return new StorageServiceError({ operation: init.operation, code: 'NetworkError', message: cause?.code ?? (error as Error)?.message, cause: error });
  }

  private responseError(init: RequestInit, res: Response, text: string): Error {
    const code = xmlText(text, 'Code') ?? statusCode(res.status);
    const requestId = xmlText(text, 'RequestId') ?? res.headers.get('x-amz-request-id') ?? undefined;

    if (res.status === 404 && init.notFoundKey !== undefined && (code === 'NoSuchKey' || code === 'NotFound')) {
      return new StorageFileNotFoundError(init.notFoundKey);
    }
    if (res.status === 416 && init.notFoundKey !== undefined) {
      const size = xmlText(text, 'ActualObjectSize') ?? /\/(\d+)$/.exec(res.headers.get('content-range') ?? '')?.[1];
      return new StorageRangeNotSatisfiableError(init.notFoundKey, size === undefined ? undefined : Number(size));
    }
    return new StorageServiceError({
      operation: init.operation,
      code,
      message: xmlText(text, 'Message'),
      upstreamStatus: res.status,
      requestId,
    });
  }
}

/** Reads a stream of chunks as parts of exactly `size` bytes (the last may be shorter). */
class PartReader {
  private buffered: Buffer[] = [];
  private length = 0;
  private done = false;

  constructor(
    private readonly source: AsyncIterator<Buffer>,
    private readonly size: number,
  ) {}

  async next(): Promise<Buffer | undefined> {
    while (!this.done && this.length < this.size) {
      const { value, done } = await this.source.next();
      if (done) {
        this.done = true;
      } else if (value.length > 0) {
        this.buffered.push(value);
        this.length += value.length;
      }
    }

    if (this.length === 0) {
      return undefined;
    }

    const all = this.buffered.length === 1 ? this.buffered[0] : Buffer.concat(this.buffered);
    const part = all.subarray(0, this.size);
    const rest = all.subarray(this.size);
    this.buffered = rest.length ? [rest] : [];
    this.length = rest.length;

    // Copy so a part doesn't pin a larger buffer it was sliced from
    return part.length === all.length ? part : Buffer.from(part);
  }

  /** Stops reading the source, when the upload fails before it ended. */
  async release(): Promise<void> {
    if (!this.done) {
      this.done = true;
      await this.source.return?.().catch(() => undefined);
    }
  }
}

function fileFromHeaders(key: string, headers: Headers): StorageFile {
  const metadata: Record<string, string> = {};
  headers.forEach((value, name) => {
    if (name.startsWith('x-amz-meta-')) {
      metadata[name.slice('x-amz-meta-'.length)] = value;
    }
  });

  return {
    key,
    size: Number(headers.get('content-length') ?? 0),
    contentType: headers.get('content-type') ?? 'application/octet-stream',
    lastModified: new Date(headers.get('last-modified') ?? 0),
    etag: headers.get('etag') ?? undefined,
    cacheControl: headers.get('cache-control') ?? undefined,
    contentDisposition: headers.get('content-disposition') ?? undefined,
    metadata,
  };
}

function throwIfErrorDocument(xml: string, operation: string, res: Response) {
  if (/^\s*(<\?xml[^>]*>\s*)?<Error>/.test(xml)) {
    const code = xmlText(xml, 'Code') ?? 'Error';
    throw new StorageServiceError({
      operation,
      code,
      message: xmlText(xml, 'Message'),
      upstreamStatus: res.status,
      requestId: xmlText(xml, 'RequestId'),
    });
  }
}

function isRetryable(error: unknown): boolean {
  if (!(error instanceof StorageServiceError)) {
    return false;
  }
  if (error.code === 'NetworkError' || error.code === 'Timeout') {
    return true;
  }
  return RETRYABLE_CODES.has(error.code) || (error.upstreamStatus !== undefined && RETRYABLE_STATUS.has(error.upstreamStatus));
}

function statusCode(status: number): string {
  return status === 404 ? 'NotFound' : status === 403 ? 'Forbidden' : status === 301 || status === 307 ? 'WrongRegionOrEndpoint' : `Http${status}`;
}

/** Subresource flags such as `?uploads` and `?delete` are sent without `=`. */
function isFlag(name: string): boolean {
  return name === 'uploads' || name === 'delete';
}

function secondsUntil(date: Date): number {
  return Math.max(1, Math.round((date.getTime() - Date.now()) / 1000));
}

function resolveCredentials(input: S3DiskOptions['credentials']): () => Promise<S3Credentials> {
  if (typeof input === 'function') {
    return async () => {
      const credentials = await input();
      assertCredentials(credentials, 'the `credentials` function returned');
      return credentials;
    };
  }

  const credentials =
    input ??
    (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
      ? {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
          sessionToken: process.env.AWS_SESSION_TOKEN || undefined,
        }
      : undefined);
  if (!credentials) {
    throw new TypeError(
      'S3Disk needs credentials: pass `credentials: { accessKeyId, secretAccessKey }` (or a function ' +
        'returning them), or set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY',
    );
  }

  assertCredentials(credentials, 'S3Disk `credentials`');
  return async () => credentials;
}

function assertCredentials(value: S3Credentials, where: string) {
  if (!value || typeof value.accessKeyId !== 'string' || !value.accessKeyId || typeof value.secretAccessKey !== 'string' || !value.secretAccessKey) {
    throw new TypeError(`${where} must have a non-empty \`accessKeyId\` and \`secretAccessKey\``);
  }
}
