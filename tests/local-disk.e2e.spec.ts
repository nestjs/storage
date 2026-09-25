/**
 * A LocalDisk behind a controller on both adapters: a copy or move to another extension serves
 * the type the file was stored with, and `path()` refuses a key that would lead outside the root.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BadRequestException, Controller, Get, type INestApplication, Module, Post, Query, Req, Res } from '@nestjs/common';
import request from 'supertest';
import { adapters, createApp } from './support/adapters.js';
import { InjectDisk, LocalDisk, serveFile, StorageDisk, StorageInvalidKeyError, StorageModule } from '../lib/index.js';

@Controller()
class FilesController {
  constructor(@InjectDisk() private readonly disk: StorageDisk) {}

  @Post('copy')
  copy(@Query('from') from: string, @Query('to') to: string) {
    return this.disk.copy(from, to);
  }

  @Post('move')
  move(@Query('from') from: string, @Query('to') to: string) {
    return this.disk.move(from, to);
  }

  @Get('files')
  serve(@Query('key') key: string, @Req() req: unknown, @Res({ passthrough: true }) res: unknown) {
    return serveFile(this.disk, key, { req, res });
  }

  @Get('path')
  path(@Query('key') key: string) {
    try {
      return { path: (this.disk as LocalDisk).path(key) };
    } catch (error) {
      if (error instanceof StorageInvalidKeyError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }
}

describe.each(adapters.map((a) => a.name))('LocalDisk over HTTP on %s', (adapter) => {
  let app: INestApplication;
  let root: string;
  let disk: LocalDisk;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'local-disk-e2e-'));
    disk = new LocalDisk({ root });

    @Module({
      imports: [StorageModule.forRoot({ default: 'files', disks: { files: disk } })],
      controllers: [FilesController],
    })
    class AppModule {}

    app = await createApp(adapter, AppModule, { setup: (app) => app.useLogger(false) });
  });
  afterAll(async () => {
    await app?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('serves a copy to another extension with the type it was stored with', async () => {
    await disk.put('photo.jpg', 'jpeg bytes');

    const copied = await http().post('/copy').query({ from: 'photo.jpg', to: 'photo.png' }).expect(201);
    const served = await http().get('/files').query({ key: 'photo.png' }).expect(200);

    expect(copied.body.contentType).toBe('image/jpeg');
    expect(served.headers['content-type']).toBe('image/jpeg');
    expect((await disk.stat('photo.jpg')).contentType).toBe('image/jpeg');
  });

  it('serves a moved file with the type it was stored with', async () => {
    await disk.put('scan.pdf', '%PDF-1.7');

    const moved = await http().post('/move').query({ from: 'scan.pdf', to: 'scan.bin' }).expect(201);
    const served = await http().get('/files').query({ key: 'scan.bin' }).expect(200);

    expect(moved.body.contentType).toBe('application/pdf');
    expect(served.headers['content-type']).toBe('application/pdf');
  });

  it('keeps an explicit type, and infers from the new key once they agree', async () => {
    await disk.put('upload.bin', 'png bytes', { contentType: 'image/png' });

    const toPng = await http().post('/copy').query({ from: 'upload.bin', to: 'photo.png' }).expect(201);
    const toDat = await http().post('/copy').query({ from: 'upload.bin', to: 'photo.dat' }).expect(201);

    expect(toPng.body.contentType).toBe('image/png');
    expect(toDat.body.contentType).toBe('image/png');
    expect((await disk.stat('photo.png')).contentType).toBe('image/png');
    expect((await disk.stat('photo.dat')).contentType).toBe('image/png');
  });

  it('path() answers 400 for a key that would lead outside the root', async () => {
    for (const key of ['../../etc/passwd', '/etc/passwd', 'a//b', 'a/./b']) {
      await http().get('/path').query({ key }).expect(400);
    }
  });

  it('path() returns a path inside the root for a valid key', async () => {
    const res = await http().get('/path').query({ key: 'avatars/u1.png' }).expect(200);
    expect(res.body.path).toBe(join(realpathSync(root), 'avatars', 'u1.png'));
  });
});
