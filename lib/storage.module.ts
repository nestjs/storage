import {
  Inject,
  Logger,
  Module,
  Optional,
  type DynamicModule,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { HttpAdapterHost, ModulesContainer } from '@nestjs/core';
import { InMemoryDisk } from './disks/in-memory.disk.js';
import { LocalDisk } from './disks/local.disk.js';
import { registerServer, unregisterServer } from './http/app-registry.util.js';
import {
  ConfigurableModuleClass,
  diskNameOf,
  missingDiskError,
  type OPTIONS_TYPE,
  type ResolvedDisks,
} from './storage.module-definition.js';
import { STORAGE_DISKS } from './storage.constants.js';
import type {
  StorageModuleAsyncOptions,
  StorageModuleRootOptions,
} from './interfaces/storage-module-options.interface.js';
import { Storage } from './storage.service.js';

const SELF_DECLARED_DEPS = 'self:paramtypes';
const PROPERTY_DEPS = 'self:properties_metadata';
/** Disks already warned about in production, so an app rebooted around the same disks warns once. */
const warnedDisks = new WeakSet<object>();

/**
 * `StorageModule.forRoot({ default, disks })`, or `forRootAsync({ disks, imports, inject,
 * useFactory })`, where the factory (or a `useClass` class's `createStorageOptions()`) returns
 * `default` and disk instances built from configuration, and disk classes stay at the top
 * level. Global by default. Closes the disks on application shutdown.
 */
@Module({})
export class StorageModule extends ConfigurableModuleClass implements OnModuleInit, OnApplicationShutdown {
  private server?: object;

  constructor(
    @Inject(STORAGE_DISKS) private readonly resolved: ResolvedDisks,
    private readonly storage: Storage,
    private readonly modules: ModulesContainer,
    @Optional() private readonly adapterHost?: HttpAdapterHost,
  ) {
    super();
  }

  static forRoot(options: StorageModuleRootOptions): DynamicModule {
    return super.forRoot(options as typeof OPTIONS_TYPE);
  }

  static forRootAsync(options: StorageModuleAsyncOptions): DynamicModule {
    return super.forRootAsync(options);
  }

  onModuleInit() {
    this.checkInjectedDisks();

    if (process.env.NODE_ENV === 'production') {
      const named = (type: Function) =>
        [...this.resolved.disks]
          .filter(([, disk]) => disk instanceof type && !warnedDisks.has(disk))
          .map(([name, disk]) => (warnedDisks.add(disk), name));
      const inMemory = named(InMemoryDisk);
      const local = named(LocalDisk);

      const logger = new Logger('StorageModule');
      if (inMemory.length > 0) {
        logger.warn(`The disk(s) ${inMemory.join(', ')} keep files in memory: they are lost on restart and not shared between instances.`);
      }
      if (local.length > 0) {
        logger.warn(
          `The disk(s) ${local.join(', ')} keep files on this instance's file system (LocalDisk): a container's disk is ` +
            'discarded with the task, and other instances can\'t read the files. Use S3Disk in production, unless the root ' +
            'is a persistent volume every instance shares.',
        );
      }
    }

    // Lets upload engines, created in decorators, find this application's disks per request.
    const instance = this.adapterHost?.httpAdapter?.getInstance?.();
    if (instance && (typeof instance === 'object' || typeof instance === 'function')) {
      this.server = instance;
      registerServer(instance, this.storage);
    }
  }

  async onApplicationShutdown() {
    if (this.server) {
      unregisterServer(this.server, this.storage);
    }
    const disks = new Set(this.resolved.disks.values());
    await Promise.allSettled([...disks].map((disk) => disk.close?.()));
  }

  /**
   * A disk name injected with `@InjectDisk()` that no configuration provides fails here, at
   * startup, naming the class, instead of on the first call.
   */
  private checkInjectedDisks() {
    const configured = [...this.resolved.disks.keys()];
    const missing = new Map<string, string>();

    for (const module of this.modules.values()) {
      const wrappers = [...module.providers.values(), ...module.controllers.values(), ...module.injectables.values()];
      for (const wrapper of wrappers) {
        const tokens: unknown[] = (wrapper.inject ?? []).map((dep: any) => dep?.token ?? dep);
        const type = wrapper.metatype;
        if (typeof type === 'function' && !wrapper.inject) {
          for (const dep of Reflect.getMetadata(SELF_DECLARED_DEPS, type) ?? []) {
            tokens.push(dep.param);
          }
          for (const dep of Reflect.getMetadata(PROPERTY_DEPS, type) ?? []) {
            tokens.push(dep.type);
          }
        }

        for (const token of tokens) {
          const name = typeof token === 'string' ? diskNameOf(token) : undefined;
          if (name === undefined) {
            continue;
          }
          if (!this.resolved.disks.has(name) && !missing.has(name)) {
            missing.set(name, String(wrapper.name));
          }
        }
      }
    }

    const [first] = missing;
    if (first) {
      throw missingDiskError(first[0], configured, first[1]);
    }
  }
}
