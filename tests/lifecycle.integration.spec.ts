/**
 * How an app gets its disks, and lets them go, on both adapters and every built-in disk: an
 * async factory that picks the disks from configuration (the tutorial's shape), a disk class
 * Nest instantiates with an injected dependency, the README's testing recipe (overriding
 * STORAGE_MODULE_OPTIONS), shutdown closing each disk once, and two apps in one process
 * sharing the upload engine and each finding its own disks.
 */
import { Controller, type DynamicModule, Get, Inject, Injectable, Module } from '@nestjs/common';
import request from 'supertest';
import { type AdapterName, adapters, createApp } from './support/adapters.js';
import {
  InMemoryDisk,
  Storage,
  STORAGE_MODULE_OPTIONS,
  StorageDisk,
  StorageModule,
} from '../lib/index.js';
import {
  createFilesController,
  DiskFactory,
  diskKinds,
  PDF,
  PNG,
  prepare,
  PUBLIC_URL,
  uploadApis,
  useFakeS3,
} from './integration.support.js';

const fake = useFakeS3();
const CONFIG = Symbol('config');

interface AppConfig {
  public: StorageDisk;
  private: StorageDisk;
  /** Constructor options for the disk class Nest instantiates. */
  classOptions: object;
}

@Controller('disks')
class DisksController {
  constructor(private readonly storage: Storage) {}

  @Get()
  describe() {
    return { names: this.storage.names(), default: this.storage.defaultDisk };
  }
}

function configModule(config: AppConfig): DynamicModule {
  @Module({})
  class ConfigModule {}
  return { module: ConfigModule, providers: [{ provide: CONFIG, useValue: config }], exports: [CONFIG] };
}

let apps = 0;

/** Disks for one app; on S3, under prefixes of their own, so two apps don't see each other's files. */
async function appConfig(factory: DiskFactory): Promise<AppConfig> {
  const id = ++apps;
  const s3 = (name: string) => ({ prefix: `app-${id}/${name}/` });
  return {
    public: await factory.create('public', { publicUrl: PUBLIC_URL, s3: s3('public') }),
    private: await factory.create('private', { signed: true, s3: s3('private') }),
    classOptions: await factory.options('classy', { publicUrl: PUBLIC_URL, s3: s3('classy') }),
  };
}

/** A disk class of the factory's kind, built by Nest from an injected configuration. */
function configuredDiskClass(factory: DiskFactory) {
  // Typed as one of the three: they all take a single options object
  const Base = factory.diskClass as typeof InMemoryDisk;

  @Injectable()
  class ConfiguredDisk extends Base {
    constructor(@Inject(CONFIG) config: AppConfig) {
      super(config.classOptions);
    }
  }
  return ConfiguredDisk;
}

async function boot(adapter: AdapterName, imports: Array<DynamicModule>, options: Parameters<typeof createApp>[2] = {}) {
  @Module({ imports, controllers: [createFilesController(uploadApis[adapter]), DisksController] })
  class AppModule {}

  const app = await createApp(adapter, AppModule, { ...options, setup: (instance) => prepare(adapter, instance) });
  return app;
}

describe.each(adapters.map((a) => a.name))('lifecycle on %s', (adapter) => {
  describe.each(diskKinds)('with %s', (kind) => {
    const factory = new DiskFactory(kind, fake);

    beforeEach(() => fake.reset());
    afterAll(() => factory.cleanup());

    it('forRootAsync(): a factory picks the disks from injected configuration, and the app serves them', async () => {
      const config = await appConfig(factory);
      const app = await boot(adapter, [
        StorageModule.forRootAsync({
          imports: [configModule(config)],
          inject: [CONFIG],
          useFactory: async (injected: AppConfig) => ({ default: 'private', disks: { public: injected.public, private: injected.private } }),
        }),
      ]);

      try {
        const http = request(app.getHttpServer());
        expect((await http.get('/disks').expect(200)).body).toEqual({ names: ['public', 'private'], default: 'private' });

        const upload = await http.post('/public').attach('file', PNG, { filename: 'async.png' }).expect(201);
        expect(upload.body.url).toBe(`${PUBLIC_URL}/uploads/async.png`);
        expect(await config.public.getBuffer('uploads/async.png')).toEqual(PNG);

        const [doc] = (await request(app.getHttpServer()).post('/private').attach('docs', PDF, { filename: 'a.pdf' }).expect(201)).body;
        expect(await config.private.exists(doc.key)).toBe(true);
      } finally {
        await app.close();
      }
    });

    it('instantiates a disk class with its dependencies, from the imports given to forRoot()', async () => {
      const config = await appConfig(factory);
      const ConfiguredDisk = configuredDiskClass(factory);
      const app = await boot(adapter, [
        StorageModule.forRoot({
          imports: [configModule(config)],
          default: 'private',
          disks: { public: ConfiguredDisk, private: config.private },
        }),
      ]);

      try {
        await request(app.getHttpServer()).post('/public').attach('file', PNG, { filename: 'classy.png' }).expect(201);
        const disk = app.get(Storage).disk('public');
        expect(disk).toBeInstanceOf(ConfiguredDisk);
        expect(await disk.getBuffer('uploads/classy.png')).toEqual(PNG);
        expect(await config.public.exists('uploads/classy.png')).toBe(false);
      } finally {
        await app.close();
      }
    });

    it("the README's testing recipe: overriding STORAGE_MODULE_OPTIONS swaps the app's disks", async () => {
      const config = await appConfig(factory);
      const production = { public: new InMemoryDisk({ publicUrl: 'https://prod.example' }), private: new InMemoryDisk() };
      const app = await boot(adapter, [StorageModule.forRootAsync({ useFactory: () => ({ default: 'private', disks: production }) })], {
        override: (builder) =>
          builder.overrideProvider(STORAGE_MODULE_OPTIONS).useValue({ default: 'private', disks: { public: config.public, private: config.private } }),
      });

      try {
        const upload = await request(app.getHttpServer()).post('/public').attach('file', PNG, { filename: 'swapped.png' }).expect(201);
        expect(upload.body.url).toBe(`${PUBLIC_URL}/uploads/swapped.png`);
        expect(await config.public.exists('uploads/swapped.png')).toBe(true);
        expect(production.public.keys()).toEqual([]);
      } finally {
        await app.close();
      }
    });

    it('closes each disk once on shutdown, and stops serving', async () => {
      const config = await appConfig(factory);
      const closed: string[] = [];
      config.public.close = async () => {
        closed.push('public');
      };
      config.private.close = async () => {
        closed.push('private');
      };
      const app = await boot(adapter, [StorageModule.forRoot({ default: 'private', disks: { public: config.public, private: config.private, alias: config.public } })]);
      const url = await app.getUrl();

      await request(app.getHttpServer()).post('/public').attach('file', PNG, { filename: 'bye.png' }).expect(201);
      await app.close();

      expect(closed.sort()).toEqual(['private', 'public']);
      await expect(fetch(`${url}/files/public?key=uploads%2Fbye.png`)).rejects.toThrow();
    });

    it('two apps in one process share the upload engine and each stores onto its own disks, also after one closes', async () => {
      const first = await appConfig(factory);
      const second = await appConfig(factory);
      const one = await boot(adapter, [StorageModule.forRoot({ default: 'private', disks: { public: first.public, private: first.private } })]);
      const two = await boot(adapter, [StorageModule.forRoot({ default: 'private', disks: { public: second.public, private: second.private } })]);

      try {
        await request(one.getHttpServer()).post('/public').attach('file', PNG, { filename: 'one.png' }).expect(201);
        await request(two.getHttpServer()).post('/public').attach('file', PNG, { filename: 'two.png' }).expect(201);
        await one.close();
        await request(two.getHttpServer()).post('/public').attach('file', PNG, { filename: 'three.png' }).expect(201);

        expect((await first.public.list()).entries.map((e) => e.key)).toEqual(['uploads/one.png']);
        expect((await second.public.list()).entries.map((e) => e.key)).toEqual(['uploads/three.png', 'uploads/two.png']);
      } finally {
        await one.close();
        await two.close();
      }
    });
  });
});
