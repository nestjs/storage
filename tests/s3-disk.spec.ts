import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  S3Disk,
  type S3DiskOptions,
  StorageError,
  StorageFileNotFoundError,
  StorageServiceError,
} from '../lib/index.js';
import { ACCESS_KEY, FakeS3, SECRET_KEY } from './fake-s3.js';

const MiB = 1024 * 1024;
const fake = new FakeS3();
const credentials = { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY };

beforeAll(() => fake.start());
afterAll(() => fake.stop());
beforeEach(() => fake.reset());
afterEach(() => expect(fake.signatureFailures).toEqual([]));

const s3 = (options: Partial<S3DiskOptions> = {}) =>
  new S3Disk({
    bucket: 'shop',
    region: 'eu-central-1',
    endpoint: fake.ipEndpoint,
    credentials,
    retry: { attempts: 3, backoff: { delay: 1, jitter: 'none' } },
    ...options,
  });

const ops = () => fake.requests.map((r) => `${r.method} ${r.key || '/'}${Object.keys(r.query).length ? `?${Object.keys(r.query).sort().join('&')}` : ''}`);
const bytes = (size: number, seed = 1) => {
  const data = Buffer.alloc(size);
  for (let i = 0; i < size; i++) {
    data[i] = (i * 31 + seed) & 0xff;
  }
  return data;
};
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');

describe('S3Disk', () => {
  describe('uploads', () => {
    it('sends a body up to partSize in one PutObject, with a signed payload hash', async () => {
      const disk = s3();
      const data = bytes(5 * MiB);
      await disk.put('big/one.bin', data);

      expect(ops()).toEqual(['PUT big/one.bin']);
      expect(fake.requests[0].headers['x-amz-content-sha256']).toBe(sha(data));
      expect(fake.object('big/one.bin')!.data.equals(data)).toBe(true);
    });

    it('streams a longer body of unknown length as a multipart upload', { timeout: 30_000 }, async () => {
      const disk = s3({ multipart: { partSize: 5 * MiB, concurrency: 2 } });
      const data = bytes(12 * MiB + 17);

      // A stream in odd-sized chunks, the way a network upload arrives
      const chunks = [];
      for (let offset = 0; offset < data.length; offset += 777_777) {
        chunks.push(data.subarray(offset, offset + 777_777));
      }

      const result = await disk.put('big/multi.bin', Readable.from(chunks), { metadata: { source: 'scanner' }, cacheControl: 'private' });

      expect(ops()).toEqual([
        'POST big/multi.bin?uploads',
        'PUT big/multi.bin?partNumber&uploadId',
        'PUT big/multi.bin?partNumber&uploadId',
        'PUT big/multi.bin?partNumber&uploadId',
        'POST big/multi.bin?uploadId',
      ]);
      expect(fake.requests.slice(1, 4).map((r) => r.bodyLength)).toEqual([5 * MiB, 5 * MiB, 2 * MiB + 17]);

      const stored = fake.object('big/multi.bin')!;
      expect(stored.data.equals(data)).toBe(true);
      expect(stored).toMatchObject({ metadata: { source: 'scanner' }, cacheControl: 'private', contentType: 'application/octet-stream' });
      expect(result).toMatchObject({ size: data.length, etag: expect.stringMatching(/-3"$/) });
      expect((await disk.stat('big/multi.bin')).size).toBe(data.length);
    });

    it('keeps at most `concurrency` parts in flight', async () => {
      const disk = s3({ multipart: { partSize: 5 * MiB, concurrency: 2 } });
      let inFlight = 0;
      let peak = 0;

      const original = globalThis.fetch;
      const counting: typeof fetch = async (url, init) => {
        const isPart = String(url).includes('partNumber');
        if (isPart) {
          peak = Math.max(peak, ++inFlight);
        }
        try {
          return await original(url, init);
        } finally {
          if (isPart) {
            inFlight--;
          }
        }
      };

      await s3({ multipart: { partSize: 5 * MiB, concurrency: 2 }, fetch: counting }).put('p.bin', bytes(26 * MiB));

      expect(peak).toBe(2);
      expect(fake.object('p.bin')!.data.length).toBe(26 * MiB);
      void disk;
    });

    it('aborts the multipart upload when a part fails, and stores nothing', async () => {
      const disk = s3({ multipart: { partSize: 5 * MiB }, retry: false });
      fake.fail((r) => r.query.partNumber === '2', { status: 500, code: 'InternalError', times: 1 });

      const error = await disk.put('big/failed.bin', Readable.from([bytes(11 * MiB)])).catch((e) => e);

      expect(error).toBeInstanceOf(StorageServiceError);
      expect(error).toMatchObject({ operation: 'UploadPart', code: 'InternalError', upstreamStatus: 500 });
      expect(ops().at(-1)).toBe('DELETE big/failed.bin?uploadId');
      expect(fake.uploads.size).toBe(0);
      expect(fake.object('big/failed.bin')).toBeUndefined();
    });

    it('aborts when the body fails after the upload started', async () => {
      const disk = s3({ multipart: { partSize: 5 * MiB } });
      const body = async function* () {
        yield bytes(6 * MiB);
        yield bytes(6 * MiB);
        throw new Error('client disconnected');
      };

      await expect(disk.put('big/cut.bin', body())).rejects.toThrow('client disconnected');
      expect(ops().at(-1)).toBe('DELETE big/cut.bin?uploadId');
      expect(fake.uploads.size).toBe(0);
    });

    it('treats a CompleteMultipartUpload that answers 200 with an <Error> as a failure', async () => {
      const disk = s3({ multipart: { partSize: 5 * MiB }, retry: false });
      fake.fail(() => false, { status: 0, code: 'CompleteError', times: 1 });
      const error = await disk.put('big/x.bin', bytes(11 * MiB)).catch((e) => e);
      expect(error).toMatchObject({ name: 'StorageServiceError', operation: 'CompleteMultipartUpload', code: 'InternalError' });
      expect(ops().at(-1)).toBe('DELETE big/x.bin?uploadId');
    });

    it('sizes parts from contentLength, and refuses a body that differs from it', async () => {
      const disk = s3({ multipart: { partSize: 5 * MiB } });
      await expect(disk.put('big/len.bin', Readable.from([bytes(11 * MiB)]), { contentLength: 10 * MiB })).rejects.toMatchObject({
        name: 'StorageBodyLengthError',
      });
      expect(fake.object('big/len.bin')).toBeUndefined();
      expect(fake.uploads.size).toBe(0);
    });

    it('sends server-side encryption headers on writes and copies', async () => {
      const disk = s3({ serverSideEncryption: 'aws:kms', kmsKeyId: 'arn:aws:kms:eu-central-1:1:key/abc', multipart: { partSize: 5 * MiB } });
      await disk.put('enc/a.txt', 'secret');
      await disk.put('enc/big.bin', bytes(6 * MiB));
      await disk.copy('enc/a.txt', 'enc/b.txt');

      expect(fake.object('enc/a.txt')).toMatchObject({ encryption: 'aws:kms', kmsKeyId: 'arn:aws:kms:eu-central-1:1:key/abc' });
      expect(fake.object('enc/big.bin')).toMatchObject({ encryption: 'aws:kms' });
      expect(fake.object('enc/b.txt')).toMatchObject({ encryption: 'aws:kms' });
    });
  });

  describe('retries', () => {
    it('retries throttling and 5xx, then succeeds', async () => {
      const disk = s3();
      fake.fail((r) => r.method === 'PUT', { status: 503, code: 'SlowDown', times: 2 });
      await disk.put('r.txt', 'x');
      expect(ops()).toEqual(['PUT r.txt', 'PUT r.txt', 'PUT r.txt']);
    });

    it('retries a reset connection', async () => {
      const disk = s3();
      fake.fail((r) => r.method === 'GET', { status: 0, code: '', reset: true, times: 1 });
      await disk.put('r.txt', 'x');
      expect(await disk.getText('r.txt')).toBe('x');
    });

    it('gives up after `attempts`, with the store error', async () => {
      const disk = s3();
      fake.fail(() => true, { status: 500, code: 'InternalError', times: 5 });
      const error = await disk.stat('x').catch((e) => e);
      expect(error).toBeInstanceOf(StorageServiceError);
      expect(fake.requests).toHaveLength(3);
    });

    it('does not retry what retrying cannot fix', async () => {
      const disk = s3();
      fake.fail(() => true, { status: 403, code: 'AccessDenied', times: 5 });
      const error = await disk.getText('x').catch((e) => e);

      expect(error).toMatchObject({ code: 'AccessDenied', upstreamStatus: 403, operation: 'GetObject', requestId: 'req-1' });
      // An outage or a misconfiguration is not the caller's fault: no 4xx `status`
      expect(error.status).toBeUndefined();
      expect(fake.requests).toHaveLength(1);
    });

    it('honors retry: false and retryIf', async () => {
      fake.fail(() => true, { status: 503, code: 'SlowDown', times: 5 });
      await expect(s3({ retry: false }).stat('x')).rejects.toBeInstanceOf(StorageServiceError);
      expect(fake.requests).toHaveLength(1);

      const retryIf = vi.fn(() => false);
      await expect(s3({ retry: { retryIf } }).stat('x')).rejects.toBeInstanceOf(StorageServiceError);
      expect(retryIf).toHaveBeenCalledWith(expect.any(StorageServiceError), 1);
      expect(fake.requests).toHaveLength(2);
    });

    it('times out an attempt and retries it', async () => {
      const disk = s3({ timeout: '100ms' });
      fake.fail(() => true, { status: 0, code: '', delayMs: 400, times: 1 });
      await disk.put('slow.txt', 'x');
      expect(await disk.getText('slow.txt')).toBe('x');

      fake.fail(() => true, { status: 0, code: '', delayMs: 400, times: 3 });
      const error = await disk.stat('slow.txt').catch((e) => e);
      expect(error).toMatchObject({ code: 'Timeout', operation: 'HeadObject' });
    });

    it('a missing bucket is a service error, not a missing file', async () => {
      const error = await s3({ bucket: 'nope-bucket' }).getText('x').catch((e) => e);
      expect(error).toBeInstanceOf(StorageServiceError);
      expect(error).not.toBeInstanceOf(StorageFileNotFoundError);
      expect(error.code).toBe('NoSuchBucket');
    });
  });

  describe('presigned URLs', () => {
    it('GET: a link that works without credentials, with a download name', async () => {
      const disk = s3();
      await disk.put('invoices/INV-1.pdf', '%PDF-1.7');

      const url = await disk.signedUrl('invoices/INV-1.pdf', { expiresIn: '5m', filename: 'Faktura ż.pdf' });
      expect(url).toContain('X-Amz-Expires=300');
      expect(url).toContain('response-content-disposition=');

      const res = await fetch(url);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('%PDF-1.7');
      expect(res.headers.get('content-disposition')).toBe(`attachment; filename="Faktura _.pdf"; filename*=UTF-8''Faktura%20%C5%BC.pdf`);
    });

    it('GET: a tampered or expired link is refused', async () => {
      const disk = s3();
      await disk.put('a.txt', 'a');
      await disk.put('b.txt', 'b');

      const url = await disk.signedUrl('a.txt');
      expect((await fetch(url.replace('/a.txt', '/b.txt'))).status).toBe(403);
      fake.signatureFailures.length = 0;

      vi.useFakeTimers({ toFake: ['Date'], now: Date.now() - 2 * 3_600_000 });
      const old = await disk.signedUrl('a.txt', { expiresIn: '1h' });
      vi.useRealTimers();
      expect((await fetch(old)).status).toBe(403);
      expect(fake.signatureFailures).toEqual(['expired']);
      fake.signatureFailures.length = 0;
    });

    it('PUT: the client must send the signed type and length', async () => {
      const disk = s3();
      const upload = await disk.signedUpload('incoming/photo', { contentType: 'image/jpeg', contentLength: 4, expiresIn: '10m' });
      expect(upload).toMatchObject({
        method: 'PUT',
        headers: { 'content-type': 'image/jpeg', 'content-length': '4' },
      });
      expect(upload.expiresAt.getTime()).toBeGreaterThan(Date.now() + 9 * 60_000);

      const { 'content-length': _, ...headers } = upload.headers;
      const good = await fetch(upload.url, { method: 'PUT', headers, body: Buffer.from([1, 2, 3, 4]) });
      expect(good.status).toBe(200);
      expect(fake.object('incoming/photo')).toMatchObject({ contentType: 'image/jpeg' });

      for (const attempt of [
        { headers: { 'content-type': 'text/html' }, body: Buffer.from([1, 2, 3, 4]) },
        { headers, body: Buffer.from([1, 2, 3, 4, 5]) },
      ]) {
        const res = await fetch(upload.url, { method: 'PUT', ...attempt });
        expect(res.status).toBe(403);
      }
      expect(fake.signatureFailures).toHaveLength(2);
      fake.signatureFailures.length = 0;
    });

    it('PUT: server-side encryption headers are part of the signed request', async () => {
      const disk = s3({ serverSideEncryption: 'AES256' });
      const upload = await disk.signedUpload('incoming/doc', { contentType: 'application/pdf' });
      expect(upload.headers).toEqual({ 'content-type': 'application/pdf', 'x-amz-server-side-encryption': 'AES256' });
      const res = await fetch(upload.url, { method: 'PUT', headers: upload.headers, body: '%PDF' });
      expect(res.status).toBe(200);
      expect(fake.object('incoming/doc')).toMatchObject({ encryption: 'AES256' });
    });

    it('refuses an expiry over 7 days', async () => {
      await expect(s3().signedUrl('a', { expiresIn: '8d' })).rejects.toThrow('between 1 second and 7 days');
      await expect(s3().signedUpload('a', { contentType: 'x/y', expiresIn: '1 week' as never })).rejects.toThrow(TypeError);
    });
  });

  describe('reads', () => {
    it('refuses to stream an object stored with a Content-Encoding, which fetch would decode', async () => {
      const disk = s3();
      await disk.put('logs/app.log', 'plain');
      // Another tool stored it gzip-encoded (a static-site deploy, a log shipper)
      fake.objects.set('shop/logs/app.log.gz', { ...fake.object('logs/app.log')!, contentEncoding: 'gzip' });

      const error = await disk.get('logs/app.log.gz').catch((e) => e);
      expect(error).toBeInstanceOf(StorageError);
      expect(error.message).toContain('Content-Encoding: gzip');
      expect(error.message).toContain('logs/app.log.gz');

      // Metadata is still readable, and a plain object is unaffected
      expect((await disk.stat('logs/app.log.gz')).size).toBe(5);
      expect(await disk.getText('logs/app.log')).toBe('plain');
    });
  });

  describe('credentials', () => {
    const saved = { ...process.env };
    afterEach(() => {
      for (const name of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_REGION', 'AWS_DEFAULT_REGION']) {
        if (saved[name] === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = saved[name];
        }
      }
    });

    it('reads the standard environment variables, session token included', async () => {
      Object.assign(process.env, { AWS_ACCESS_KEY_ID: ACCESS_KEY, AWS_SECRET_ACCESS_KEY: SECRET_KEY, AWS_SESSION_TOKEN: 'token-123', AWS_REGION: 'ap-south-1' });
      fake.sessionToken = 'token-123';
      const disk = new S3Disk({ bucket: 'shop', endpoint: fake.ipEndpoint });

      expect(disk.region).toBe('ap-south-1');
      await disk.put('t.txt', 'x');
      expect(fake.requests[0].headers['x-amz-security-token']).toBe('token-123');

      const res = await fetch(await disk.signedUrl('t.txt'));
      expect(res.status).toBe(200);
    });

    it('fails at startup without credentials, naming the options', () => {
      delete process.env.AWS_ACCESS_KEY_ID;
      delete process.env.AWS_SECRET_ACCESS_KEY;
      expect(() => new S3Disk({ bucket: 'shop' })).toThrow(/AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY/);
      expect(() => new S3Disk({ bucket: 'shop', credentials: { accessKeyId: '', secretAccessKey: 'x' } })).toThrow('accessKeyId');
    });

    it('calls a credentials function for every request', async () => {
      const provider = vi.fn(async () => credentials);
      const disk = s3({ credentials: provider });
      await disk.put('c.txt', 'x');
      await disk.stat('c.txt');
      expect(provider).toHaveBeenCalledTimes(2);
    });
  });

  describe('deletes and listings', () => {
    it('deletes in batches of 1000 with Content-MD5', async () => {
      const disk = s3();
      const keys = Array.from({ length: 1500 }, (_, i) => `bulk/${String(i).padStart(4, '0')} & <x>.txt`);
      for (const key of keys.slice(0, 5)) {
        await disk.put(key, 'x');
      }
      fake.requests.length = 0;

      await disk.delete(keys);
      expect(ops()).toEqual(['POST /?delete', 'POST /?delete']);
      expect(fake.objects.size).toBe(0);
    });

    it('reports keys a batch delete could not remove', async () => {
      const disk = s3();
      await disk.put('keep/a.txt', 'x');
      await disk.put('keep/b.txt', 'x');
      fake.fail((r) => r.key === 'keep/b.txt', { status: 0, code: 'AccessDenied', times: 1 });

      const error = await disk.delete(['keep/a.txt', 'keep/b.txt']).catch((e) => e);
      expect(error).toMatchObject({ operation: 'DeleteObjects', code: 'AccessDenied', message: expect.stringContaining('1 of 2 keys') });
    });

    it('deletes one by one with batchDelete: false', async () => {
      const disk = s3({ batchDelete: false });
      await disk.delete(['a', 'b']);
      expect(ops()).toEqual(['DELETE a', 'DELETE b']);
    });

    it('skips objects other tools stored under names no disk accepts', async () => {
      const disk = s3();
      await disk.put('ok/file.txt', 'x');
      for (const odd of ['ok/', 'ok//double', 'ok/./dot']) {
        fake.objects.set(`shop/${odd}`, { ...fake.object('ok/file.txt')! });
      }

      expect((await disk.list({ prefix: 'ok/' })).entries.map((e) => e.key)).toEqual(['ok/file.txt']);
    });
  });

  describe('configuration', () => {
    it.each([
      [{ bucket: 'a' }, '`bucket`'],
      [{ endpoint: 'minio:9000' }, '`endpoint`'],
      [{ endpoint: 'https://s3.example.com/path' }, '`endpoint`'],
      [{ multipart: { partSize: MiB } }, '`multipart.partSize`'],
      [{ multipart: { concurrency: 0 } }, '`multipart.concurrency`'],
      [{ kmsKeyId: 'k' }, '`kmsKeyId`'],
      [{ serverSideEncryption: 'rot13' as never }, '`serverSideEncryption`'],
      [{ prefix: '../x/' }, '`prefix`'],
      [{ timeout: '5 sec' as never }, '`timeout`'],
      [{ retry: { attempts: 0 } }, '`retry.attempts`'],
      [{ region: 'EU West' }, '`region`'],
      [{ publicUrl: 'cdn.example.com' }, '`publicUrl`'],
    ])('%o fails at startup naming %s', (options, option) => {
      expect(() => s3(options as Partial<S3DiskOptions>)).toThrow(option);
    });

    it('addresses buckets virtual-hosted by default, path-style when it must', async () => {
      const presignedHost = async (options: Partial<S3DiskOptions>) =>
        new URL(await s3({ endpoint: undefined, region: 'eu-west-1', ...options }).signedUrl('k.txt'));

      expect((await presignedHost({})).host).toBe('shop.s3.eu-west-1.amazonaws.com');
      expect((await presignedHost({ bucket: 'shop.assets' })).pathname).toBe('/shop.assets/k.txt');
      expect((await presignedHost({ bucket: 'Shop_Assets' })).pathname).toBe('/Shop_Assets/k.txt');
      expect((await presignedHost({ forcePathStyle: true })).host).toBe('s3.eu-west-1.amazonaws.com');
      expect((await presignedHost({ endpoint: 'https://acct.r2.cloudflarestorage.com', region: 'auto' })).host).toBe(
        'shop.acct.r2.cloudflarestorage.com',
      );
      expect((await presignedHost({ endpoint: 'http://10.0.0.5:9000' })).pathname).toBe('/shop/k.txt');
    });

    it('wrong credentials are refused by the fake, so a passing test means a valid signature', async () => {
      const error = await s3({ credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: 'wrong' }, retry: false }).getText('x').catch((e) => e);
      expect(error).toMatchObject({ code: 'SignatureDoesNotMatch', upstreamStatus: 403 });
      expect(fake.signatureFailures[0]).toMatch(/^signature mismatch for\nGET\n\/shop\/x\n/);
      fake.signatureFailures.length = 0;
    });

    it('url() needs a publicUrl', () => {
      expect(() => s3().url('a')).toThrow(StorageError);
      expect(s3({ publicUrl: 'https://cdn.example.com' }).url('photos/a b.jpg')).toBe('https://cdn.example.com/photos/a%20b.jpg');
    });
  });
});
