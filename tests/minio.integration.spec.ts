/**
 * Against a real MinIO server, when the `minio` binary is installed (it isn't downloaded):
 * starts one on a temporary directory, creates a bucket with a signed request, and runs the
 * S3Disk operations end to end, multipart and presigned URLs included. Skipped otherwise.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { S3Disk } from '../lib/index.js';
import { EMPTY_SHA256, signRequest } from '../lib/s3/sigv4.util.js';

const minio = (() => {
  try {
    return execFileSync('which', ['minio'], { encoding: 'utf8' }).trim() || undefined;
  } catch {
    return undefined;
  }
})();

const credentials = { accessKeyId: 'nestadmin', secretAccessKey: 'nestadmin-secret-123' };

describe.skipIf(!minio)('S3Disk against MinIO', () => {
  let server: ChildProcess;
  let dir: string;
  let endpoint: string;
  let disk: S3Disk;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'minio-'));
    const port = await freePort();
    endpoint = `http://127.0.0.1:${port}`;
    server = spawn(minio!, ['server', dir, '--address', `127.0.0.1:${port}`, '--quiet'], {
      env: { ...process.env, MINIO_ROOT_USER: credentials.accessKeyId, MINIO_ROOT_PASSWORD: credentials.secretAccessKey },
      stdio: 'ignore',
    });

    for (let i = 0; i < 100; i++) {
      const ready = await fetch(`${endpoint}/minio/health/ready`).then((r) => r.ok, () => false);
      if (ready) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const url = new URL(`${endpoint}/acme`);
    const headers = signRequest({ method: 'PUT', url, headers: { 'x-amz-content-sha256': EMPTY_SHA256 }, payloadHash: EMPTY_SHA256, credentials, region: 'us-east-1' });
    const res = await fetch(url, { method: 'PUT', headers });
    expect(res.status).toBe(200);

    disk = new S3Disk({ bucket: 'acme', endpoint, forcePathStyle: true, region: 'us-east-1', credentials, multipart: { partSize: 5 * 1024 * 1024 } });
  }, 30_000);

  afterAll(() => {
    server?.kill();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('puts, reads ranges, lists, copies, moves and deletes', async () => {
    await disk.put('docs/a b.txt', 'hello world', { metadata: { owner: 'u1' }, cacheControl: 'no-cache' });
    expect(await disk.getText('docs/a b.txt')).toBe('hello world');
    const partial = await disk.get('docs/a b.txt', { range: { start: 6 } });
    expect(partial.range).toEqual({ start: 6, end: 10 });
    expect(await disk.stat('docs/a b.txt')).toMatchObject({ size: 11, contentType: 'text/plain; charset=utf-8', metadata: { owner: 'u1' }, cacheControl: 'no-cache' });

    await disk.copy('docs/a b.txt', 'docs/copy.txt');
    await disk.move('docs/copy.txt', 'docs/moved.txt');
    expect((await disk.list({ prefix: 'docs/' })).entries.map((e) => e.key)).toEqual(['docs/a b.txt', 'docs/moved.txt']);

    await disk.delete(['docs/a b.txt', 'docs/moved.txt']);
    expect((await disk.list({ prefix: 'docs/' })).entries).toEqual([]);
  });

  it('uploads a stream in parts', async () => {
    const data = Buffer.alloc(11 * 1024 * 1024, 7);
    await disk.put('big.bin', Readable.from([data.subarray(0, 4_000_000), data.subarray(4_000_000)]));
    expect((await disk.getBuffer('big.bin')).equals(data)).toBe(true);
  });

  it('presigns downloads and uploads', async () => {
    const upload = await disk.signedUpload('incoming/p.png', { contentType: 'image/png', contentLength: 4 });
    const { 'content-length': _, ...headers } = upload.headers;
    expect((await fetch(upload.url, { method: 'PUT', headers, body: Buffer.from([1, 2, 3, 4]) })).status).toBe(200);

    const res = await fetch(await disk.signedUrl('incoming/p.png', { filename: 'photo.png' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="photo.png"');
  });
});

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}
