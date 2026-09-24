/**
 * A fake S3 on node:http, implementing the subset S3Disk uses, and verifying every request's
 * signature with its own SigV4 code (written separately from the package's signer, from the
 * AWS documentation): the canonical request is rebuilt from the raw request line and headers
 * as they arrived, so what was sent over the wire must be what was signed. Payload hashes are
 * checked against the body, presigned URLs against their expiry and signed headers, and
 * DeleteObjects against its Content-MD5.
 */
import { createHash, createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export const ACCESS_KEY = 'AKIAFAKEFAKEFAKE0001';
export const SECRET_KEY = 'fake/secret+key/0123456789abcdefghijklmnop';

interface StoredObject {
  data: Buffer;
  contentType: string;
  cacheControl?: string;
  contentDisposition?: string;
  /** Set by tests: S3Disk never stores one. */
  contentEncoding?: string;
  metadata: Record<string, string>;
  encryption?: string;
  kmsKeyId?: string;
  etag: string;
  lastModified: Date;
}

interface Upload {
  bucket: string;
  key: string;
  parts: Map<number, { data: Buffer; etag: string }>;
  template: Omit<StoredObject, 'data' | 'etag' | 'lastModified'>;
}

export interface LoggedRequest {
  method: string;
  bucket: string;
  key: string;
  query: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
  bodyLength: number;
  style: 'virtual' | 'path';
  auth: 'header' | 'query';
}

interface Fault {
  match: (req: LoggedRequest) => boolean;
  status: number;
  code: string;
  times: number;
  /** Close the socket instead of answering. */
  reset?: boolean;
  delayMs?: number;
}

export class FakeS3 {
  readonly objects = new Map<string, StoredObject>();
  readonly uploads = new Map<string, Upload>();
  readonly buckets = new Set<string>(['acme']);
  readonly requests: LoggedRequest[] = [];
  readonly signatureFailures: string[] = [];
  private faults: Fault[] = [];
  private server!: Server;
  private nextUpload = 1;
  sessionToken?: string;
  port = 0;

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        if (!res.headersSent) {
          this.error(res, 500, 'InternalError', String(error));
        } else {
          res.destroy();
        }
      });
    });

    await new Promise<void>((resolve) => this.server.listen(0, '::', resolve));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }

  async stop() {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Path-style endpoint (an IP address, so S3Disk picks path style on its own). */
  get ipEndpoint() {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Endpoint for virtual-hosted requests: `<bucket>.localhost` resolves to the loopback. */
  get hostEndpoint() {
    return `http://localhost:${this.port}`;
  }

  fail(match: (req: LoggedRequest) => boolean, fault: Omit<Fault, 'match'>) {
    this.faults.push({ match, ...fault });
  }

  reset() {
    this.objects.clear();
    this.uploads.clear();
    this.requests.length = 0;
    this.signatureFailures.length = 0;
    this.faults = [];
    this.sessionToken = undefined;
  }

  object(key: string, bucket = 'acme') {
    return this.objects.get(`${bucket}/${key}`);
  }

  // --- dispatch ------------------------------------------------------------------------

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    const body = Buffer.concat(chunks);

    const rawUrl = req.url ?? '/';
    const [rawPath, rawQuery = ''] = splitOnce(rawUrl, '?');
    const query = parseQuery(rawQuery);

    const host = String(req.headers.host ?? '');
    const hostname = host.replace(/:\d+$/, '');
    let bucket: string;
    let keyPath: string;
    let style: 'virtual' | 'path';
    if (hostname.endsWith('.localhost')) {
      style = 'virtual';
      bucket = hostname.slice(0, -'.localhost'.length);
      keyPath = rawPath.slice(1);
    } else {
      style = 'path';
      const [first, rest = ''] = splitOnce(rawPath.slice(1), '/');
      bucket = decodeURIComponent(first);
      keyPath = rest;
    }

    const key = keyPath.split('/').map(decodeURIComponent).join('/');
    const logged: LoggedRequest = {
      method: req.method!,
      bucket,
      key,
      query: Object.fromEntries(query),
      headers: req.headers,
      bodyLength: body.length,
      style,
      auth: query.some(([name]) => name === 'X-Amz-Signature') ? 'query' : 'header',
    };
    this.requests.push(logged);

    const denied = this.verify(req, rawPath, query, body);
    if (denied) {
      this.signatureFailures.push(denied);
      return this.error(res, 403, 'SignatureDoesNotMatch', denied);
    }

    const fault = this.faults.find((f) => f.times > 0 && f.match(logged));
    if (fault) {
      fault.times--;
      if (fault.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, fault.delayMs));
      }
      if (fault.reset) {
        return req.socket.destroy();
      }
      if (fault.status) {
        return this.error(res, fault.status, fault.code, 'injected');
      }
    }

    if (!this.buckets.has(bucket)) {
      return this.error(res, 404, 'NoSuchBucket', 'The specified bucket does not exist');
    }

    const q = logged.query;
    const method = req.method!;
    if (key === '') {
      if (method === 'GET' && q['list-type'] === '2') {
        return this.list(res, bucket, q);
      }
      if (method === 'POST' && 'delete' in q) {
        return this.deleteMany(req, res, bucket, body);
      }
      return this.error(res, 400, 'NotImplemented', `${method} on a bucket`);
    }

    if (method === 'POST' && 'uploads' in q) {
      return this.createUpload(req, res, bucket, key);
    }
    if (method === 'PUT' && q.uploadId) {
      return this.uploadPart(res, q, body);
    }
    if (method === 'POST' && q.uploadId) {
      return this.complete(res, bucket, key, q.uploadId, body);
    }
    if (method === 'DELETE' && q.uploadId) {
      this.uploads.delete(q.uploadId);
      res.writeHead(204).end();
      return;
    }
    if (method === 'PUT' && req.headers['x-amz-copy-source']) {
      return this.copy(req, res, bucket, key);
    }
    if (method === 'PUT') {
      return this.put(req, res, bucket, key, body);
    }
    if (method === 'GET' || method === 'HEAD') {
      return this.get(req, res, bucket, key);
    }
    if (method === 'DELETE') {
      this.objects.delete(`${bucket}/${key}`);
      res.writeHead(204).end();
      return;
    }
    return this.error(res, 405, 'MethodNotAllowed', method);
  }

  // --- signature verification -------------------------------------------------------------

  /** Returns why the request is refused, or undefined. */
  private verify(req: IncomingMessage, rawPath: string, query: [string, string][], body: Buffer): string | undefined {
    const now = Date.now();
    const presigned = query.find(([name]) => name === 'X-Amz-Signature');
    let credential: string;
    let signedHeaders: string[];
    let given: string;
    let date: string;
    let payloadHash: string;
    let canonicalQueryPairs = query;

    if (presigned) {
      const param = (name: string) => query.find(([n]) => n === name)?.[1];
      if (param('X-Amz-Algorithm') !== 'AWS4-HMAC-SHA256') {
        return 'bad algorithm';
      }

      credential = param('X-Amz-Credential') ?? '';
      signedHeaders = (param('X-Amz-SignedHeaders') ?? '').split(';');
      given = presigned[1];
      date = param('X-Amz-Date') ?? '';
      const expires = Number(param('X-Amz-Expires'));
      if (!(expires >= 1 && expires <= 604800)) {
        return 'bad expires';
      }
      if (now > parseAmzDate(date) + expires * 1000) {
        return 'expired';
      }
      if (this.sessionToken && param('X-Amz-Security-Token') !== this.sessionToken) {
        return 'bad session token';
      }

      payloadHash = 'UNSIGNED-PAYLOAD';
      canonicalQueryPairs = query.filter(([name]) => name !== 'X-Amz-Signature');
    } else {
      const match = /^AWS4-HMAC-SHA256 Credential=([^,]+), SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(
        String(req.headers.authorization ?? ''),
      );
      if (!match) {
        return 'no authorization';
      }

      [, credential, , given] = match;
      signedHeaders = match[2].split(';');
      date = String(req.headers['x-amz-date'] ?? '');
      if (Math.abs(now - parseAmzDate(date)) > 15 * 60_000) {
        return 'clock skew';
      }
      payloadHash = String(req.headers['x-amz-content-sha256'] ?? '');
      if (payloadHash !== 'UNSIGNED-PAYLOAD' && payloadHash !== createHash('sha256').update(body).digest('hex')) {
        return 'payload hash mismatch';
      }

      for (const required of ['host', 'x-amz-date', 'x-amz-content-sha256']) {
        if (!signedHeaders.includes(required)) {
          return `${required} not signed`;
        }
      }
      if (this.sessionToken && req.headers['x-amz-security-token'] !== this.sessionToken) {
        return 'bad session token';
      }
      if (req.headers['x-amz-security-token'] && !signedHeaders.includes('x-amz-security-token')) {
        return 'token not signed';
      }
    }

    const [accessKey, day, region, service, terminal] = credential.split('/');
    if (accessKey !== ACCESS_KEY) {
      return 'unknown access key';
    }
    if (service !== 's3' || terminal !== 'aws4_request' || day !== date.slice(0, 8)) {
      return 'bad scope';
    }

    // Every x-amz-* header sent must be signed (S3's rule), and every signed one present.
    for (const name of Object.keys(req.headers)) {
      if (name.startsWith('x-amz-') && !presigned && !signedHeaders.includes(name)) {
        return `${name} sent unsigned`;
      }
    }

    const headerLines: string[] = [];
    for (const name of [...signedHeaders].sort()) {
      const values = req.headersDistinct[name];
      if (!values) {
        return `signed header ${name} missing`;
      }
      headerLines.push(`${name}:${values.map((v) => v.trim().replace(/\s+/g, ' ')).join(',')}`);
    }

    const canonicalQuery = canonicalQueryPairs
      .map(([n, v]) => [awsEncode(n), awsEncode(v)])
      .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : 1))
      .map(([n, v]) => `${n}=${v}`)
      .join('&');
    const canonicalRequest = [
      req.method,
      rawPath,
      canonicalQuery,
      headerLines.join('\n') + '\n',
      [...signedHeaders].sort().join(';'),
      payloadHash,
    ].join('\n');

    const scope = `${day}/${region}/s3/aws4_request`;
    const toSign = ['AWS4-HMAC-SHA256', date, scope, createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');
    let key: Buffer = createHmac('sha256', `AWS4${SECRET_KEY}`).update(day).digest();
    for (const part of [region, 's3', 'aws4_request']) {
      key = createHmac('sha256', key).update(part).digest();
    }

    const expected = createHmac('sha256', key).update(toSign).digest('hex');
    return expected === given ? undefined : `signature mismatch for\n${canonicalRequest}`;
  }

  // --- operations --------------------------------------------------------------------------

  private template(req: IncomingMessage): Upload['template'] {
    const metadata: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (name.startsWith('x-amz-meta-')) {
        metadata[name.slice(11)] = String(value);
      }
    }

    return {
      contentType: String(req.headers['content-type'] ?? 'binary/octet-stream'),
      cacheControl: req.headers['cache-control'] as string | undefined,
      contentDisposition: req.headers['content-disposition'] as string | undefined,
      metadata,
      encryption: req.headers['x-amz-server-side-encryption'] as string | undefined,
      kmsKeyId: req.headers['x-amz-server-side-encryption-aws-kms-key-id'] as string | undefined,
    };
  }

  private put(req: IncomingMessage, res: ServerResponse, bucket: string, key: string, body: Buffer) {
    if (req.headers['content-length'] === undefined) {
      return this.error(res, 411, 'MissingContentLength', 'length required');
    }

    const etag = `"${md5(body)}"`;
    this.objects.set(`${bucket}/${key}`, { ...this.template(req), data: body, etag, lastModified: new Date() });
    res.writeHead(200, { etag }).end();
  }

  private get(req: IncomingMessage, res: ServerResponse, bucket: string, key: string) {
    const object = this.objects.get(`${bucket}/${key}`);
    if (!object) {
      if (req.method === 'HEAD') {
        return res.writeHead(404).end();
      }
      return this.error(res, 404, 'NoSuchKey', 'The specified key does not exist.');
    }

    const headers: Record<string, string> = {
      'content-type': object.contentType,
      etag: object.etag,
      'last-modified': object.lastModified.toUTCString(),
      'accept-ranges': 'bytes',
    };

    if (object.cacheControl) {
      headers['cache-control'] = object.cacheControl;
    }
    if (object.contentDisposition) {
      headers['content-disposition'] = object.contentDisposition;
    }
    if (object.contentEncoding) {
      headers['content-encoding'] = object.contentEncoding;
    }
    if (object.encryption) {
      headers['x-amz-server-side-encryption'] = object.encryption;
    }
    for (const [name, value] of Object.entries(object.metadata)) {
      headers[`x-amz-meta-${name}`] = value;
    }

    const url = new URL(req.url!, 'http://x');
    const override = url.searchParams.get('response-content-disposition');
    if (override) {
      headers['content-disposition'] = override;
    }

    const size = object.data.length;
    const range = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (range && req.method === 'GET') {
      let start: number;
      let end: number;
      if (range[1] === '') {
        const suffix = Number(range[2]);
        start = Math.max(0, size - suffix);
        end = size - 1;
        if (suffix === 0 || size === 0) {
          return this.error(res, 416, 'InvalidRange', 'bad range', { ActualObjectSize: String(size) });
        }
      } else {
        start = Number(range[1]);
        end = range[2] === '' ? size - 1 : Math.min(Number(range[2]), size - 1);
        if (start >= size) {
          return this.error(res, 416, 'InvalidRange', 'bad range', { ActualObjectSize: String(size) });
        }
      }

      const slice = object.data.subarray(start, end + 1);
      res.writeHead(206, { ...headers, 'content-length': String(slice.length), 'content-range': `bytes ${start}-${end}/${size}` });
      return res.end(slice);
    }

    res.writeHead(200, { ...headers, 'content-length': String(size) });
    res.end(req.method === 'HEAD' ? undefined : object.data);
  }

  private copy(req: IncomingMessage, res: ServerResponse, bucket: string, key: string) {
    const source = decodeURIComponent(String(req.headers['x-amz-copy-source'])).replace(/^\//, '');
    const object = this.objects.get(source);
    if (!object) {
      return this.error(res, 404, 'NoSuchKey', 'The specified key does not exist.');
    }

    const copy = { ...object, metadata: { ...object.metadata }, lastModified: new Date() };
    if (req.headers['x-amz-server-side-encryption']) {
      copy.encryption = String(req.headers['x-amz-server-side-encryption']);
    }

    this.objects.set(`${bucket}/${key}`, copy);
    this.xml(res, 200, `<CopyObjectResult><ETag>${escape(copy.etag)}</ETag><LastModified>${copy.lastModified.toISOString()}</LastModified></CopyObjectResult>`);
  }

  private list(res: ServerResponse, bucket: string, q: Record<string, string>) {
    const prefix = q.prefix ?? '';
    const max = Math.min(Number(q['max-keys'] ?? 1000), 1000);
    const after = q['continuation-token'] ? Buffer.from(q['continuation-token'], 'base64').toString() : undefined;

    const keys = [...this.objects.keys()]
      .filter((k) => k.startsWith(`${bucket}/`))
      .map((k) => k.slice(bucket.length + 1))
      .filter((k) => k.startsWith(prefix) && (after === undefined || Buffer.compare(Buffer.from(k), Buffer.from(after)) > 0))
      .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    const page = keys.slice(0, max);
    const truncated = keys.length > page.length;

    const contents = page
      .map((k) => {
        const o = this.objects.get(`${bucket}/${k}`)!;
        return `<Contents><Key>${escape(k)}</Key><LastModified>${o.lastModified.toISOString()}</LastModified><ETag>${escape(o.etag)}</ETag><Size>${o.data.length}</Size><StorageClass>STANDARD</StorageClass></Contents>`;
      })
      .join('');

    const token = truncated ? `<NextContinuationToken>${Buffer.from(page.at(-1)!).toString('base64')}</NextContinuationToken>` : '';
    this.xml(
      res,
      200,
      `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${bucket}</Name><Prefix>${escape(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${max}</MaxKeys><IsTruncated>${truncated}</IsTruncated>${contents}${token}</ListBucketResult>`,
    );
  }

  private deleteMany(req: IncomingMessage, res: ServerResponse, bucket: string, body: Buffer) {
    if (req.headers['content-md5'] !== createHash('md5').update(body).digest('base64')) {
      return this.error(res, 400, 'InvalidDigest', 'Content-MD5 mismatch');
    }

    const keys = [...body.toString().matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map((m) => unescape(m[1]));
    const errors: string[] = [];

    for (const key of keys) {
      const fault = this.faults.find((f) => f.times > 0 && f.code === 'AccessDenied' && f.match({ key } as LoggedRequest));
      if (fault) {
        fault.times--;
        errors.push(`<Error><Key>${escape(key)}</Key><Code>AccessDenied</Code><Message>Access Denied</Message></Error>`);
        continue;
      }
      this.objects.delete(`${bucket}/${key}`);
    }

    this.xml(res, 200, `<DeleteResult>${errors.join('')}</DeleteResult>`);
  }

  private createUpload(req: IncomingMessage, res: ServerResponse, bucket: string, key: string) {
    const id = `upload-${this.nextUpload++}`;
    this.uploads.set(id, { bucket, key, parts: new Map(), template: this.template(req) });
    this.xml(res, 200, `<InitiateMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${escape(key)}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
  }

  private uploadPart(res: ServerResponse, q: Record<string, string>, body: Buffer) {
    const upload = this.uploads.get(q.uploadId);
    if (!upload) {
      return this.error(res, 404, 'NoSuchUpload', 'no such upload');
    }

    const etag = `"${md5(body)}"`;
    upload.parts.set(Number(q.partNumber), { data: body, etag });
    res.writeHead(200, { etag }).end();
  }

  private complete(res: ServerResponse, bucket: string, key: string, id: string, body: Buffer) {
    const upload = this.uploads.get(id);
    if (!upload) {
      return this.error(res, 404, 'NoSuchUpload', 'no such upload');
    }

    const listed = [...body.toString().matchAll(/<Part><PartNumber>(\d+)<\/PartNumber><ETag>([\s\S]*?)<\/ETag><\/Part>/g)].map(
      (m) => ({ number: Number(m[1]), etag: unescape(m[2]) }),
    );

    const faultIndex = this.faults.findIndex((f) => f.times > 0 && f.code === 'CompleteError');
    if (faultIndex !== -1) {
      this.faults[faultIndex].times--;
      // S3 can answer 200 and report the failure in the body
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.write(' ');
      return res.end('<Error><Code>InternalError</Code><Message>We encountered an internal error.</Message></Error>');
    }

    const datas: Buffer[] = [];
    for (const [index, part] of listed.entries()) {
      const stored = upload.parts.get(part.number);
      if (!stored || stored.etag !== part.etag || part.number !== index + 1) {
        return this.error(res, 400, 'InvalidPart', 'bad part');
      }
      if (index < listed.length - 1 && stored.data.length < 5 * 1024 * 1024) {
        return this.error(res, 400, 'EntityTooSmall', 'part too small');
      }
      datas.push(stored.data);
    }

    const data = Buffer.concat(datas);
    const etag = `"${md5(Buffer.concat(listed.map((p) => Buffer.from(p.etag.replace(/"/g, ''), 'hex'))))}-${listed.length}"`;
    this.objects.set(`${bucket}/${key}`, { ...upload.template, data, etag, lastModified: new Date() });
    this.uploads.delete(id);
    this.xml(res, 200, `<CompleteMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${escape(key)}</Key><ETag>${escape(etag)}</ETag></CompleteMultipartUploadResult>`);
  }

  private xml(res: ServerResponse, status: number, body: string) {
    res.writeHead(status, { 'content-type': 'application/xml' }).end(`<?xml version="1.0" encoding="UTF-8"?>\n${body}`);
  }

  private error(res: ServerResponse, status: number, code: string, message: string, extra: Record<string, string> = {}) {
    const fields = Object.entries(extra).map(([k, v]) => `<${k}>${v}</${k}>`).join('');
    this.xml(res, status, `<Error><Code>${code}</Code><Message>${escape(message)}</Message>${fields}<RequestId>req-${this.requests.length}</RequestId></Error>`);
  }
}

function md5(data: Buffer) {
  return createHash('md5').update(data).digest('hex');
}

function splitOnce(value: string, separator: string): [string, string?] {
  const index = value.indexOf(separator);
  return index === -1 ? [value] : [value.slice(0, index), value.slice(index + 1)];
}

/** Query pairs as S3 reads them: `%XX` decoded, a pair without `=` has an empty value. */
function parseQuery(raw: string): [string, string][] {
  if (!raw) {
    return [];
  }
  return raw.split('&').map((pair) => {
    const [name, value = ''] = splitOnce(pair, '=');
    return [decodeURIComponent(name), decodeURIComponent(value)];
  });
}

/** RFC 3986 unreserved characters kept, everything else %XX (uppercase), per the SigV4 docs. */
function awsEncode(value: string) {
  return [...Buffer.from(value, 'utf8')]
    .map((byte) => {
      const c = String.fromCharCode(byte);
      return /[A-Za-z0-9\-._~]/.test(c) ? c : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    })
    .join('');
}

function parseAmzDate(value: string) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : NaN;
}

function escape(text: string) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function unescape(text: string) {
  return text.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
