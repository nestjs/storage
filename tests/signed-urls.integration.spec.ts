/**
 * Signed URLs as a client uses them, on both adapters and every built-in disk: the app hands
 * out a URL, and a plain HTTP client downloads or uploads with it. On the in-memory and local
 * disks the URL points at the app's own `serveSignedUrl()` / `receiveSignedUpload()` routes;
 * on S3 it is presigned, and the fake S3 verifies it. Includes the tutorial's direct-upload
 * flow: upload URL, client upload, a check of the bytes, then onto the public disk.
 */
import request from 'supertest';
import { adapters } from './support/adapters.js';
import {
  bootFilesApp,
  clientUrl,
  DiskFactory,
  diskKinds,
  fetchBytes,
  type FilesApp,
  HTML,
  MiB,
  PDF,
  PNG,
  PUBLIC_URL,
  useFakeS3,
} from './integration.support.js';

const fake = useFakeS3();

describe.each(adapters.map((a) => a.name))('signed URLs on %s', (adapter) => {
  describe.each(diskKinds)('with %s', (kind) => {
    const factory = new DiskFactory(kind, fake);
    const presigns = kind === 'S3Disk';
    let ctx: FilesApp;
    const http = () => request(ctx.app.getHttpServer());

    const uploadPrivate = async (file: Buffer, filename: string): Promise<string> => {
      const res = await http().post('/private').attach('docs', file, { filename }).expect(201);
      return res.body[0].key;
    };
    const signedUrl = async (key: string, query: Record<string, string> = {}): Promise<string> => {
      const res = await http().get('/signed-url/private').query({ key, ...query }).expect(200);
      return clientUrl(res.body.url, ctx.url);
    };
    const signedUpload = async (body: { key: string; contentType: string; contentLength?: number }) => {
      const res = await http().post('/signed-upload/private').send(body).expect(201);
      return res.body as { url: string; method: string; headers: Record<string, string>; expiresAt: string };
    };
    /** The headers a client sends; fetch sets Content-Length itself, from the body. */
    const sendable = (headers: Record<string, string>) => {
      const { 'content-length': _, ...rest } = headers;
      return rest;
    };
    /** The fake S3 records the requests it refused; the ones a test expects are cleared. */
    const refusedByStore = (reason: string) => {
      if (presigns) {
        expect(fake.signatureFailures.some((failure) => failure.startsWith(reason))).toBe(true);
        fake.signatureFailures.length = 0;
      }
    };

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

    it('a signed download URL works from a plain HTTP client, with the signed file name and ranges', async () => {
      const key = await uploadPrivate(PDF, 'invoice.pdf');
      const url = await signedUrl(key, { filename: 'Invoice 7.pdf' });
      expect(url.startsWith(presigns ? fake.ipEndpoint : `${ctx.url}/signed?`)).toBe(true);

      const { res, body } = await fetchBytes(url);
      expect(res.status).toBe(200);
      expect(body).toEqual(PDF);
      expect(res.headers.get('content-type')).toBe('application/pdf');
      expect(res.headers.get('content-disposition')).toBe('attachment; filename="Invoice 7.pdf"');

      const part = await fetchBytes(url, { headers: { range: 'bytes=0-3' } });
      expect(part.res.status).toBe(206);
      expect(part.body.toString()).toBe('%PDF');
    });

    it('signs an inline disposition', async () => {
      const key = await uploadPrivate(PNG, 'photo.png');
      const { res, body } = await fetchBytes(await signedUrl(key, { filename: 'photo.png', inline: '1' }));
      expect(body).toEqual(PNG);
      expect(res.headers.get('content-disposition')).toBe('inline; filename="photo.png"');
    });

    it('refuses a URL that was tampered with or has expired (403)', async () => {
      const first = await uploadPrivate(PDF, 'one.pdf');
      const second = await uploadPrivate(PDF, 'two.pdf');

      const tampered = (await signedUrl(first)).replace(first, second);
      expect((await fetch(tampered)).status).toBe(403);
      refusedByStore('signature mismatch');

      vi.useFakeTimers({ toFake: ['Date'], now: Date.now() - 3_600_000 });
      let expired: string;
      try {
        expired = await signedUrl(first, { expiresIn: '5m' });
      } finally {
        vi.useRealTimers();
      }
      expect((await fetch(expired)).status).toBe(403);
      refusedByStore('expired');
    });

    it('a signed upload URL takes the exact bytes from a plain HTTP client, and the app then serves them', async () => {
      const upload = await signedUpload({ key: 'incoming/photo.png', contentType: 'image/png', contentLength: PNG.length });
      expect(upload).toMatchObject({ method: 'PUT', headers: { 'content-type': 'image/png' } });
      expect(new Date(upload.expiresAt).getTime()).toBeGreaterThan(Date.now());

      const put = await fetch(clientUrl(upload.url, ctx.url), { method: upload.method, headers: sendable(upload.headers), body: PNG });
      expect(put.status).toBe(200);
      expect(put.headers.get('etag')).toMatch(/^".+"$/);

      const { res, body } = await fetchBytes(`${ctx.url}/files/private?key=incoming%2Fphoto.png`);
      expect(res.status).toBe(200);
      expect(body).toEqual(PNG);
      expect(res.headers.get('content-type')).toBe('image/png');
    });

    it('a signed upload refuses another type or another length, and stores nothing', async () => {
      const upload = await signedUpload({ key: 'incoming/strict.png', contentType: 'image/png', contentLength: PNG.length });
      const url = clientUrl(upload.url, ctx.url);

      const wrongType = await fetch(url, { method: 'PUT', headers: { 'content-type': 'text/html' }, body: PNG });
      expect(wrongType.status).toBe(403);
      refusedByStore('signature mismatch');

      const wrongLength = await fetch(url, { method: 'PUT', headers: sendable(upload.headers), body: Buffer.concat([PNG, PNG]) });
      expect(wrongLength.status).toBe(403);
      refusedByStore('signature mismatch');

      expect((await http().get('/exists/private').query({ key: 'incoming/strict.png' })).body).toEqual({ exists: false });
    });

    it('a signed download URL does not upload, and an upload URL does not download', async () => {
      const key = await uploadPrivate(PDF, 'fixed.pdf');
      const download = await signedUrl(key);
      const overwrite = await fetch(download, { method: 'PUT', headers: { 'content-type': 'application/pdf' }, body: HTML });
      expect(overwrite.status).toBe(403);
      refusedByStore('signature mismatch');

      const upload = await signedUpload({ key: 'incoming/never.pdf', contentType: 'application/pdf' });
      expect((await fetch(clientUrl(upload.url, ctx.url))).status).toBe(403);
      refusedByStore('signed header content-type missing');

      const kept = await fetchBytes(`${ctx.url}/files/private?key=${encodeURIComponent(key)}`);
      expect(kept.body).toEqual(PDF);
    });

    it('hands out an upload URL, checks the uploaded bytes, and moves only an image onto the public disk', async () => {
      const image = await signedUpload({ key: 'incoming/photo-1', contentType: 'image/png', contentLength: PNG.length });
      await fetch(clientUrl(image.url, ctx.url), { method: 'PUT', headers: sendable(image.headers), body: PNG }).then((res) => expect(res.status).toBe(200));

      const done = await http().post('/photos/complete').send({ key: 'incoming/photo-1' }).expect(201);
      expect(done.body).toEqual({ key: expect.stringMatching(/^photos\/[0-9a-f-]{36}\.png$/), url: `${PUBLIC_URL}/${done.body.key}` });
      const served = await fetchBytes(`${ctx.url}/files/public?key=${encodeURIComponent(done.body.key)}&inline=1`);
      expect(served.body).toEqual(PNG);
      expect(served.res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      expect((await http().get('/exists/private').query({ key: 'incoming/photo-1' })).body).toEqual({ exists: false });

      // The client claimed an image, and sent a page
      const lie = await signedUpload({ key: 'incoming/photo-2', contentType: 'image/png', contentLength: HTML.length });
      await fetch(clientUrl(lie.url, ctx.url), { method: 'PUT', headers: sendable(lie.headers), body: HTML }).then((res) => expect(res.status).toBe(200));
      await http().post('/photos/complete').send({ key: 'incoming/photo-2' }).expect(415);
      expect((await http().get('/exists/private').query({ key: 'incoming/photo-2' })).body).toEqual({ exists: false });

      await http().post('/photos/complete').send({ key: 'incoming/photo-3' }).expect(404);
    });

    it.runIf(presigns)("the app's own signed-URL routes answer 404 for a disk that presigns elsewhere", async () => {
      await http().get('/signed').query({ key: 'anything.pdf', expires: '9999999999', signature: 'x' }).expect(404);
      await http().put('/signed').query({ key: 'anything.pdf' }).set('content-type', 'application/pdf').send(PDF).expect(404);
    });

    it.runIf(!presigns)('refuses a signed upload of a type the adapter parses before the handler (400), and stores nothing', async () => {
      const upload = await signedUpload({ key: 'incoming/data.json', contentType: 'application/json' });
      const res = await fetch(clientUrl(upload.url, ctx.url), { method: 'PUT', headers: sendable(upload.headers), body: '{"a":1}' });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { message: string }).message).toBe('The upload body was already parsed; signed uploads need the raw request body');
      expect((await http().get('/exists/private').query({ key: 'incoming/data.json' })).body).toEqual({ exists: false });
    });

    it.runIf(!presigns)('refuses an upload over maxSize when the URL was signed without a length (413)', async () => {
      const upload = await signedUpload({ key: 'incoming/unsized.bin', contentType: 'application/octet-stream' });
      const url = clientUrl(upload.url, ctx.url);
      const tooBig = await fetch(url, { method: 'PUT', headers: sendable(upload.headers), body: Buffer.alloc(MiB + 1) });
      expect(tooBig.status).toBe(413);

      const fits = await fetch(url, { method: 'PUT', headers: sendable(upload.headers), body: Buffer.alloc(1024, 1) });
      expect(fits.status).toBe(200);
      expect((await http().get('/stat/private').query({ key: 'incoming/unsized.bin' })).body).toMatchObject({ size: 1024 });
    });
  });
});
