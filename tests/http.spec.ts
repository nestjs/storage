/**
 * The HTTP pieces on both adapters: `uploadToDisk()` behind platform-express's multer
 * interceptors and behind `@nestjs/platform-fastify/multipart`'s interceptors, `serveFile()`,
 * and the app-served signed URL handlers.
 */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import multipart from '@fastify/multipart';
import {
  Controller,
  Get,
  type INestApplication,
  Module,
  type NestInterceptor,
  Post,
  Put,
  Query,
  Req,
  Res,
  type Type,
  UploadedFile,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import * as express from '@nestjs/platform-express';
import request from 'supertest';
import { type AdapterName, adapters, createApp } from './support/adapters.js';
import * as fastify from '@nestjs/platform-fastify/multipart';
import {
  InjectDisk,
  InMemoryDisk,
  LocalDisk,
  receiveSignedUpload,
  serveFile,
  serveSignedUrl,
  StorageDisk,
  StorageModule,
  type StoredUpload,
  uploadToDisk,
} from '../lib/index.js';

interface UploadApi {
  FileInterceptor(field: string, options?: any): Type<NestInterceptor>;
  FilesInterceptor(field: string, maxCount?: number, options?: any): Type<NestInterceptor>;
}
const apis: Record<AdapterName, UploadApi> = { express, fastify };

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const PDF = Buffer.from('%PDF-1.7\n% invoice\n');
const HTML = Buffer.from('<html><script>alert(document.cookie)</script></html>');
const LIMIT = 64 * 1024;
const bigPng = () => Buffer.concat([PNG, Buffer.alloc(LIMIT, 7)]);

const roots: string[] = [];
afterAll(() => roots.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function createControllers(api: UploadApi) {
  @Controller()
  class UploadsController {
    constructor(
      @InjectDisk('covers') private readonly covers: StorageDisk,
      @InjectDisk('private') private readonly privateDisk: StorageDisk,
    ) {}

    @Post('covers')
    @UseInterceptors(
      api.FileInterceptor('cover', {
        storage: uploadToDisk({
          disk: 'covers',
          contentTypes: ['image/png', 'image/jpeg'],
          // A fixed key for one file name, to check a failed upload never replaces a file
          key: (file) => (file.originalname === 'fixed.png' ? 'covers/fixed.png' : `covers/${crypto.randomUUID()}${file.extension}`),
          cacheControl: 'public, max-age=31536000, immutable',
          metadata: (file) => ({ field: file.fieldname }),
        }),
        limits: { fileSize: LIMIT },
      }),
    )
    uploadCover(@UploadedFile() file: StoredUpload) {
      return file;
    }

    @Post('documents')
    @UseInterceptors(api.FilesInterceptor('docs', 3, { storage: uploadToDisk({ disk: 'private', key: (f) => `docs/${f.originalname}` }), limits: { fileSize: 1000 } }))
    uploadDocuments(@UploadedFiles() files: StoredUpload[]) {
      return files.map((file) => ({ key: file.key, contentType: file.contentType, size: file.size }));
    }

    @Post('anything')
    @UseInterceptors(api.FileInterceptor('file', { storage: uploadToDisk() }))
    uploadAnything(@UploadedFile() file: StoredUpload) {
      return file;
    }

    @Get('covers')
    cover(@Query('key') key: string, @Req() req: unknown, @Res({ passthrough: true }) res: unknown) {
      return serveFile(this.covers, key, { req, res, disposition: 'inline' });
    }

    @Get('download')
    download(@Query('key') key: string, @Req() req: unknown, @Res({ passthrough: true }) res: unknown) {
      return serveFile(this.privateDisk, key, { req, res, filename: 'Rechnung März.pdf' });
    }

    @Get('files')
    signedDownload(@Req() req: unknown, @Res({ passthrough: true }) res: unknown) {
      return serveSignedUrl(this.privateDisk, { req, res });
    }

    @Put('files')
    signedUpload(@Req() req: unknown, @Res({ passthrough: true }) res: unknown) {
      return receiveSignedUpload(this.privateDisk, { req, res, maxSize: 1000 });
    }
  }
  return UploadsController;
}

describe.each(adapters.map((a) => a.name))('on %s', (adapter) => {
  let app: INestApplication;
  let covers: LocalDisk;
  let privateDisk: LocalDisk;
  let coversRoot: string;
  let privateRoot: string;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    coversRoot = mkdtempSync(join(tmpdir(), 'covers-'));
    privateRoot = mkdtempSync(join(tmpdir(), 'private-'));
    roots.push(coversRoot, privateRoot);
    covers = new LocalDisk({ root: coversRoot });
    privateDisk = new LocalDisk({ root: privateRoot, signedUrls: { baseUrl: 'http://placeholder/files', keys: ['s'.repeat(32)] } });

    @Module({
      imports: [StorageModule.forRoot({ default: 'private', disks: { covers, private: privateDisk } })],
      controllers: [createControllers(apis[adapter])],
    })
    class AppModule {}

    app = await createApp(adapter, AppModule, {
      setup: async (instance) => {
        instance.useLogger(false); // the 500s and aborted requests below are expected
        if (adapter === 'fastify') {
          const server = instance.getHttpAdapter().getInstance();
          await server.register(multipart);
          server.addContentTypeParser('*', (_req: unknown, _payload: unknown, done: (e: null) => void) => done(null));
        }
      },
    });
  });
  afterAll(() => app?.close());

  const files = (root: string) => readdirSync(root, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name).slice(root.length + 1)).sort();
  const noTempFiles = () => {
    expect(readdirSync(join(coversRoot, '.nest-storage', 'tmp'))).toEqual([]);
    expect(readdirSync(join(privateRoot, '.nest-storage', 'tmp'))).toEqual([]);
  };
  afterEach(noTempFiles);

  describe('uploadToDisk()', () => {
    it('streams an upload into the named disk, typed by its bytes', async () => {
      const res = await http().post('/covers').attach('cover', PNG, { filename: 'photo.png', contentType: 'image/png' }).expect(201);

      expect(res.body).toMatchObject({
        fieldname: 'cover',
        originalname: 'photo.png',
        mimetype: 'image/png',
        size: PNG.length,
        disk: 'covers',
        contentType: 'image/png',
        key: expect.stringMatching(/^covers\/[0-9a-f-]{36}\.png$/),
        etag: expect.any(String),
      });
      expect(await covers.getBuffer(res.body.key)).toEqual(PNG);
      expect(await covers.stat(res.body.key)).toMatchObject({ cacheControl: 'public, max-age=31536000, immutable', metadata: { field: 'cover' } });
    });

    it('refuses a file whose bytes are not an allowed type, whatever it claims (415), before writing', async () => {
      const before = files(coversRoot);
      const res = await http().post('/covers').attach('cover', HTML, { filename: 'cute.png', contentType: 'image/png' }).expect(415);
      expect(res.body).toEqual({ message: 'File type not allowed. Allowed types: image/png, image/jpeg', error: 'Unsupported Media Type', statusCode: 415 });
      expect(files(coversRoot)).toEqual(before);
    });

    it('refuses a file over limits.fileSize (413) without replacing the file at its key', async () => {
      await covers.put('covers/fixed.png', PNG);
      const res = await http().post('/covers').attach('cover', bigPng(), { filename: 'fixed.png', contentType: 'image/png' }).expect(413);
      expect(res.body.message).toBe('File too large');
      expect(await covers.getBuffer('covers/fixed.png')).toEqual(PNG);
    });

    it('accepts a file of exactly limits.fileSize', async () => {
      const exact = Buffer.concat([PNG, Buffer.alloc(LIMIT - PNG.length, 1)]);
      const res = await http().post('/covers').attach('cover', exact, { filename: 'exact.png' }).expect(201);
      expect(res.body.size).toBe(LIMIT);
    });

    it('deletes files it stored when a later file fails the request', async () => {
      const res = await http()
        .post('/documents')
        .attach('docs', PDF, { filename: 'a.pdf' })
        .attach('docs', Buffer.alloc(2000, 1), { filename: 'b.bin' })
        .expect(413);

      expect(res.body.message).toBe('File too large');
      expect(await privateDisk.exists('docs/a.pdf')).toBe(false);
      expect(await privateDisk.exists('docs/b.bin')).toBe(false);
    });

    it('stores several files, and a file in an unexpected field fails the request and is removed', async () => {
      const ok = await http().post('/documents').attach('docs', PDF, { filename: 'one.pdf' }).attach('docs', Buffer.from('plain'), { filename: 'two.txt' }).expect(201);
      expect(ok.body).toEqual([
        { key: 'docs/one.pdf', contentType: 'application/pdf', size: PDF.length },
        // Not a known type: stored as octet-stream, never as the client's text/plain
        { key: 'docs/two.txt', contentType: 'application/octet-stream', size: 5 },
      ]);

      const bad = await http().post('/documents').attach('docs', PDF, { filename: 'three.pdf' }).attach('other', PDF, { filename: 'x.pdf' }).expect(400);
      expect(bad.body.message).toBe('Unexpected file field - other');
      expect(await privateDisk.exists('docs/three.pdf')).toBe(false);
    });

    it('never stores the type a client declares', async () => {
      const res = await http().post('/anything').attach('file', HTML, { filename: 'page.html', contentType: 'text/html' }).expect(201);
      expect(res.body).toMatchObject({ contentType: 'application/octet-stream', key: expect.stringMatching(/^[0-9a-f-]{36}$/) });
      expect((await privateDisk.stat(res.body.key)).contentType).toBe('application/octet-stream');
    });

    it('stores nothing when the client disconnects mid-upload', async () => {
      const before = files(coversRoot);
      const boundary = 'x-boundary';

      await new Promise<void>((resolve) => {
        const req = httpRequest(`${new URL(app.getHttpServer().address() ? `http://127.0.0.1:${app.getHttpServer().address().port}` : '')}covers`, {
          method: 'POST',
          headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(1_000_000) },
        });
        req.on('error', () => resolve());
        req.write(`--${boundary}\r\nContent-Disposition: form-data; name="cover"; filename="cut.png"\r\nContent-Type: image/png\r\n\r\n`);
        req.write(PNG);
        req.write(Buffer.alloc(20_000, 3));
        setTimeout(() => {
          req.destroy();
          resolve();
        }, 100);
      });

      // Wait until the server noticed and cleaned up
      for (let i = 0; i < 50 && readdirSync(join(coversRoot, '.nest-storage', 'tmp')).length > 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(files(coversRoot)).toEqual(before);
    });
  });

  describe('serveFile()', () => {
    beforeAll(async () => {
      await covers.put('site/cover.png', PNG, { cacheControl: 'public, max-age=60' });
      await covers.put('site/page.html', HTML);
      await privateDisk.put('invoices/INV-1.pdf', PDF);
    });

    it('streams a file with its type, length, validators and nosniff', async () => {
      const res = await http().get('/covers').query({ key: 'site/cover.png' }).buffer(true).parse(binary).expect(200);

      expect(res.body).toEqual(PNG);
      expect(res.headers).toMatchObject({
        'content-type': 'image/png',
        'content-length': String(PNG.length),
        'content-disposition': 'inline; filename="cover.png"',
        'x-content-type-options': 'nosniff',
        'accept-ranges': 'bytes',
        'cache-control': 'public, max-age=60',
        etag: expect.stringMatching(/^".+"$/),
        'last-modified': expect.any(String),
      });
    });

    it('sends a type that could run script as an attachment, even when inline was asked for', async () => {
      const res = await http().get('/covers').query({ key: 'site/page.html' }).expect(200);
      expect(res.headers['content-disposition']).toBe('attachment; filename="page.html"');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    it('keeps a file without a stored Cache-Control out of shared caches', async () => {
      const res = await http().get('/covers').query({ key: 'site/page.html' }).expect(200);
      expect(res.headers['cache-control']).toBe('private');
    });

    it('releases the file when the client disconnects mid-download', async () => {
      await covers.put('site/big.bin', Buffer.alloc(8 * 1024 * 1024, 1));
      const bodies: Readable[] = [];
      const get = covers.get.bind(covers);
      const spy = vi.spyOn(covers, 'get').mockImplementation(async (...args) => {
        const download = await get(...args);
        bodies.push(download.body);
        return download;
      });

      try {
        const port = (app.getHttpServer().address() as { port: number }).port;
        await new Promise<void>((resolve) => {
          const req = httpRequest(`http://127.0.0.1:${port}/covers?key=site%2Fbig.bin`, (res) => {
            res.once('data', () => {
              req.destroy();
              resolve();
            });
          });
          req.on('error', () => resolve());
          req.end();
        });

        for (let i = 0; i < 100 && !bodies[0]?.destroyed; i++) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }

        expect(bodies).toHaveLength(1);
        expect(bodies[0].destroyed).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });

    it('names downloads safely', async () => {
      const res = await http().get('/download').query({ key: 'invoices/INV-1.pdf' }).expect(200);
      expect(res.headers['content-disposition']).toBe(`attachment; filename="Rechnung M_rz.pdf"; filename*=UTF-8''Rechnung%20M%C3%A4rz.pdf`);
    });

    it('answers a range with 206 and Content-Range', async () => {
      const res = await http().get('/covers').query({ key: 'site/cover.png' }).set('range', 'bytes=1-3').buffer(true).parse(binary).expect(206);
      expect(res.body.toString('latin1')).toBe('PNG');
      expect(res.headers).toMatchObject({ 'content-range': `bytes 1-3/${PNG.length}`, 'content-length': '3' });
      const suffix = await http().get('/covers').query({ key: 'site/cover.png' }).set('range', 'bytes=-4').buffer(true).parse(binary).expect(206);
      expect(suffix.body).toEqual(PNG.subarray(-4));
    });

    it('answers an unsatisfiable range with 416 and the size', async () => {
      const res = await http().get('/covers').query({ key: 'site/cover.png' }).set('range', `bytes=${PNG.length}-`).expect(416);
      expect(res.headers['content-range']).toBe(`bytes */${PNG.length}`);
    });

    it('ignores several ranges or a malformed one, and a range for another version', async () => {
      for (const range of ['bytes=0-1,4-5', 'bytes=abc', 'items=0-1']) {
        await http().get('/covers').query({ key: 'site/cover.png' }).set('range', range).expect(200);
      }

      await http().get('/covers').query({ key: 'site/cover.png' }).set('range', 'bytes=0-1').set('if-range', '"old"').expect(200);
      const { headers } = await http().get('/covers').query({ key: 'site/cover.png' });
      await http().get('/covers').query({ key: 'site/cover.png' }).set('range', 'bytes=0-1').set('if-range', headers.etag).expect(206);
    });

    it('answers If-None-Match with 304', async () => {
      const { headers } = await http().get('/covers').query({ key: 'site/cover.png' });
      const res = await http().get('/covers').query({ key: 'site/cover.png' }).set('if-none-match', headers.etag).expect(304);
      expect(res.headers.etag).toBe(headers.etag);
      expect(res.text ?? '').toBe('');
    });

    it('is a 404 for a missing file or a key that is not a key', async () => {
      for (const key of ['site/missing.png', '../../etc/passwd', 'a//b', '']) {
        const res = await http().get('/covers').query({ key }).expect(404);
        expect(res.body).toEqual({ message: 'Not Found', statusCode: 404 });
      }
    });
  });

  describe('app-served signed URLs', () => {
    const local = (url: string) => {
      const parsed = new URL(url);
      return `${parsed.pathname}${parsed.search}`;
    };

    beforeAll(() => privateDisk.put('invoices/INV-2.pdf', PDF));

    it('serves a file behind a signed URL, with the signed file name', async () => {
      const url = await privateDisk.signedUrl('invoices/INV-2.pdf', { filename: 'invoice-2.pdf', expiresIn: '1m' });
      const res = await http().get(local(url)).buffer(true).parse(binary).expect(200);

      expect(res.body).toEqual(PDF);
      expect(res.headers).toMatchObject({
        'content-type': 'application/pdf',
        'content-disposition': 'attachment; filename="invoice-2.pdf"',
        'x-content-type-options': 'nosniff',
      });

      await http().get(local(url)).set('range', 'bytes=0-3').expect(206);
    });

    it('names the download after the key, and keeps it private, when the URL was signed without a file name', async () => {
      const url = await privateDisk.signedUrl('invoices/INV-2.pdf');
      const res = await http().get(local(url)).expect(200);
      expect(res.headers['content-disposition']).toBe('attachment; filename="INV-2.pdf"');
      expect(res.headers['cache-control']).toBe('private');
    });

    it('refuses a tampered, expired or re-purposed URL (403)', async () => {
      const url = local(await privateDisk.signedUrl('invoices/INV-2.pdf'));
      const tampered = url.replace('INV-2', 'INV-1');

      expect((await http().get(tampered).expect(403)).body.message).toBe('Invalid signed URL');
      await http().get(url.replace(/expires=\d+/, 'expires=9999999999')).expect(403);
      await http().get('/files?key=invoices%2FINV-2.pdf').expect(403);

      const upload = await privateDisk.signedUpload('invoices/INV-2.pdf', { contentType: 'application/pdf' });
      expect((await http().get(local(upload.url)).expect(403)).body.message).toBe('Invalid signed URL');

      vi.useFakeTimers({ toFake: ['Date'], now: Date.now() - 3_600_000 });
      const old = local(await privateDisk.signedUrl('invoices/INV-2.pdf', { expiresIn: '5m' }));
      vi.useRealTimers();
      expect((await http().get(old).expect(403)).body.message).toBe('The signed URL has expired');
    });

    it('receives an upload to a signed URL, the way S3 does', async () => {
      const upload = await privateDisk.signedUpload('incoming/photo-1', { contentType: 'image/png', contentLength: PNG.length });
      const res = await http().put(local(upload.url)).set(upload.headers).send(PNG).expect(200);
      expect(res.body).toMatchObject({ key: 'incoming/photo-1', size: PNG.length, contentType: 'image/png' });
      expect(res.headers.etag).toBe(res.body.etag);
      expect(await privateDisk.getBuffer('incoming/photo-1')).toEqual(PNG);
    });

    it('refuses an upload with another type or length, or over maxSize', async () => {
      const upload = await privateDisk.signedUpload('incoming/photo-2', { contentType: 'image/png', contentLength: PNG.length });
      await http().put(local(upload.url)).set('content-type', 'text/html').send(PNG).expect(403);
      await http().put(local(upload.url)).set(upload.headers).send(Buffer.concat([PNG, PNG])).expect(403);

      const unsized = await privateDisk.signedUpload('incoming/photo-3', { contentType: 'image/png' });
      await http().put(local(unsized.url)).set(unsized.headers).send(Buffer.alloc(1001)).expect(413);
      await http().put(local(unsized.url)).set(unsized.headers).send(Buffer.alloc(1000)).expect(200);
      expect(await privateDisk.exists('incoming/photo-2')).toBe(false);
    });
  });
});

describe('uploadToDisk() without StorageModule', () => {
  it.each(adapters.map((a) => a.name))('on %s: a disk instance works; a name explains what is missing', async (adapter) => {
    const disk = new InMemoryDisk();
    const api = apis[adapter];

    @Controller()
    class BareController {
      @Post('instance')
      @UseInterceptors(api.FileInterceptor('file', { storage: uploadToDisk({ disk }) }))
      instance(@UploadedFile() file: StoredUpload) {
        return { key: file.key };
      }
      @Post('named')
      @UseInterceptors(api.FileInterceptor('file', { storage: uploadToDisk({ disk: 'covers' }) }))
      named() {}
    }
    @Module({ controllers: [BareController] })
    class BareModule {}

    const app = await createApp(adapter, BareModule, {
      setup: async (instance) => {
        instance.useLogger(false);
        if (adapter === 'fastify') {
          await instance.getHttpAdapter().getInstance().register(multipart);
        }
      },
    });

    try {
      const res = await request(app.getHttpServer()).post('/instance').attach('file', PDF, { filename: 'a.pdf' }).expect(201);
      expect(disk.keys()).toEqual([res.body.key]);
      await request(app.getHttpServer()).post('/named').attach('file', PDF, { filename: 'a.pdf' }).expect(500);
    } finally {
      await app.close();
    }
  });
});

function binary(res: any, callback: (error: Error | null, body: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
}
