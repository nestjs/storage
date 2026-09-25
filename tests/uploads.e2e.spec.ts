/**
 * `uploadToDisk()` behind platform-express's multer interceptors and
 * `@nestjs/platform-fastify/multipart`'s, on in-memory disks: file counts, keys and metadata
 * built from the request, keys and disk names that don't work, and several applications in
 * one process each finding their own disks.
 */
import multipart from '@fastify/multipart';
import { Controller, type INestApplication, Module, type NestInterceptor, Post, Req, type Type, UploadedFile, UploadedFiles, UseInterceptors } from '@nestjs/common';
import * as express from '@nestjs/platform-express';
import * as fastify from '@nestjs/platform-fastify/multipart';
import request from 'supertest';
import { type AdapterName, adapters, createApp } from './support/adapters.js';
import { InMemoryDisk, StorageModule, type StoredUpload, uploadToDisk } from '../lib/index.js';

interface UploadApi {
  FileInterceptor(field: string, options?: any): Type<NestInterceptor>;
  FilesInterceptor(field: string, maxCount?: number, options?: any): Type<NestInterceptor>;
}
const apis: Record<AdapterName, UploadApi> = { express, fastify };

const PDF = Buffer.from('%PDF-1.7\n% upload\n');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 1)]);

function createController(api: UploadApi) {
  @Controller()
  class UploadsController {
    @Post('batch')
    @UseInterceptors(api.FilesInterceptor('files', 2, { storage: uploadToDisk({ key: (file) => `batch/${file.originalname}` }) }))
    batch(@UploadedFiles() files: StoredUpload[]) {
      return files.map((file) => file.key);
    }

    @Post('tenant')
    @UseInterceptors(
      api.FileInterceptor('file', {
        storage: uploadToDisk({
          disk: 'tenants',
          key: async (file, req) => `${req.headers['x-tenant']}/${file.fieldname}${file.extension || '.bin'}`,
          metadata: (file, req) => ({
            tenant: String(req.headers['x-tenant']),
            detected: file.contentType ?? 'none',
            declared: file.mimetype,
          }),
        }),
      }),
    )
    tenant(@UploadedFile() file: StoredUpload, @Req() req: any) {
      return { key: file.key, disk: file.disk, tenant: req.headers['x-tenant'] };
    }

    @Post('pdf-only')
    @UseInterceptors(api.FileInterceptor('file', { storage: uploadToDisk({ contentTypes: ['application/pdf'], key: () => 'only.pdf' }) }))
    pdfOnly(@UploadedFile() file: StoredUpload) {
      return file;
    }

    @Post('bad-key')
    @UseInterceptors(api.FileInterceptor('file', { storage: uploadToDisk({ key: (file) => `../${file.originalname}` }) }))
    badKey() {}

    @Post('unknown-disk')
    @UseInterceptors(api.FileInterceptor('file', { storage: uploadToDisk({ disk: 'archive' }) }))
    unknownDisk() {}
  }
  return UploadsController;
}

async function boot(
  adapter: AdapterName,
  disks: { uploads: InMemoryDisk; tenants: InMemoryDisk },
  controller = createController(apis[adapter]),
): Promise<INestApplication> {
  @Module({
    imports: [StorageModule.forRoot({ default: 'uploads', disks })],
    controllers: [controller],
  })
  class AppModule {}

  return createApp(adapter, AppModule, {
    setup: async (app) => {
      app.useLogger(false);
      if (adapter === 'fastify') {
        await app.getHttpAdapter().getInstance().register(multipart);
      }
    },
  });
}

describe.each(adapters.map((a) => a.name))('uploads on %s', (adapter) => {
  let app: INestApplication;
  const uploads = new InMemoryDisk();
  const tenants = new InMemoryDisk();
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await boot(adapter, { uploads, tenants });
  });
  afterAll(() => app?.close());
  beforeEach(() => {
    uploads.clear();
    tenants.clear();
  });

  it('stores up to maxCount files onto the default disk', async () => {
    const res = await http().post('/batch').attach('files', PDF, { filename: 'a.pdf' }).attach('files', JPEG, { filename: 'b.jpg' }).expect(201);
    expect(res.body).toEqual(['batch/a.pdf', 'batch/b.jpg']);
    expect(uploads.keys()).toEqual(['batch/a.pdf', 'batch/b.jpg']);
  });

  it('refuses a file over maxCount and removes the files already stored', async () => {
    const res = await http()
      .post('/batch')
      .attach('files', PDF, { filename: 'a.pdf' })
      .attach('files', PDF, { filename: 'b.pdf' })
      .attach('files', PDF, { filename: 'c.pdf' });

    expect(res.status).toBe(400);
    expect(uploads.keys()).toEqual([]);
  });

  it('builds the key and the metadata from the request and the detected type', async () => {
    const res = await http().post('/tenant').set('x-tenant', 't1').attach('file', JPEG, { filename: 'x.png', contentType: 'image/png' }).expect(201);

    expect(res.body).toEqual({ key: 't1/file.jpg', disk: 'tenants', tenant: 't1' });
    expect(await tenants.stat('t1/file.jpg')).toMatchObject({
      contentType: 'image/jpeg',
      metadata: { tenant: 't1', detected: 'image/jpeg', declared: 'image/png' },
    });
    expect(uploads.keys()).toEqual([]);
  });

  it('a type it does not recognize gets no extension, and is stored as octet-stream', async () => {
    await http().post('/tenant').set('x-tenant', 'globex').attach('file', Buffer.from('plain text'), { filename: 'a.txt', contentType: 'text/plain' }).expect(201);

    expect(await tenants.stat('globex/file.bin')).toMatchObject({
      contentType: 'application/octet-stream',
      metadata: { detected: 'none', declared: 'text/plain' },
    });
  });

  it('refuses an empty file when only some types are allowed', async () => {
    await http().post('/pdf-only').attach('file', Buffer.alloc(0), { filename: 'empty.pdf', contentType: 'application/pdf' }).expect(415);
    await http().post('/pdf-only').attach('file', JPEG, { filename: 'a.pdf', contentType: 'application/pdf' }).expect(415);
    expect(uploads.keys()).toEqual([]);

    await http().post('/pdf-only').attach('file', PDF, { filename: 'a.pdf' }).expect(201);
    expect(uploads.keys()).toEqual(['only.pdf']);
  });

  it('a key() that builds an invalid key fails the request, and stores nothing', async () => {
    const res = await http().post('/bad-key').attach('file', PDF, { filename: 'escape.pdf' });
    expect(res.status).toBe(500);
    expect(uploads.keys()).toEqual([]);
  });

  it('a disk name the application does not configure fails the request', async () => {
    const res = await http().post('/unknown-disk').attach('file', PDF, { filename: 'a.pdf' });
    expect(res.status).toBe(500);
    expect([...uploads.keys(), ...tenants.keys()]).toEqual([]);
  });
});

describe('several applications in one process', () => {
  it('share one upload engine, each storing onto its own disks, also after another one closes', async () => {
    const shared = createController(apis.express);
    const first = { uploads: new InMemoryDisk(), tenants: new InMemoryDisk() };
    const second = { uploads: new InMemoryDisk(), tenants: new InMemoryDisk() };
    const one = await boot('express', first, shared);
    const two = await boot('express', second, shared);
    let oneOpen = true;

    try {
      await request(one.getHttpServer()).post('/batch').attach('files', PDF, { filename: 'one.pdf' }).expect(201);
      await request(two.getHttpServer()).post('/batch').attach('files', PDF, { filename: 'two.pdf' }).expect(201);

      expect(first.uploads.keys()).toEqual(['batch/one.pdf']);
      expect(second.uploads.keys()).toEqual(['batch/two.pdf']);

      await one.close();
      oneOpen = false;
      await request(two.getHttpServer()).post('/batch').attach('files', PDF, { filename: 'again.pdf' }).expect(201);
      expect(second.uploads.keys()).toEqual(['batch/again.pdf', 'batch/two.pdf']);
    } finally {
      if (oneOpen) {
        await one.close();
      }
      await two.close();
    }
  });
});
