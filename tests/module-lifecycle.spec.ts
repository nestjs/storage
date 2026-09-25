/**
 * StorageModule registration paths and lifecycle beyond module.spec.ts: `useExisting`, async
 * factories, `isGlobal: false`, disk classes shared between names, shutdown failures, the
 * stand-in for an injected disk that is not configured, and which application's disks an
 * upload engine finds.
 */
import { Inject, Injectable, Logger, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  getDiskToken,
  InjectDisk,
  InMemoryDisk,
  Storage,
  STORAGE_MODULE_OPTIONS,
  StorageDisk,
  StorageError,
  StorageModule,
  type StorageModuleOptions,
  type StorageOptionsFactory,
} from '../lib/index.js';
import { registerServer, storageForRequest, unregisterServer } from '../lib/http/app-registry.util.js';

const compile = (imports: unknown[], providers: unknown[] = []) =>
  Test.createTestingModule({ imports: imports as never, providers: providers as never }).compile();

@Injectable()
class UsesDefault {
  constructor(readonly disk: StorageDisk) {}
}

@Injectable()
class UsesGhost {
  constructor(@InjectDisk('ghost') readonly ghost: StorageDisk) {}
}

const SETTINGS = Symbol('SETTINGS');

@Module({ providers: [{ provide: SETTINGS, useValue: { label: 'from-settings' } }], exports: [SETTINGS] })
class SettingsModule {}

@Injectable()
class SettingsDisk extends InMemoryDisk {
  static created = 0;
  constructor(@Inject(SETTINGS) readonly settings: { label: string }) {
    super();
    SettingsDisk.created++;
  }
}

describe('StorageModule registration', () => {
  it('getDiskToken() is a stable string per name', () => {
    expect(getDiskToken('photos')).toBe('StorageDisk:photos');
  });

  it('forRootAsync({ useExisting }) reuses a factory provided elsewhere', async () => {
    const disk = new InMemoryDisk();

    @Injectable()
    class ExistingConfig implements StorageOptionsFactory {
      createStorageOptions(): StorageModuleOptions {
        return { disks: { only: disk } };
      }
    }

    @Module({ providers: [ExistingConfig], exports: [ExistingConfig] })
    class ConfigModule {}

    const moduleRef = await compile([StorageModule.forRootAsync({ imports: [ConfigModule], useExisting: ExistingConfig })], [UsesDefault]);
    expect(moduleRef.get(UsesDefault).disk).toBe(disk);
  });

  it('an async factory may resolve later, and its result is the STORAGE_MODULE_OPTIONS value', async () => {
    const disk = new InMemoryDisk();
    const options: StorageModuleOptions = { disks: { later: disk } };
    const moduleRef = await compile([StorageModule.forRootAsync({ useFactory: async () => options })]);

    expect(moduleRef.get(STORAGE_MODULE_OPTIONS)).toBe(options);
    expect(moduleRef.get(StorageDisk)).toBe(disk);
  });

  it('forRoot() instantiates a disk class with dependencies from its imports, once for two names', async () => {
    SettingsDisk.created = 0;
    const moduleRef = await compile([
      StorageModule.forRoot({ imports: [SettingsModule], default: 'a', disks: { a: SettingsDisk, b: SettingsDisk } }),
    ]);
    const storage = moduleRef.get(Storage);

    expect(storage.disk('a')).toBeInstanceOf(SettingsDisk);
    expect(storage.disk('a')).toBe(storage.disk('b'));
    expect((storage.disk('a') as SettingsDisk).settings.label).toBe('from-settings');
    expect(SettingsDisk.created).toBe(1);
  });

  it('a factory with no disks of its own leaves the top-level ones', async () => {
    const moduleRef = await compile([StorageModule.forRootAsync({ imports: [SettingsModule], disks: { main: SettingsDisk }, useFactory: () => ({}) })]);
    expect(moduleRef.get(StorageDisk)).toBeInstanceOf(SettingsDisk);
  });

  it('isGlobal: false keeps the disks to modules that import StorageModule', async () => {
    const storage = StorageModule.forRoot({ isGlobal: false, disks: { a: new InMemoryDisk() } });

    @Module({ providers: [UsesDefault] })
    class NotImporting {}

    @Module({ imports: [storage], providers: [UsesDefault] })
    class Importing {}

    await expect(compile([storage, NotImporting])).rejects.toThrow(/UsesDefault/);
    const moduleRef = await compile([Importing]);
    expect(moduleRef.get(UsesDefault).disk).toBeInstanceOf(InMemoryDisk);
  });

  it('@InjectDisk() refuses an empty name', () => {
    expect(() => InjectDisk('')).toThrow('@InjectDisk(): the disk name must be a non-empty string');
  });

  it.each(['a b', '-leading', 'with/slash', ''])('refuses the disk name %j returned by a factory', async (name) => {
    const moduleRef = compile([StorageModule.forRootAsync({ useFactory: () => ({ disks: { [name]: new InMemoryDisk() } }) })]);
    await expect(moduleRef).rejects.toThrow(`"${name}" is not a valid disk name`);
  });

  it('accepts names with dots, dashes and underscores', async () => {
    const disk = new InMemoryDisk();
    const moduleRef = await compile([StorageModule.forRoot({ default: 'eu.private_v2-a', disks: { 'eu.private_v2-a': disk, b: new InMemoryDisk() } })]);
    expect(moduleRef.get(getDiskToken('eu.private_v2-a'))).toBe(disk);
  });
});

describe('an injected disk that is not configured', () => {
  it('fails every call, naming the disk, when the startup check has not run', async () => {
    const moduleRef = await compile([StorageModule.forRoot({ disks: { a: new InMemoryDisk() } })], [UsesGhost]);
    const ghost = moduleRef.get(UsesGhost).ghost;
    const message = `Injected the disk "ghost" (@InjectDisk('ghost')), but StorageModule has no disk by that name. Configured disks: a.`;

    await expect(ghost.put('a', 'x')).rejects.toThrow(message);
    await expect(ghost.get('a')).rejects.toThrow(StorageError);
    await expect(ghost.list()).rejects.toThrow(message);
    await expect(ghost.signedUrl('a')).rejects.toThrow(message);
    await expect(ghost.signedUpload('a', { contentType: 'x/y' })).rejects.toThrow(message);
    expect(() => ghost.url('a')).toThrow(message);
  });

  it('fails init() naming the class', async () => {
    const moduleRef = await compile([StorageModule.forRoot({ disks: { a: new InMemoryDisk() } })], [UsesGhost]);
    await expect(moduleRef.init()).rejects.toThrow(/^UsesGhost injects the disk "ghost"/);
  });
});

describe('StorageModule lifecycle', () => {
  it('closes every disk on shutdown, even when one of them fails to close', async () => {
    const failing = Object.assign(new InMemoryDisk(), { close: vi.fn(async () => Promise.reject(new Error('socket stuck'))) });
    const healthy = Object.assign(new InMemoryDisk(), { close: vi.fn(async () => undefined) });
    const moduleRef = await compile([StorageModule.forRoot({ default: 'a', disks: { a: failing, b: healthy, plain: new InMemoryDisk() } })]);
    await moduleRef.init();

    await expect(moduleRef.close()).resolves.toBeUndefined();
    expect(failing.close).toHaveBeenCalledTimes(1);
    expect(healthy.close).toHaveBeenCalledTimes(1);
  });

  it('warns about nothing outside production', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';

    try {
      const moduleRef = await compile([StorageModule.forRoot({ disks: { scratch: new InMemoryDisk() } })]);
      await moduleRef.init();
      await moduleRef.close();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = env;
      warn.mockRestore();
    }
  });
});

describe("which application's disks a request finds", () => {
  const storageOf = (name: string) => new Storage(new Map([[name, new InMemoryDisk()]]), name);

  it('an Express sub-app finds the disks registered for the app it is mounted on', () => {
    const app = {};
    const storage = storageOf('main');
    registerServer(app, storage);

    const mounted = { parent: { parent: app } };
    expect(storageForRequest({ app: mounted })).toBe(storage);
    expect(storageForRequest({ app: {} })).toBeUndefined();
    unregisterServer(app, storage);
  });

  it('a Fastify child instance finds the disks of the instance it was created from', () => {
    const instance = { name: 'root' };
    const storage = storageOf('main');
    registerServer(instance, storage);

    const child = Object.create(Object.create(instance));
    expect(storageForRequest({ server: child })).toBe(storage);
    unregisterServer(instance, storage);
    expect(storageForRequest({ server: child })).toBeUndefined();
  });

  it('only the Storage that registered an instance can unregister it', () => {
    const instance = {};
    const first = storageOf('first');
    const second = storageOf('second');
    registerServer(instance, first);
    registerServer(instance, second);

    unregisterServer(instance, first);
    expect(storageForRequest({ app: instance })).toBe(second);
    unregisterServer(instance, second);
    expect(storageForRequest({ app: instance })).toBeUndefined();
  });

  it('a request without an app or a server finds nothing', () => {
    expect(storageForRequest(undefined)).toBeUndefined();
    expect(storageForRequest({})).toBeUndefined();
  });
});
