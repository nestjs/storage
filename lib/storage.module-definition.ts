import { ConfigurableModuleBuilder, type DynamicModule, type Provider, type Type } from '@nestjs/common';
import type { StorageModuleOptions, StorageModuleStructure } from './interfaces/storage-module-options.interface.js';
import { STORAGE_DISKS, STORAGE_MODULE_OPTIONS } from './storage.constants.js';
import { StorageError } from './errors/storage.error.js';
import { StorageDisk } from './disks/storage.disk.js';
import { Storage } from './storage.service.js';

export const { ConfigurableModuleClass, OPTIONS_TYPE } = new ConfigurableModuleBuilder<StorageModuleOptions>({
  optionsInjectionToken: STORAGE_MODULE_OPTIONS,
})
  .setClassMethodName('forRoot')
  .setFactoryMethodName('createStorageOptions')
  .setExtras<StorageModuleStructure>(
    { isGlobal: true, disks: undefined, imports: undefined },
    (definition, { isGlobal, disks, imports }) =>
      withNamedDisks(
        {
          ...definition,
          global: isGlobal,
          imports: [...(definition.imports ?? []), ...(imports ?? [])],
          providers: [...(definition.providers ?? []), ...structuralProviders(disks)],
          exports: [Storage, StorageDisk, STORAGE_MODULE_OPTIONS],
        },
        Object.keys(disks ?? {}),
      ),
  )
  .build();

// --- named disk tokens -------------------------------------------------------------------

/** The injection token of the disk called `name` (`@InjectDisk(name)` uses it). */
export function getDiskToken(name: string): string {
  return `StorageDisk:${name}`;
}

/** The disk name in a token from `getDiskToken()`, else `undefined`. */
export function diskNameOf(token: string): string | undefined {
  return token.startsWith('StorageDisk:') ? token.slice('StorageDisk:'.length) : undefined;
}

/** Names requested with `@InjectDisk()`, collected when decorators run (before modules are scanned). */
const requestedNames = new Set<string>();

export function requestDiskName(name: string): void {
  requestedNames.add(name);
}

/**
 * Disk names can come from a `forRootAsync()` factory, which runs at startup, so the
 * module can't list their providers when it is defined. Instead, its `providers` and
 * `exports` are read when Nest scans the module, after every file (and every
 * `@InjectDisk()`) was loaded: a provider per requested name. A name that turns out not to
 * be configured fails at startup, naming the class that injects it (see `StorageModule`).
 */
function withNamedDisks(module: DynamicModule, known: string[]): DynamicModule {
  const providers = module.providers ?? [];
  const exports = module.exports ?? [];
  const names = () => [...new Set([...known, ...requestedNames])];
  const result = { ...module };
  Object.defineProperties(result, {
    providers: { enumerable: true, configurable: true, get: () => [...providers, ...names().map(namedDiskProvider)] },
    exports: { enumerable: true, configurable: true, get: () => [...exports, ...names().map(getDiskToken)] },
  });
  return result;
}

function namedDiskProvider(name: string): Provider {
  return {
    provide: getDiskToken(name),
    inject: [STORAGE_DISKS],
    useFactory: (resolved: ResolvedDisks) => resolved.disks.get(name) ?? new MissingDisk(name, resolved),
  };
}

/** Stands in for an injected disk that isn't configured, until the startup check reports it. */
class MissingDisk extends StorageDisk {
  constructor(
    private readonly diskName: string,
    private readonly resolved: ResolvedDisks,
  ) {
    super();
  }
  private fail(): never {
    throw missingDiskError(this.diskName, [...this.resolved.disks.keys()]);
  }
  protected async writeObject(): Promise<never> {
    this.fail();
  }
  protected async readObject(): Promise<never> {
    this.fail();
  }
  protected async headObject(): Promise<never> {
    this.fail();
  }
  protected async deleteObjects(): Promise<never> {
    this.fail();
  }
  protected async listObjects(): Promise<never> {
    this.fail();
  }
  protected async copyObject(): Promise<never> {
    this.fail();
  }
  override url(): string {
    this.fail();
  }
  override async signedUrl(): Promise<string> {
    this.fail();
  }
  override async signedUpload(): Promise<never> {
    this.fail();
  }
}

export function missingDiskError(name: string, configured: string[], consumer?: string): Error {
  return new StorageError(
    `${consumer ? `${consumer} injects` : 'Injected'} the disk "${name}" (@InjectDisk('${name}')), ` +
      `but StorageModule has no disk by that name. Configured disks: ${configured.join(', ') || 'none'}.`,
  );
}

// --- disks ---------------------------------------------------------------------------------

export interface ResolvedDisks {
  disks: Map<string, StorageDisk>;
  defaultName: string;
}

function structuralProviders(disks: StorageModuleStructure['disks'] = {}): Provider[] {
  for (const [name, disk] of Object.entries(disks)) {
    assertName(name);
    if (!isClass(disk) && !(disk instanceof StorageDisk)) {
      throw new TypeError(`StorageModule: disks.${name} must be a StorageDisk class or instance`);
    }
  }

  const classes = [...new Set(Object.values(disks).filter(isClass))];
  return [
    ...classes,
    {
      provide: STORAGE_DISKS,
      inject: [STORAGE_MODULE_OPTIONS, ...classes],
      useFactory: (options: StorageModuleOptions | undefined, ...instances: StorageDisk[]): ResolvedDisks => {
        const merged = new Map<string, StorageDisk>();
        for (const [name, disk] of Object.entries(disks)) {
          merged.set(name, isClass(disk) ? instances[classes.indexOf(disk)] : disk);
        }

        for (const [name, disk] of Object.entries(options?.disks ?? {})) {
          assertName(name);
          if (isClass(disk)) {
            throw new Error(
              `StorageModule: the forRootAsync() factory returned a class as \`disks.${name}\` (${(disk as Type).name}). ` +
                'Classes go at the top level of forRootAsync(), next to useFactory or useClass, where Nest ' +
                'instantiates them; the factory returns instances such as new S3Disk({ ... }).',
            );
          }
          if (!(disk instanceof StorageDisk)) {
            throw new TypeError(`StorageModule: \`disks.${name}\` returned by the forRootAsync() factory must be a StorageDisk instance`);
          }
          if (merged.has(name)) {
            throw new Error(
              `StorageModule: \`disks.${name}\` is set both at the top level of forRootAsync() and in the ` +
                'options its factory returns. Set it in one place.',
            );
          }
          merged.set(name, disk);
        }

        if (merged.size === 0) {
          throw new Error(
            'StorageModule needs at least one disk: disks: { local: new LocalDisk({ root: "storage" }) }, ' +
              'at the top level of forRoot()/forRootAsync(), or returned by the forRootAsync() factory.',
          );
        }

        const defaultName = options?.default ?? (merged.size === 1 ? [...merged.keys()][0] : undefined);
        if (defaultName === undefined) {
          throw new Error(
            `StorageModule: several disks are configured (${[...merged.keys()].join(', ')}), so \`default\` must name one of them.`,
          );
        }
        if (!merged.has(defaultName)) {
          throw new Error(
            `StorageModule: \`default\` is "${defaultName}", but no disk has that name. Configured disks: ${[...merged.keys()].join(', ')}.`,
          );
        }

        return { disks: merged, defaultName };
      },
    },
    {
      provide: Storage,
      inject: [STORAGE_DISKS],
      useFactory: (resolved: ResolvedDisks) => new Storage(resolved.disks, resolved.defaultName),
    },
    {
      provide: StorageDisk,
      inject: [Storage],
      useFactory: (storage: Storage) => storage.disk(),
    },
  ];
}

function assertName(name: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) {
    throw new TypeError(`StorageModule: "${name}" is not a valid disk name (letters, digits, ".", "-", "_")`);
  }
}

function isClass(value: unknown): value is Type<StorageDisk> {
  return typeof value === 'function';
}
