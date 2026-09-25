/**
 * `S3Disk` against scripted responses (its `fetch` option): what it sends for each operation,
 * and how it maps what a store answers (error documents, bare statuses, headers, listings,
 * multipart replies) onto the package's errors and results. The fake S3 in fake-s3.ts covers
 * the happy paths and signatures end to end; these are the answers it never gives.
 */
import { createHash } from 'node:crypto';
import {
  S3Disk,
  type S3DiskOptions,
  StorageFileNotFoundError,
  StorageRangeNotSatisfiableError,
  StorageServiceError,
} from '../lib/index.js';

const MiB = 1024 * 1024;
const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');
const credentials = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret/example+key' };

interface Call {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body?: Buffer;
  init: RequestInit;
}

type Respond = (call: Call, index: number) => Response | Promise<Response>;

function scripted(respond: Respond) {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const call: Call = {
      method: init.method ?? 'GET',
      url: new URL(String(input)),
      headers: { ...(init.headers as Record<string, string>) },
      body: init.body as Buffer | undefined,
      init,
    };
    calls.push(call);
    return respond(call, calls.length - 1);
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

const xml = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(`<?xml version="1.0" encoding="UTF-8"?>${body}`, { status, headers: { 'content-type': 'application/xml', ...headers } });
const s3Error = (status: number, code: string, extra = '') =>
  xml(`<Error><Code>${code}</Code><Message>Scripted ${code}</Message>${extra}</Error>`, status);
// A byte body, so the Response doesn't add a text/plain Content-Type of its own
const ok = (headers: Record<string, string> = {}, body?: string) => new Response(body === undefined ? null : Buffer.from(body), { status: 200, headers });

const disk = (respond: Respond, options: Partial<S3DiskOptions> = {}) => {
  const { calls, fetch } = scripted(respond);
  const instance = new S3Disk({
    bucket: 'shop',
    region: 'eu-central-1',
    endpoint: 'http://127.0.0.1:9000',
    credentials,
    retry: false,
    fetch,
    ...options,
  });
  return { disk: instance, calls };
};

const errorOf = (promise: Promise<unknown>) => promise.then(() => undefined, (error: unknown) => error);

describe('S3Disk error mapping', () => {
  it('a 404 NoSuchKey is a missing file, named by its disk key rather than its bucket key', async () => {
    const { disk: s3, calls } = disk(() => s3Error(404, 'NoSuchKey'), { prefix: 'tenants/t1/' });

    const error = await errorOf(s3.getText('docs/a.txt'));

    expect(error).toBeInstanceOf(StorageFileNotFoundError);
    expect(error).toMatchObject({ key: 'docs/a.txt' });
    expect(calls[0].url.pathname).toBe('/shop/tenants/t1/docs/a.txt');
  });

  it('a HEAD 404 has no body: it is still a missing file, and exists() answers false', async () => {
    const { disk: s3, calls } = disk(() => new Response(null, { status: 404 }));

    await expect(s3.stat('a.txt')).rejects.toBeInstanceOf(StorageFileNotFoundError);
    expect(await s3.exists('a.txt')).toBe(false);
    expect(calls.map((c) => c.method)).toEqual(['HEAD', 'HEAD']);
  });

  it('a HEAD 403 is a service error, so exists() rejects instead of answering false', async () => {
    const { disk: s3 } = disk(() => new Response(null, { status: 403, headers: { 'x-amz-request-id': 'REQ-403' } }));

    const error = await errorOf(s3.exists('a.txt'));

    expect(error).toBeInstanceOf(StorageServiceError);
    expect(error).toMatchObject({ operation: 'HeadObject', code: 'Forbidden', upstreamStatus: 403, requestId: 'REQ-403' });
  });

  it('a 404 for something other than the key (a missing bucket) is a service error', async () => {
    const { disk: s3 } = disk(() => s3Error(404, 'NoSuchBucket', '<RequestId>R1</RequestId>'));
    const error = await errorOf(s3.getText('a.txt'));

    expect(error).not.toBeInstanceOf(StorageFileNotFoundError);
    expect(error).toMatchObject({ code: 'NoSuchBucket', requestId: 'R1', message: 'GetObject failed: NoSuchBucket (404): Scripted NoSuchBucket' });
  });

  it.each([
    [301, 'WrongRegionOrEndpoint'],
    [307, 'WrongRegionOrEndpoint'],
    [400, 'Http400'],
    [418, 'Http418'],
  ])('a bare %i without an error document is %s, and redirects are not followed', async (status, code) => {
    const { disk: s3, calls } = disk(() => new Response('', { status, headers: status >= 300 && status < 400 ? { location: 'https://elsewhere' } : {} }));

    await expect(s3.put('a.txt', 'x')).rejects.toMatchObject({ operation: 'PutObject', code, upstreamStatus: status });
    expect(calls).toHaveLength(1);
    expect(calls[0].init.redirect).toBe('manual');
  });

  it('prefers the request id of the error document over the header', async () => {
    const { disk: s3 } = disk(() =>
      xml('<Error><Code>AccessDenied</Code><RequestId>FROM-BODY</RequestId></Error>', 403, { 'x-amz-request-id': 'FROM-HEADER' }),
    );
    await expect(s3.getText('a')).rejects.toMatchObject({ requestId: 'FROM-BODY' });
  });

  describe('416 on a ranged read', () => {
    it.each([
      ['the size in the error document', () => s3Error(416, 'InvalidRange', '<ActualObjectSize>12</ActualObjectSize>'), 12],
      ['the size in Content-Range', () => new Response('', { status: 416, headers: { 'content-range': 'bytes */12' } }), 12],
      ['no size at all', () => new Response('', { status: 416 }), undefined],
    ])('with %s', async (_label, respond, size) => {
      const { disk: s3 } = disk(respond);
      const error = await errorOf(s3.get('r.bin', { range: { start: 50 } }));

      expect(error).toBeInstanceOf(StorageRangeNotSatisfiableError);
      expect(error).toMatchObject({ key: 'r.bin', size });
    });
  });
});

describe('S3Disk retries by error code', () => {
  const retry = { attempts: 2, backoff: { delay: 0, jitter: 'none' as const } };

  it.each(['RequestTimeout', 'ServiceUnavailable', 'Throttling', 'ThrottlingException', 'SlowDown', 'InternalError'])(
    'retries %s even with a status that is not retryable by itself',
    async (code) => {
      const { disk: s3, calls } = disk((_call, index) => (index === 0 ? s3Error(400, code) : ok({}, 'x')), { retry });
      expect(await s3.getText('a')).toBe('x');
      expect(calls).toHaveLength(2);
    },
  );

  it.each([
    [400, 'BadDigest'],
    [403, 'SignatureDoesNotMatch'],
    [409, 'OperationAborted'],
  ])('does not retry %i %s', async (status, code) => {
    const { disk: s3, calls } = disk(() => s3Error(status, code), { retry });
    await expect(s3.put('a', 'x')).rejects.toMatchObject({ code });
    expect(calls).toHaveLength(1);
  });

  it('retries a connection error, and names its cause', async () => {
    const refused = new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
    const { disk: s3, calls } = disk(() => Promise.reject(refused), { retry });

    const error = await errorOf(s3.stat('a'));

    expect(error).toBeInstanceOf(StorageServiceError);
    expect(error).toMatchObject({ operation: 'HeadObject', code: 'NetworkError', message: 'HeadObject failed: NetworkError: ECONNREFUSED', cause: refused });
    expect(calls).toHaveLength(2);
  });

  it("a caller's abort during a request propagates unchanged and is not retried", async () => {
    const controller = new AbortController();
    const reason = new Error('client went away');
    const { disk: s3, calls } = disk(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          call.init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
          controller.abort(reason);
        }),
      { retry: { attempts: 3, backoff: { delay: 0 } } },
    );

    await expect(s3.put('a.txt', 'x', { signal: controller.signal })).rejects.toBe(reason);
    expect(calls).toHaveLength(1);
  });
});

describe('S3Disk requests', () => {
  it('stores an empty body with one signed PutObject', async () => {
    const { disk: s3, calls } = disk(() => ok({ etag: '"d41d8cd98f00b204e9800998ecf8427e"' }));

    const result = await s3.put('empty.txt', '');

    expect(result).toEqual({ key: 'empty.txt', size: 0, contentType: 'text/plain; charset=utf-8', etag: '"d41d8cd98f00b204e9800998ecf8427e"' });
    expect(calls[0].method).toBe('PUT');
    expect(calls[0].headers).toMatchObject({
      'content-length': '0',
      'content-type': 'text/plain; charset=utf-8',
      'x-amz-content-sha256': EMPTY_SHA256,
      'x-amz-date': expect.stringMatching(/^\d{8}T\d{6}Z$/),
      authorization: expect.stringMatching(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-central-1\/s3\/aws4_request, SignedHeaders=/),
    });
    expect(calls[0].headers).not.toHaveProperty('host');
  });

  it('sends metadata, cache control and disposition as headers', async () => {
    const { disk: s3, calls } = disk(() => ok());
    await s3.put('a.bin', 'x', { metadata: { Owner: 'u1' }, cacheControl: 'no-store', contentDisposition: 'inline' });

    expect(calls[0].headers).toMatchObject({ 'x-amz-meta-owner': 'u1', 'cache-control': 'no-store', 'content-disposition': 'inline' });
  });

  it('reads a file from the response headers', async () => {
    const { disk: s3 } = disk(() =>
      ok({ 'content-length': '7', 'x-amz-meta-owner': 'u1', 'x-amz-meta-source': 'scan', 'content-encoding': 'identity', etag: '"e"' }, 'payload'),
    );

    const download = await s3.get('a.bin');
    expect(download).toMatchObject({
      key: 'a.bin',
      size: 7,
      contentType: 'application/octet-stream',
      lastModified: new Date(0),
      etag: '"e"',
      metadata: { owner: 'u1', source: 'scan' },
    });
    expect(download.cacheControl).toBeUndefined();
    download.body.destroy();
  });

  it.each([
    [{ start: 2 }, 'bytes=2-'],
    [{ start: 1, end: 4 }, 'bytes=1-4'],
    [{ suffix: 3 }, 'bytes=-3'],
  ])('asks for range %o as "%s", and reads the size from Content-Range', async (range, header) => {
    const { disk: s3, calls } = disk(() => new Response('abc', { status: 206, headers: { 'content-range': 'bytes 7-9/10', 'content-length': '3' } }));

    const download = await s3.get('r.bin', { range });
    download.body.destroy();

    expect(calls[0].headers.range).toBe(header);
    expect(download).toMatchObject({ size: 10, range: { start: 7, end: 9 } });
  });

  it('a zero-byte suffix is not satisfiable, without a request', async () => {
    const { disk: s3, calls } = disk(() => ok());
    await expect(s3.get('r.bin', { range: { suffix: 0 } })).rejects.toBeInstanceOf(StorageRangeNotSatisfiableError);
    expect(calls).toEqual([]);
  });

  it('copies within the bucket with the source encoded and prefixed, then reads the new object', async () => {
    const { disk: s3, calls } = disk((call) =>
      call.method === 'PUT' ? xml('<CopyObjectResult><ETag>"c"</ETag></CopyObjectResult>') : ok({ 'content-length': '3', 'content-type': 'text/csv', etag: '"c"' }),
    { prefix: 'p/', serverSideEncryption: 'AES256' });

    const result = await s3.copy('src dir/ż.csv', 'dst/b.csv');

    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual(['PUT /shop/p/dst/b.csv', 'HEAD /shop/p/dst/b.csv']);
    expect(calls[0].headers).toMatchObject({
      'x-amz-copy-source': '/shop/p/src%20dir/%C5%BC.csv',
      'x-amz-metadata-directive': 'COPY',
      'x-amz-server-side-encryption': 'AES256',
    });
    expect(result).toEqual({ key: 'dst/b.csv', size: 3, contentType: 'text/csv', etag: '"c"' });
  });

  it('a copy that answers 200 with an error document fails, and a missing source is not found', async () => {
    const failed = disk(() => xml('<Error><Code>InternalError</Code><Message>Try again</Message><RequestId>R9</RequestId></Error>'));
    const error = await errorOf(failed.disk.copy('a', 'b'));
    expect(error).toMatchObject({ name: 'StorageServiceError', operation: 'CopyObject', code: 'InternalError', upstreamStatus: 200, requestId: 'R9' });
    expect(failed.calls).toHaveLength(1);

    const missing = disk(() => s3Error(404, 'NoSuchKey'));
    await expect(missing.disk.copy('from.txt', 'to.txt')).rejects.toMatchObject({ name: 'StorageFileNotFoundError', key: 'from.txt' });
  });

  it('deletes a single key with DeleteObject, even with batchDelete on', async () => {
    const { disk: s3, calls } = disk(() => new Response(null, { status: 204 }));
    await s3.delete(['only.txt', 'only.txt']);
    expect(calls.map((c) => `${c.method} ${c.url.pathname}${c.url.search}`)).toEqual(['DELETE /shop/only.txt']);
  });

  it('deletes several keys in one quiet DeleteObjects with escaped, prefixed keys and a matching Content-MD5', async () => {
    const { disk: s3, calls } = disk(() => xml('<DeleteResult></DeleteResult>'), { prefix: 'p/' });
    await s3.delete(['a&b.txt', '<c>.txt']);

    expect(calls).toHaveLength(1);
    expect(`${calls[0].method} ${calls[0].url.pathname}${calls[0].url.search}`).toBe('POST /shop/?delete');
    const body = calls[0].body!.toString();
    expect(body).toBe('<Delete><Quiet>true</Quiet><Object><Key>p/a&amp;b.txt</Key></Object><Object><Key>p/&lt;c&gt;.txt</Key></Object></Delete>');
    expect(calls[0].headers['content-md5']).toBe(createHash('md5').update(body).digest('base64'));
  });

  it('lists a page with the disk prefix, and continues with the store token', async () => {
    const page = (token?: string) =>
      xml(
        '<ListBucketResult>' +
          '<Contents><Key>p/docs/a&amp;1.txt</Key><Size>12</Size><LastModified>2026-01-02T03:04:05.000Z</LastModified><ETag>&quot;e1&quot;</ETag></Contents>' +
          '<Contents><Key>elsewhere/x.txt</Key><Size>1</Size></Contents>' +
          '<Contents><Key>p/docs/</Key><Size>0</Size></Contents>' +
          `<IsTruncated>${token ? 'true' : 'false'}</IsTruncated>${token ? `<NextContinuationToken>${token}</NextContinuationToken>` : ''}` +
          '</ListBucketResult>',
      );
    const { disk: s3, calls } = disk((_call, index) => page(index === 0 ? 'next&amp;1' : undefined), { prefix: 'p/' });

    const first = await s3.list({ prefix: 'docs/', limit: 2 });
    expect(first).toEqual({
      entries: [{ key: 'docs/a&1.txt', size: 12, lastModified: new Date('2026-01-02T03:04:05.000Z'), etag: '"e1"' }],
      cursor: 'next&1',
    });
    expect(Object.fromEntries(calls[0].url.searchParams)).toEqual({ 'list-type': '2', 'max-keys': '2', prefix: 'p/docs/' });

    const second = await s3.list({ prefix: 'docs/', cursor: first.cursor });
    expect(second.cursor).toBeUndefined();
    expect(calls[1].url.searchParams.get('continuation-token')).toBe('next&1');
  });

  it('lists the whole bucket without a prefix parameter', async () => {
    const { disk: s3, calls } = disk(() => xml('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>'));
    expect(await s3.list()).toEqual({ entries: [], cursor: undefined });
    expect(calls[0].url.searchParams.has('prefix')).toBe(false);
    expect(calls[0].url.pathname).toBe('/shop/');
  });
});

describe('S3Disk multipart uploads', () => {
  const partSize = 5 * MiB;
  const body = () => Buffer.alloc(11 * MiB, 7);

  it('completes with every part in order, ETags escaped, and encryption only on the create request', async () => {
    const { disk: s3, calls } = disk(
      (call) => {
        if (call.url.searchParams.has('uploads')) {
          return xml('<InitiateMultipartUploadResult><UploadId>up-1</UploadId></InitiateMultipartUploadResult>');
        }
        if (call.url.searchParams.has('partNumber')) {
          return ok({ etag: `"etag-${call.url.searchParams.get('partNumber')}"` });
        }
        return xml('<CompleteMultipartUploadResult><ETag>&quot;final-3&quot;</ETag></CompleteMultipartUploadResult>');
      },
      { multipart: { partSize }, serverSideEncryption: 'aws:kms', kmsKeyId: 'key-1' },
    );

    const result = await s3.put('big.bin', body(), { metadata: { v: '1' } });

    const create = calls[0];
    const parts = calls.filter((c) => c.url.searchParams.has('partNumber'));
    const complete = calls.at(-1)!;

    expect(create.headers).toMatchObject({ 'x-amz-server-side-encryption': 'aws:kms', 'x-amz-server-side-encryption-aws-kms-key-id': 'key-1', 'x-amz-meta-v': '1' });
    expect(parts.map((c) => [c.url.searchParams.get('partNumber'), c.url.searchParams.get('uploadId'), c.body!.length])).toEqual([
      ['1', 'up-1', partSize],
      ['2', 'up-1', partSize],
      ['3', 'up-1', MiB],
    ]);
    for (const part of parts) {
      expect(part.headers).not.toHaveProperty('x-amz-server-side-encryption');
      expect(part.headers).not.toHaveProperty('x-amz-meta-v');
    }
    expect(complete.body!.toString()).toBe(
      '<CompleteMultipartUpload>' +
        '<Part><PartNumber>1</PartNumber><ETag>&quot;etag-1&quot;</ETag></Part>' +
        '<Part><PartNumber>2</PartNumber><ETag>&quot;etag-2&quot;</ETag></Part>' +
        '<Part><PartNumber>3</PartNumber><ETag>&quot;etag-3&quot;</ETag></Part>' +
        '</CompleteMultipartUpload>',
    );
    expect(result).toEqual({ key: 'big.bin', size: 11 * MiB, contentType: 'application/octet-stream', etag: '"final-3"' });
  });

  it('fails without an UploadId, and has nothing to abort', async () => {
    const { disk: s3, calls } = disk(() => xml('<InitiateMultipartUploadResult></InitiateMultipartUploadResult>'), { multipart: { partSize } });

    await expect(s3.put('big.bin', body())).rejects.toMatchObject({ operation: 'CreateMultipartUpload', code: 'InvalidResponse' });
    expect(calls.map((c) => c.method)).toEqual(['POST']);
  });

  it('fails a part answered without an ETag, and aborts the upload', async () => {
    const { disk: s3, calls } = disk(
      (call) => {
        if (call.url.searchParams.has('uploads')) {
          return xml('<InitiateMultipartUploadResult><UploadId>up-2</UploadId></InitiateMultipartUploadResult>');
        }
        return call.method === 'DELETE' ? new Response(null, { status: 204 }) : ok();
      },
      { multipart: { partSize } },
    );

    await expect(s3.put('big.bin', body())).rejects.toMatchObject({ operation: 'UploadPart', code: 'InvalidResponse', message: 'UploadPart failed: InvalidResponse: no ETag' });
    const abort = calls.at(-1)!;
    expect(`${abort.method} ${abort.url.pathname}?${abort.url.searchParams}`).toBe('DELETE /shop/big.bin?uploadId=up-2');
  });

  it('an abort that fails too still reports the original failure', async () => {
    const { disk: s3, calls } = disk(
      (call) => {
        if (call.url.searchParams.has('uploads')) {
          return xml('<InitiateMultipartUploadResult><UploadId>up-3</UploadId></InitiateMultipartUploadResult>');
        }
        return call.method === 'DELETE' ? s3Error(403, 'AccessDenied') : s3Error(500, 'InternalError');
      },
      { multipart: { partSize } },
    );

    await expect(s3.put('big.bin', body())).rejects.toMatchObject({ operation: 'UploadPart', code: 'InternalError' });
    expect(calls.at(-1)!.method).toBe('DELETE');
  });
});

describe('S3Disk configuration', () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const name of ['AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN']) {
      if (saved[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = saved[name];
      }
    }
  });

  it('takes the region from AWS_REGION, then AWS_DEFAULT_REGION, then us-east-1', () => {
    delete process.env.AWS_REGION;
    delete process.env.AWS_DEFAULT_REGION;
    expect(new S3Disk({ bucket: 'shop', credentials }).region).toBe('us-east-1');

    process.env.AWS_DEFAULT_REGION = 'eu-north-1';
    expect(new S3Disk({ bucket: 'shop', credentials }).region).toBe('eu-north-1');

    process.env.AWS_REGION = 'ap-south-1';
    expect(new S3Disk({ bucket: 'shop', credentials }).region).toBe('ap-south-1');
    expect(new S3Disk({ bucket: 'shop', credentials, region: 'auto' }).region).toBe('auto');
  });

  it('ignores an empty AWS_SESSION_TOKEN', async () => {
    Object.assign(process.env, { AWS_ACCESS_KEY_ID: 'AKIDENV', AWS_SECRET_ACCESS_KEY: 'env-secret', AWS_SESSION_TOKEN: '' });
    const { calls, fetch } = scripted(() => ok());
    await new S3Disk({ bucket: 'shop', endpoint: 'http://127.0.0.1:9000', fetch }).put('a', 'x');

    expect(calls[0].headers).not.toHaveProperty('x-amz-security-token');
    expect(calls[0].headers.authorization).toContain('Credential=AKIDENV/');
  });

  it.each([
    ['an http endpoint and a dotted bucket', { endpoint: 'http://localhost:9000', bucket: 'my.bucket' }, 'my.bucket.localhost:9000', '/k.txt'],
    ['an IPv6 endpoint', { endpoint: 'http://[::1]:9000' }, '[::1]:9000', '/shop/k.txt'],
    ['forcePathStyle', { endpoint: 'http://localhost:9000', forcePathStyle: true }, 'localhost:9000', '/shop/k.txt'],
    ['a bucket with a double dot', { endpoint: 'http://localhost:9000', bucket: 'my..bucket' }, 'localhost:9000', '/my..bucket/k.txt'],
  ])('addresses the bucket for %s', async (_label, options, host, pathname) => {
    const { disk: s3, calls } = disk(() => ok(), options);
    await s3.put('k.txt', 'x');
    expect(calls[0].url.host).toBe(host);
    expect(calls[0].url.pathname).toBe(pathname);
  });

  it('refuses what a credentials function returns when it is incomplete, before any request', async () => {
    const { disk: s3, calls } = disk(() => ok(), { credentials: async () => ({ accessKeyId: 'AKID', secretAccessKey: '' }), retry: 3 });
    await expect(s3.put('a', 'x')).rejects.toThrow('the `credentials` function returned must have a non-empty `accessKeyId` and `secretAccessKey`');
    expect(calls).toEqual([]);
  });

  it('refuses an endpoint with credentials or a query', () => {
    expect(() => new S3Disk({ bucket: 'shop', credentials, endpoint: 'http://user:pass@localhost:9000' })).toThrow('`endpoint`');
    expect(() => new S3Disk({ bucket: 'shop', credentials, endpoint: 'http://localhost:9000/?x=1' })).toThrow('`endpoint`');
    expect(() => new S3Disk({ bucket: 'shop', credentials, endpoint: 'ftp://localhost' })).toThrow('`endpoint`');
  });

  it('presigns for 15 minutes by default, with the session token and a signed disposition', async () => {
    const s3 = new S3Disk({ bucket: 'shop', region: 'eu-central-1', credentials: { ...credentials, sessionToken: 'tok en' } });

    const url = new URL(await s3.signedUrl('a b.pdf', { disposition: 'inline' }));

    expect(url.host).toBe('shop.s3.eu-central-1.amazonaws.com');
    expect(url.pathname).toBe('/a%20b.pdf');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(url.searchParams.get('X-Amz-Security-Token')).toBe('tok en');
    expect(url.searchParams.get('response-content-disposition')).toBe('inline');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
    // Spaces are %20 in a presigned query: "+" would reach S3 as a literal plus
    expect(url.search).toContain('X-Amz-Security-Token=tok%20en');
  });

  it('presigns an upload with the length among the signed headers', async () => {
    const s3 = new S3Disk({ bucket: 'shop', region: 'eu-central-1', credentials, prefix: 'up/' });
    const upload = await s3.signedUpload('a.png', { contentType: 'image/png', contentLength: 3, expiresIn: '1h' });
    const url = new URL(upload.url);

    expect(url.pathname).toBe('/up/a.png');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('3600');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host');
    expect(upload.headers).toEqual({ 'content-type': 'image/png', 'content-length': '3' });
  });
});
