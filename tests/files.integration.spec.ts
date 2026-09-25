/**
 * The files app (integration.support.ts) on both adapters and on every built-in disk: multipart
 * uploads streamed onto a named disk, downloads through `serveFile()` (validators, ranges,
 * dispositions), listings, copies, moves and deletes through routes, a file streamed from one
 * named disk to another, and a large upload that goes up to S3 in parts.
 */
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import type { Readable } from 'node:stream';
import request from 'supertest';
import { adapters } from './support/adapters.js';
import {
  bootFilesApp,
  bytes,
  DiskFactory,
  diskKinds,
  fetchBytes,
  type FilesApp,
  HTML,
  MiB,
  PDF,
  PNG,
  PUBLIC_URL,
  storedKeys,
  useFakeS3,
} from './integration.support.js';

const fake = useFakeS3();
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');

describe.each(adapters.map((a) => a.name))('files on %s', (adapter) => {
  describe.each(diskKinds)('with %s', (kind) => {
    const factory = new DiskFactory(kind, fake);
    let ctx: FilesApp;
    const http = () => request(ctx.app.getHttpServer());
    const get = (disk: string, key: string, headers: Record<string, string> = {}, query = '') =>
      fetchBytes(`${ctx.url}/files/${disk}?key=${encodeURIComponent(key)}${query}`, { headers });

    beforeAll(async () => {
      fake.reset();
      ctx = await bootFilesApp(adapter, {
        public: await factory.create('public', { publicUrl: PUBLIC_URL }),
        private: await factory.create('private', { signed: true }),
      });
    });
    afterAll(async () => {
      await ctx?.app.close();
      await factory.cleanup();
    });

    it('uploads onto the public disk and serves the file back with its type, validators and cache policy', async () => {
      const upload = await http().post('/public').attach('file', PNG, { filename: 'photo.png', contentType: 'image/png' }).expect(201);

      expect(upload.body).toMatchObject({
        key: 'uploads/photo.png',
        disk: 'public',
        size: PNG.length,
        contentType: 'image/png',
        etag: expect.any(String),
        url: `${PUBLIC_URL}/uploads/photo.png`,
      });

      const { res, body } = await get('public', 'uploads/photo.png', {}, '&inline=1');
      expect(res.status).toBe(200);
      expect(body).toEqual(PNG);
      expect(Object.fromEntries(res.headers)).toMatchObject({
        'content-type': 'image/png',
        'content-length': String(PNG.length),
        'content-disposition': 'inline; filename="photo.png"',
        'cache-control': 'public, max-age=60',
        'x-content-type-options': 'nosniff',
        'accept-ranges': 'bytes',
        etag: upload.body.etag,
      });
      expect(new Date(res.headers.get('last-modified')!).getTime()).not.toBeNaN();

      const stat = await http().get('/stat/public').query({ key: 'uploads/photo.png' }).expect(200);
      expect(stat.body).toMatchObject({ size: PNG.length, contentType: 'image/png', metadata: { original: 'photo.png' } });
    });

    it('answers single ranges with 206, clamps the end, and refuses a start past the end with 416', async () => {
      const data = bytes(1000);
      await http().post('/public').attach('file', data, { filename: 'ranges.bin' }).expect(201);

      const cases: [string, number, number][] = [
        ['bytes=10-19', 10, 19],
        ['bytes=990-', 990, 999],
        ['bytes=-5', 995, 999],
        ['bytes=995-5000', 995, 999],
      ];
      for (const [range, start, end] of cases) {
        const { res, body } = await get('public', 'uploads/ranges.bin', { range });
        expect(res.status).toBe(206);
        expect(res.headers.get('content-range')).toBe(`bytes ${start}-${end}/1000`);
        expect(res.headers.get('content-length')).toBe(String(end - start + 1));
        expect(body).toEqual(data.subarray(start, end + 1));
      }

      const past = await get('public', 'uploads/ranges.bin', { range: 'bytes=1000-' });
      expect(past.res.status).toBe(416);
      expect(past.res.headers.get('content-range')).toBe('bytes */1000');

      const several = await get('public', 'uploads/ranges.bin', { range: 'bytes=0-1,5-6' });
      expect(several.res.status).toBe(200);
      expect(several.body).toEqual(data);
    });

    it('answers If-None-Match with 304, and a range for another version (If-Range) with the whole file', async () => {
      const data = bytes(64, 3);
      await http().post('/public').attach('file', data, { filename: 'cached.bin' }).expect(201);
      const first = await get('public', 'uploads/cached.bin');
      const etag = first.res.headers.get('etag')!;

      const cached = await get('public', 'uploads/cached.bin', { 'if-none-match': etag });
      expect(cached.res.status).toBe(304);
      expect(cached.res.headers.get('etag')).toBe(etag);
      expect(cached.body.length).toBe(0);

      const stale = await get('public', 'uploads/cached.bin', { 'if-none-match': '"another"' });
      expect(stale.res.status).toBe(200);

      const sameVersion = await get('public', 'uploads/cached.bin', { range: 'bytes=0-9', 'if-range': etag });
      expect(sameVersion.res.status).toBe(206);
      const otherVersion = await get('public', 'uploads/cached.bin', { range: 'bytes=0-9', 'if-range': '"another"' });
      expect(otherVersion.res.status).toBe(200);
      expect(otherVersion.body).toEqual(data);

      await http().post('/public').attach('file', bytes(64, 4), { filename: 'cached.bin' }).expect(201);
      const replaced = await get('public', 'uploads/cached.bin', { 'if-none-match': etag });
      expect(replaced.res.status).toBe(200);
      expect(replaced.body).toEqual(bytes(64, 4));
    });

    it('sends a type that could run script as an attachment even when inline was asked, and names downloads safely', async () => {
      await ctx.publicDisk.put('pages/page.html', HTML);
      await http().post('/public').attach('file', PDF, { filename: 'report.pdf' }).expect(201);

      const html = await get('public', 'pages/page.html', {}, '&inline=1');
      expect(html.res.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(html.res.headers.get('content-disposition')).toBe('attachment; filename="page.html"');
      expect(html.res.headers.get('cache-control')).toBe('private');

      const named = await get('public', 'uploads/report.pdf', {}, `&filename=${encodeURIComponent('Bericht März.pdf')}`);
      expect(named.res.headers.get('content-type')).toBe('application/pdf');
      expect(named.res.headers.get('content-disposition')).toBe(`attachment; filename="Bericht M_rz.pdf"; filename*=UTF-8''Bericht%20M%C3%A4rz.pdf`);
    });

    it('is a 404 for a missing file and for a key that is not a key', async () => {
      for (const key of ['uploads/missing.png', '../../etc/passwd', 'a//b']) {
        const { res } = await get('public', key);
        expect(res.status).toBe(404);
      }
    });

    it('checks private uploads by their bytes and size while streaming, and stores nothing it refuses', async () => {
      const ok = await http().post('/private').attach('docs', PDF, { filename: 'a.pdf' }).attach('docs', PNG, { filename: 'b.png' }).expect(201);
      expect(ok.body).toEqual([
        { key: expect.stringMatching(/^[0-9a-f-]{36}\.pdf$/), size: PDF.length, contentType: 'application/pdf', disk: 'private' },
        { key: expect.stringMatching(/^[0-9a-f-]{36}\.png$/), size: PNG.length, contentType: 'image/png', disk: 'private' },
      ]);

      await http().post('/private').attach('docs', HTML, { filename: 'c.pdf', contentType: 'application/pdf' }).expect(415);
      await http().post('/private').attach('docs', Buffer.concat([PDF, Buffer.alloc(2048)]), { filename: 'd.pdf' }).expect(413);
      await http().post('/private').attach('docs', PDF, { filename: 'e.pdf' }).attach('docs', HTML, { filename: 'f.pdf' }).expect(415);

      const listed = await http().get('/list-all/private').expect(200);
      expect([...listed.body].sort()).toEqual(ok.body.map((file: { key: string }) => file.key).sort());
      if (kind === 'S3Disk') {
        expect(storedKeys(fake, 'private')).toEqual([...listed.body].sort());
        expect(fake.uploads.size).toBe(0);
      }
    });

    it('streams a large upload onto the disk (in parts on S3) and serves it whole and across a part boundary', { timeout: 30_000 }, async () => {
      const data = bytes(11 * MiB + 123, 7);
      fake.requests.length = 0;

      const upload = await http().post('/public').attach('file', data, { filename: 'large.bin' }).expect(201);
      expect(upload.body.size).toBe(data.length);

      if (kind === 'S3Disk') {
        const parts = fake.requests.filter((r) => r.method === 'PUT' && r.query.partNumber);
        expect(fake.requests.some((r) => r.method === 'POST' && 'uploads' in r.query)).toBe(true);
        // Parts upload concurrently, so they can arrive in any order: S3 assembles them by number
        const sizes = parts.map((r) => [Number(r.query.partNumber), r.bodyLength]).sort(([a], [b]) => a - b);
        expect(sizes).toEqual([
          [1, 5 * MiB],
          [2, 5 * MiB],
          [3, MiB + 123],
        ]);
        expect(fake.uploads.size).toBe(0);
      }

      const whole = await get('public', 'uploads/large.bin');
      expect(whole.res.headers.get('content-length')).toBe(String(data.length));
      expect(sha(whole.body)).toBe(sha(data));

      const boundary = 5 * MiB;
      const part = await get('public', 'uploads/large.bin', { range: `bytes=${boundary - 10}-${boundary + 9}` });
      expect(part.res.status).toBe(206);
      expect(part.body).toEqual(data.subarray(boundary - 10, boundary + 10));
    });

    it('lists, pages, copies, moves and deletes through routes', async () => {
      for (const name of ['b.png', 'a.png', 'c.png']) {
        await http().post('/public').attach('file', PNG, { filename: name }).expect(201);
      }
      const prefix = 'uploads/';
      const all = (await http().get('/list-all/public').query({ prefix }).expect(200)).body as string[];
      const mine = all.filter((key) => /\/(a|b|c)\.png$/.test(key));
      expect(mine).toEqual(['uploads/a.png', 'uploads/b.png', 'uploads/c.png']);

      const first = await http().get('/list/public').query({ prefix: 'uploads/a', limit: 1 }).expect(200);
      expect(first.body.entries).toEqual([{ key: 'uploads/a.png', size: PNG.length, lastModified: expect.any(String), etag: expect.any(String) }]);

      const pages: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await http().get('/list/public').query({ prefix, limit: 2, ...(cursor ? { cursor } : {}) }).expect(200);
        pages.push(...page.body.entries.map((entry: { key: string }) => entry.key));
        cursor = page.body.cursor;
      } while (cursor);
      expect(pages).toEqual(all);

      const copied = await http().post('/copy/public').query({ from: 'uploads/a.png', to: 'copies/a.png' }).expect(201);
      expect(copied.body).toMatchObject({ key: 'copies/a.png', size: PNG.length, contentType: 'image/png' });
      const moved = await http().post('/move/public').query({ from: 'uploads/b.png', to: 'moved/b.png' }).expect(201);
      expect(moved.body).toMatchObject({ key: 'moved/b.png', contentType: 'image/png' });

      const stat = await http().get('/stat/public').query({ key: 'moved/b.png' }).expect(200);
      expect(stat.body).toMatchObject({ cacheControl: 'public, max-age=60', metadata: { original: 'b.png' } });
      expect((await http().get('/exists/public').query({ key: 'uploads/b.png' })).body).toEqual({ exists: false });
      expect((await get('public', 'copies/a.png')).body).toEqual(PNG);

      await http().delete('/files/public').query({ keys: 'copies/a.png,moved/b.png,never/was.png' }).expect(200);
      await http().delete('/files/public').query({ keys: 'uploads/c.png' }).expect(200);
      expect((await http().get('/list-all/public').query({ prefix: 'copies/' })).body).toEqual([]);
      expect((await http().get('/list-all/public').query({ prefix: 'moved/' })).body).toEqual([]);
      expect((await http().get('/exists/public').query({ key: 'uploads/c.png' })).body).toEqual({ exists: false });
      expect((await http().get('/exists/public').query({ key: 'uploads/a.png' })).body).toEqual({ exists: true });
    });

    it('maps storage errors to their status where the app chooses to, and lets them reach Nest as a 500 elsewhere', async () => {
      const missing = await http().post('/copy/public').query({ from: 'nowhere.png', to: 'x.png' }).expect(404);
      expect(missing.body.message).toContain('nowhere.png');
      await http().post('/move/public').query({ from: '../escape', to: 'x.png' }).expect(400);
      await http().post('/move-unmapped/public').query({ from: 'nowhere.png', to: 'x.png' }).expect(500);
      expect((await http().get('/exists/public').query({ key: 'x.png' })).body).toEqual({ exists: false });
    });

    it.runIf(kind === 'LocalDisk')('a key under a file is a conflict on a local disk (409), and the source stays', async () => {
      await http().post('/public').attach('file', PNG, { filename: 'solid.png' }).expect(201);

      await http().post('/copy/public').query({ from: 'uploads/solid.png', to: 'uploads/solid.png/inner.png' }).expect(409);

      expect((await get('public', 'uploads/solid.png')).body).toEqual(PNG);
    });

    it('stores nothing when the client disconnects mid-upload (an S3 multipart upload is aborted)', { timeout: 15_000 }, async () => {
      const boundary = 'integration-boundary';
      const before = (await http().get('/list-all/public').expect(200)).body;
      fake.requests.length = 0;

      await new Promise<void>((resolve) => {
        const req = httpRequest(`${ctx.url}/public`, {
          method: 'POST',
          headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(20 * MiB) },
        });
        req.on('error', () => resolve());
        req.write(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="cut.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`);
        req.write(bytes(12 * MiB), async () => {
          // On S3, wait until the first part is up, so the disconnect has an upload to abort
          const started = () => kind !== 'S3Disk' || fake.requests.some((r) => r.query.partNumber === '1');
          for (let i = 0; i < 250 && !started(); i++) {
            await new Promise((wait) => setTimeout(wait, 20));
          }
          await new Promise((wait) => setTimeout(wait, 50));
          req.destroy();
          resolve();
        });
      });

      const settled = async () => {
        const listed = (await http().get('/list-all/public')).body;
        const aborted = kind !== 'S3Disk' || fake.requests.some((r) => r.method === 'DELETE' && r.query.uploadId);
        return JSON.stringify(listed) === JSON.stringify(before) && fake.uploads.size === 0 && aborted;
      };
      for (let i = 0; i < 250 && !(await settled()); i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      expect((await http().get('/list-all/public')).body).toEqual(before);
      if (kind === 'S3Disk') {
        expect(fake.requests.some((r) => r.method === 'DELETE' && r.query.uploadId)).toBe(true);
        expect(fake.uploads.size).toBe(0);
        expect(fake.object('public/uploads/cut.bin')).toBeUndefined();
      }
    });

    it('releases the file, or the connection to the store, when the client disconnects mid-download', { timeout: 15_000 }, async () => {
      await ctx.publicDisk.put('big/stream.bin', bytes(8 * MiB));
      const bodies: Readable[] = [];
      const original = ctx.publicDisk.get.bind(ctx.publicDisk);
      const spy = vi.spyOn(ctx.publicDisk, 'get').mockImplementation(async (...args) => {
        const download = await original(...args);
        bodies.push(download.body);
        return download;
      });

      try {
        await new Promise<void>((resolve) => {
          const req = httpRequest(`${ctx.url}/files/public?key=big%2Fstream.bin`, (res) => {
            res.once('data', () => {
              req.destroy();
              resolve();
            });
          });
          req.on('error', () => resolve());
          req.end();
        });

        for (let i = 0; i < 250 && !bodies[0]?.destroyed; i++) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }

        expect(bodies).toHaveLength(1);
        expect(bodies[0].destroyed).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });

    it('streams a private file onto the public disk: two named disks, the default one injected by type', async () => {
      const [doc] = (await http().post('/private').attach('docs', PDF, { filename: 'q3.pdf' }).expect(201)).body;

      const published = await http().post('/publish').query({ key: doc.key, as: 'reports/q3.pdf' }).expect(201);
      expect(published.body).toMatchObject({ key: 'reports/q3.pdf', size: PDF.length, contentType: 'application/pdf', url: `${PUBLIC_URL}/reports/q3.pdf` });

      const served = await get('public', 'reports/q3.pdf');
      expect(served.body).toEqual(PDF);
      expect(served.res.headers.get('cache-control')).toBe('public, max-age=3600');
      expect((await http().get('/exists/private').query({ key: doc.key })).body).toEqual({ exists: true });
      await http().post('/publish').query({ key: 'gone.pdf', as: 'reports/gone.pdf' }).expect(404);
    });
  });
});
