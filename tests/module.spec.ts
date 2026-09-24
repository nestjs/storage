import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Controller, Get, Inject, Injectable, Logger, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  getDiskToken,
  InjectDisk,
  InMemoryDisk,
  LocalDisk,
  Storage,
  STORAGE_MODULE_OPTIONS,
  StorageDisk,
  StorageModule,
  type StorageModuleOptions,
  type StorageOptionsFactory,
} from '../lib/index.js';

@Injectable()
class CoversService {
  constructor(
    @InjectDisk('covers') readonly covers: StorageDisk,
    @InjectDisk() readonly fallback: StorageDisk,
    readonly byType: StorageDisk,
    readonly storage: Storage,
  ) {}
}

@Injectable()
class InvoicesService {
  @InjectDisk('invoices') readonly invoices!: StorageDisk;
}

@Controller()
class ArchiveController {
  constructor(@InjectDisk('archive') readonly archive: StorageDisk) {}
  @Get() list() {}
}

/** A feature module that doesn't import StorageModule: it is global. */
@Module({ providers: [CoversService], exports: [CoversService] })
class CoversModule {}

const CONFIG = Symbol('CONFIG');
@Module({ providers: [{ provide: CONFIG, useValue: { bucketName: 'acme-invoices' } }], exports: [CONFIG] })
class ConfigModule {}

/** A disk class Nest instantiates, injecting configuration. */
@Injectable()
class ConfiguredDisk extends InMemoryDisk {
  closed = 0;
  constructor(@Inject(CONFIG) readonly config: { bucketName: string }) {
    super();
  }
  async close() {
    this.closed++;
  }
}

const compile = (imports: unknown[], providers: unknown[] = [], controllers: unknown[] = []) =>
  Test.createTestingModule({ imports: imports as never, providers: providers as never, controllers: controllers as never }).compile();

describe('StorageModule', () => {
  it('forRoot(): named disks, a default, and injection by name, by type and through Storage', async () => {
    const covers = new InMemoryDisk();
    const invoices = new InMemoryDisk();
    const moduleRef = await compile([StorageModule.forRoot({ default: 'invoices', disks: { covers, invoices } }), CoversModule], [InvoicesService]);
    await moduleRef.init();

    const service = moduleRef.get(CoversService);
    expect(service.covers).toBe(covers);
    expect(service.fallback).toBe(invoices);
    expect(service.byType).toBe(invoices);
    expect(service.storage.disk('covers')).toBe(covers);
    expect(service.storage.disk()).toBe(invoices);
    expect(service.storage.defaultDisk).toBe('invoices');
    expect(service.storage.names()).toEqual(['covers', 'invoices']);
    expect(moduleRef.get(InvoicesService).invoices).toBe(invoices);
    expect(moduleRef.get(getDiskToken('covers'))).toBe(covers);
    expect(() => service.storage.disk('nope')).toThrow('No disk named "nope". Configured disks: covers, invoices');

    await moduleRef.close();
  });

  it('a single disk is the default', async () => {
    const only = new InMemoryDisk();
    const moduleRef = await compile([StorageModule.forRoot({ disks: { only } })]);
    expect(moduleRef.get(StorageDisk)).toBe(only);
  });

  it('forRootAsync(): disk instances from the factory, a class at the top level', async () => {
    const covers = new InMemoryDisk();
    const moduleRef = await compile([
      StorageModule.forRootAsync({
        imports: [ConfigModule],
        disks: { invoices: ConfiguredDisk },
        inject: [CONFIG],
        useFactory: (config: { bucketName: string }): StorageModuleOptions => ({
          default: config.bucketName === 'acme-invoices' ? 'covers' : 'invoices',
          disks: { covers },
        }),
      }),
      CoversModule,
    ], [InvoicesService]);
    await moduleRef.init();

    const invoices = moduleRef.get(InvoicesService).invoices;
    expect(invoices).toBeInstanceOf(ConfiguredDisk);
    expect((invoices as ConfiguredDisk).config.bucketName).toBe('acme-invoices');
    // Names that only the factory knows still resolve through @InjectDisk()
    expect(moduleRef.get(CoversService).covers).toBe(covers);
    expect(moduleRef.get(StorageDisk)).toBe(covers);

    await moduleRef.close();
    expect((invoices as ConfiguredDisk).closed).toBe(1);
  });

  it('forRootAsync({ useClass }) calls createStorageOptions()', async () => {
    @Injectable()
    class StorageConfig implements StorageOptionsFactory {
      createStorageOptions(): StorageModuleOptions {
        return { disks: { covers: new InMemoryDisk() } };
      }
    }

    const moduleRef = await compile([StorageModule.forRootAsync({ useClass: StorageConfig }), CoversModule]);
    expect(moduleRef.get(CoversService).covers).toBeInstanceOf(InMemoryDisk);
  });

  it('closes each disk once on shutdown, even when it has two names', async () => {
    const disk = new InMemoryDisk();
    const close = vi.fn(async () => undefined);
    Object.assign(disk, { close });

    const moduleRef = await compile([StorageModule.forRoot({ default: 'a', disks: { a: disk, b: disk } })]);
    await moduleRef.init();
    await moduleRef.close();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('tests swap the disks by overriding STORAGE_MODULE_OPTIONS', async () => {
    const memory = new InMemoryDisk();
    const moduleRef = await Test.createTestingModule({
      imports: [
        StorageModule.forRootAsync({ useFactory: () => ({ disks: { covers: new InMemoryDisk() } }) }),
        CoversModule,
      ],
    })
      .overrideProvider(STORAGE_MODULE_OPTIONS)
      .useValue({ disks: { covers: memory } })
      .compile();

    expect(moduleRef.get(CoversService).covers).toBe(memory);
  });

  describe('fails at startup', () => {
    const failure = (promise: Promise<unknown>) => promise.then(() => 'no error', (error: Error) => error.message);
    const boot = async (imports: unknown[], providers: unknown[] = [], controllers: unknown[] = []) => {
      const moduleRef = await compile(imports, providers, controllers);
      await moduleRef.init();
    };

    it('naming the class that injects a disk no configuration provides', async () => {
      const message = await failure(boot([StorageModule.forRoot({ default: 'covers', disks: { covers: new InMemoryDisk() } })], [], [ArchiveController]));
      expect(message).toBe(
        `ArchiveController injects the disk "archive" (@InjectDisk('archive')), but StorageModule has no disk by that name. Configured disks: covers.`,
      );

      const property = await failure(boot([StorageModule.forRootAsync({ useFactory: () => ({ disks: { covers: new InMemoryDisk() } }) })], [InvoicesService]));
      expect(property).toContain(`InvoicesService injects the disk "invoices"`);
    });

    it.each([
      [{ disks: {} }, 'StorageModule needs at least one disk'],
      [{ disks: { a: new InMemoryDisk(), b: new InMemoryDisk() } }, 'several disks are configured (a, b), so `default` must name one of them'],
      [{ default: 'c', disks: { a: new InMemoryDisk() } }, '`default` is "c", but no disk has that name. Configured disks: a.'],
    ])('forRoot(%o)', async (options, message) => {
      expect(await failure(boot([StorageModule.forRoot(options)]))).toContain(message);
    });

    it('for a bad disk name or value, when the module is defined', () => {
      expect(() => StorageModule.forRoot({ disks: { 'my disk': new InMemoryDisk() } })).toThrow('"my disk" is not a valid disk name');
      expect(() => StorageModule.forRoot({ disks: { a: { put() {} } as never } })).toThrow('disks.a must be a StorageDisk class or instance');
    });

    it('when the factory returns a class, a non-disk, or a disk also set at the top level', async () => {
      const cases: [StorageModuleOptions, string][] = [
        [{ disks: { a: ConfiguredDisk as never } }, 'the forRootAsync() factory returned a class as `disks.a` (ConfiguredDisk)'],
        [{ disks: { a: {} as never } }, '`disks.a` returned by the forRootAsync() factory must be a StorageDisk instance'],
        [{ disks: { top: new InMemoryDisk() } }, '`disks.top` is set both at the top level of forRootAsync() and in the options its factory returns'],
      ];

      for (const [result, message] of cases) {
        const module = StorageModule.forRootAsync({ disks: { top: new InMemoryDisk() }, useFactory: () => result });
        expect(await failure(boot([module]))).toContain(message);
      }
    });
  });

  it('warns once per disk in production about in-memory disks', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    try {
      const scratch = new InMemoryDisk();
      for (let i = 0; i < 2; i++) {
        const moduleRef = await compile([StorageModule.forRoot({ disks: { scratch } })]);
        await moduleRef.init();
        await moduleRef.close();
      }

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('scratch keep files in memory');
    } finally {
      process.env.NODE_ENV = env;
      warn.mockRestore();
    }
  });

  it('warns in production about local disks', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const root = mkdtempSync(join(tmpdir(), 'nest-storage-prod-'));

    try {
      const moduleRef = await compile([StorageModule.forRoot({ default: 'uploads', disks: { uploads: new LocalDisk({ root }), scratch: new InMemoryDisk() } })]);
      await moduleRef.init();
      await moduleRef.close();

      const messages = warn.mock.calls.map((call) => String(call[0]));
      expect(messages.some((m) => m.includes('uploads keep files on this instance') && m.includes('S3Disk'))).toBe(true);
      expect(messages.some((m) => m.includes('scratch keep files in memory'))).toBe(true);
    } finally {
      process.env.NODE_ENV = env;
      warn.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
