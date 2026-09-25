/**
 * Shared pieces of the integration specs: a table of the three built-in disks (each on its own
 * backing store: memory, a temp directory, the fake S3), an app whose routes drive every feature
 * through real entrypoints, and a plain HTTP client for the URLs the disks hand out.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buffer } from 'node:stream/consumers';
import multipart from '@fastify/multipart';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  type INestApplication,
  Module,
  type NestInterceptor,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  type Type,
  UploadedFile,
  UnsupportedMediaTypeException,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import * as express from '@nestjs/platform-express';
import * as fastify from '@nestjs/platform-fastify/multipart';
import { type AdapterName, createApp } from './support/adapters.js';
import {
  detectContentType,
  InjectDisk,
  InMemoryDisk,
  LocalDisk,
  receiveSignedUpload,
  S3Disk,
  type S3DiskOptions,
  serveFile,
  serveSignedUrl,
  Storage,
  StorageDisk,
  StorageError,
  StorageModule,
  type StoredUpload,
  uploadToDisk,
} from '../lib/index.js';
import { ACCESS_KEY, FakeS3, SECRET_KEY } from './fake-s3.js';

export const MiB = 1024 * 1024;
export const SIGNING_KEY = 'integration-signing-key-0123456789abcdef';
/** The origin app-served signed URLs are issued under; the client sends them to the app instead. */
export const APP_ORIGIN = 'http://app.test';
export const PUBLIC_URL = 'https://cdn.test/public';

export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
export const PDF = Buffer.from('%PDF-1.7\n% integration\n');
export const HTML = Buffer.from('<html><script>alert(document.cookie)</script></html>');

export function bytes(size: number, seed = 1): Buffer {
  const data = Buffer.alloc(size);
  for (let i = 0; i < size; i++) {
    data[i] = (i * 31 + seed) & 0xff;
  }
  return data;
}

export type DiskKindName = 'InMemoryDisk' | 'LocalDisk' | 'S3Disk';

export interface DiskSpec {
  publicUrl?: string;
  /** App-served signed URLs under `${APP_ORIGIN}/signed`; ignored by S3, which presigns itself. */
  signed?: boolean;
  s3?: Partial<S3DiskOptions>;
}

/** Creates disks of one kind, and removes what they stored once the suite is done. */
export class DiskFactory {
  private readonly roots: string[] = [];

  constructor(
    readonly kind: DiskKindName,
    readonly fake: FakeS3,
  ) {}

  get diskClass(): typeof InMemoryDisk | typeof LocalDisk | typeof S3Disk {
    return { InMemoryDisk, LocalDisk, S3Disk }[this.kind];
  }

  /** Constructor options for a disk of this kind; a LocalDisk gets its own temp directory. */
  async options(name: string, spec: DiskSpec = {}): Promise<object> {
    const signedUrls = spec.signed ? { baseUrl: `${APP_ORIGIN}/signed`, keys: [SIGNING_KEY] } : undefined;

    if (this.kind === 'InMemoryDisk') {
      return { publicUrl: spec.publicUrl, signedUrls };
    }

    if (this.kind === 'LocalDisk') {
      const root = await mkdtemp(join(tmpdir(), `storage-it-${name}-`));
      this.roots.push(root);
      return { root, publicUrl: spec.publicUrl, signedUrls };
    }

    return {
      bucket: 'shop',
      region: 'eu-central-1',
      endpoint: this.fake.ipEndpoint,
      prefix: `${name}/`,
      credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
      publicUrl: spec.publicUrl,
      multipart: { partSize: 5 * MiB, concurrency: 2 },
      retry: { attempts: 3, backoff: { delay: 1, jitter: 'none' } },
      ...spec.s3,
    };
  }

  async create(name: string, spec: DiskSpec = {}): Promise<StorageDisk> {
    const Disk = this.diskClass as new (options: object) => StorageDisk;
    return new Disk(await this.options(name, spec));
  }

  async cleanup() {
    await Promise.all(this.roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  }
}

export const diskKinds: DiskKindName[] = ['InMemoryDisk', 'LocalDisk', 'S3Disk'];

interface UploadApi {
  FileInterceptor(field: string, options?: any): Type<NestInterceptor>;
  FilesInterceptor(field: string, maxCount?: number, options?: any): Type<NestInterceptor>;
}
export const uploadApis: Record<AdapterName, UploadApi> = { express, fastify };

/** A storage error with a status becomes that status; anything else reaches Nest as it is. */
function asHttp(error: unknown): never {
  const status = (error as { status?: unknown }).status;
  if (error instanceof StorageError && typeof status === 'number') {
    throw new HttpException(error.message, status);
  }
  throw error;
}

/**
 * The routes of an app with a `public` disk (product photos, served inline, public URLs) and a
 * `private` default disk (documents, signed URLs), plus generic routes that take a disk name.
 */
export function createFilesController(api: UploadApi): Type<unknown> {
  @Controller()
  class FilesController {
    constructor(
      private readonly storage: Storage,
      private readonly privateDisk: StorageDisk,
      @InjectDisk('public') private readonly publicDisk: StorageDisk,
    ) {}

    @Post('public')
    @UseInterceptors(
      api.FileInterceptor('file', {
        storage: uploadToDisk({
          disk: 'public',
          key: (file) => `uploads/${file.originalname}`,
          cacheControl: 'public, max-age=60',
          metadata: (file) => ({ original: encodeURIComponent(file.originalname) }),
        }),
        limits: { fileSize: 32 * MiB },
      }),
    )
    uploadPublic(@UploadedFile() file: StoredUpload) {
      return { ...file, url: this.publicDisk.url(file.key) };
    }

    @Post('private')
    @UseInterceptors(
      api.FilesInterceptor('docs', 3, {
        storage: uploadToDisk({ disk: 'private', contentTypes: ['application/pdf', 'image/png'] }),
        limits: { fileSize: 1024 },
      }),
    )
    uploadPrivate(@UploadedFiles() files: StoredUpload[]) {
      return files.map(({ key, size, contentType, disk }) => ({ key, size, contentType, disk }));
    }

    @Get('files/:disk')
    download(
      @Param('disk') disk: string,
      @Query('key') key: string,
      @Query('inline') inline: string | undefined,
      @Query('filename') filename: string | undefined,
      @Req() req: unknown,
      @Res({ passthrough: true }) res: unknown,
    ) {
      return serveFile(this.storage.disk(disk), key, { req, res, disposition: inline ? 'inline' : undefined, filename });
    }

    @Get('stat/:disk')
    stat(@Param('disk') disk: string, @Query('key') key: string) {
      return this.storage.disk(disk).stat(key).catch(asHttp);
    }

    @Get('exists/:disk')
    async exists(@Param('disk') disk: string, @Query('key') key: string) {
      return { exists: await this.storage.disk(disk).exists(key) };
    }

    @Get('list/:disk')
    list(@Param('disk') disk: string, @Query('prefix') prefix?: string, @Query('cursor') cursor?: string, @Query('limit') limit?: string) {
      return this.storage.disk(disk).list({ prefix, cursor, limit: limit === undefined ? undefined : Number(limit) }).catch(asHttp);
    }

    @Get('list-all/:disk')
    async listAll(@Param('disk') disk: string, @Query('prefix') prefix?: string) {
      const keys: string[] = [];
      for await (const entry of this.storage.disk(disk).listAll({ prefix })) {
        keys.push(entry.key);
      }
      return keys;
    }

    @Post('copy/:disk')
    copy(@Param('disk') disk: string, @Query('from') from: string, @Query('to') to: string) {
      return this.storage.disk(disk).copy(from, to).catch(asHttp);
    }

    @Post('move/:disk')
    move(@Param('disk') disk: string, @Query('from') from: string, @Query('to') to: string) {
      return this.storage.disk(disk).move(from, to).catch(asHttp);
    }

    @Post('move-unmapped/:disk')
    moveUnmapped(@Param('disk') disk: string, @Query('from') from: string, @Query('to') to: string) {
      return this.storage.disk(disk).move(from, to);
    }

    @Delete('files/:disk')
    async remove(@Param('disk') disk: string, @Query('keys') keys: string) {
      const list = keys.split(',');
      await this.storage.disk(disk).delete(list.length === 1 ? list[0] : list);
      return { deleted: list };
    }

    /** Publishes a private file: streams it from one disk to the other, with its metadata. */
    @Post('publish')
    async publish(@Query('key') key: string, @Query('as') as: string) {
      const source = await this.privateDisk.get(key).catch(asHttp);
      const written = await this.publicDisk.put(as, source.body, {
        contentType: source.contentType,
        contentLength: source.size,
        metadata: source.metadata,
        cacheControl: 'public, max-age=3600',
      });
      return { ...written, url: this.publicDisk.url(as) };
    }

    /**
     * The tutorial's direct-upload flow: the client chose the type it uploaded with, so the
     * first bytes decide, and only an image reaches the public disk.
     */
    @Post('photos/complete')
    async complete(@Body('key') key: string) {
      const file = await this.privateDisk.stat(key).catch(asHttp);
      const head = await this.privateDisk.get(key, { range: { start: 0, end: 15 } });
      const type = detectContentType(await buffer(head.body));
      if (type !== 'image/png' && type !== 'image/jpeg') {
        await this.privateDisk.delete(key);
        throw new UnsupportedMediaTypeException('A photo must be a PNG or a JPEG');
      }

      const photoKey = `photos/${randomUUID()}${type === 'image/png' ? '.png' : '.jpg'}`;
      const { body } = await this.privateDisk.get(key);
      await this.publicDisk.put(photoKey, body, { contentType: type, contentLength: file.size, cacheControl: 'public, max-age=31536000, immutable' });
      await this.privateDisk.delete(key);
      return { key: photoKey, url: this.publicDisk.url(photoKey) };
    }

    @Get('signed-url/:disk')
    async signedUrl(
      @Param('disk') disk: string,
      @Query('key') key: string,
      @Query('filename') filename?: string,
      @Query('inline') inline?: string,
      @Query('expiresIn') expiresIn?: string,
    ) {
      const url = await this.storage.disk(disk).signedUrl(key, {
        filename,
        disposition: inline ? 'inline' : undefined,
        expiresIn: (expiresIn as '1m') ?? '1m',
      });
      return { url };
    }

    @Post('signed-upload/:disk')
    signedUpload(@Param('disk') disk: string, @Body() body: { key: string; contentType: string; contentLength?: number }) {
      return this.storage.disk(disk).signedUpload(body.key, { contentType: body.contentType, contentLength: body.contentLength, expiresIn: '5m' });
    }

    @Get('signed')
    serveSigned(@Req() req: unknown, @Res({ passthrough: true }) res: unknown) {
      return serveSignedUrl(this.privateDisk, { req, res });
    }

    @Put('signed')
    receiveSigned(@Req() req: unknown, @Res({ passthrough: true }) res: unknown) {
      return receiveSignedUpload(this.privateDisk, { req, res, maxSize: MiB });
    }
  }
  return FilesController;
}

export interface FilesApp {
  app: INestApplication;
  url: string;
  publicDisk: StorageDisk;
  privateDisk: StorageDisk;
}

/** Boots the files app on one adapter, with a `public` and a `private` (default) disk, and any others. */
export async function bootFilesApp(
  adapter: AdapterName,
  disks: { public: StorageDisk; private: StorageDisk } & Record<string, StorageDisk>,
): Promise<FilesApp> {
  @Module({
    imports: [StorageModule.forRoot({ default: 'private', disks })],
    controllers: [createFilesController(uploadApis[adapter])],
  })
  class FilesModule {}

  const app = await createApp(adapter, FilesModule, { setup: (instance) => prepare(adapter, instance) });
  return { app, url: await app.getUrl(), publicDisk: disks.public, privateDisk: disks.private };
}

/** Quiet logs (the 4xx/5xx below are expected); on Fastify, multipart and raw bodies for signed uploads. */
export async function prepare(adapter: AdapterName, app: INestApplication) {
  app.useLogger(false);
  if (adapter === 'fastify') {
    const server = app.getHttpAdapter().getInstance();
    await server.register(multipart);
    server.addContentTypeParser('*', (_req: unknown, _payload: unknown, done: (error: null) => void) => done(null));
  }
}

/** Sends a URL a disk handed out: app-served ones go to the app, presigned S3 ones to the store. */
export function clientUrl(url: string, appUrl: string): string {
  const parsed = new URL(url);
  if (parsed.origin === APP_ORIGIN) {
    return `${appUrl}${parsed.pathname}${parsed.search}`;
  }
  return url;
}

export async function fetchBytes(url: string, init?: RequestInit) {
  const res = await fetch(url, init);
  return { res, body: Buffer.from(await res.arrayBuffer()) };
}

/** A fake S3 for the whole file, checked after every test for requests it refused as unsigned. */
export function useFakeS3(): FakeS3 {
  const fake = new FakeS3();
  beforeAll(() => fake.start());
  afterAll(() => fake.stop());
  afterEach(() => {
    expect(fake.signatureFailures).toEqual([]);
  });
  return fake;
}

/** Objects in the fake bucket under a disk's prefix, without it. */
export function storedKeys(fake: FakeS3, disk: string): string[] {
  const prefix = `shop/${disk}/`;
  return [...fake.objects.keys()].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length)).sort();
}
