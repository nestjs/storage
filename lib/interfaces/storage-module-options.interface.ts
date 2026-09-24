import type { ConfigurableModuleAsyncOptions, ModuleMetadata, Type } from '@nestjs/common';
import type { StorageDisk } from '../disks/storage.disk.js';

/** What `forRoot()` sets besides the disks, and what a `forRootAsync()` factory returns. */
export interface StorageModuleOptions {
  /** The disk `StorageDisk` and `storage.disk()` resolve to. Optional when there is only one. */
  default?: string;
  /** Disk instances by name. From an async factory: instances only (classes go at the top level). */
  disks?: Record<string, StorageDisk>;
}

/**
 * The top level of both `forRoot()` and `forRootAsync()`. Disk classes Nest instantiates go
 * only here, never in the async factory's result, because providers must be known when the
 * module is defined.
 */
export interface StorageModuleStructure {
  /** Disks by name: `StorageDisk` classes (Nest instantiates them, so they can inject) or instances. */
  disks?: Record<string, Type<StorageDisk> | StorageDisk>;
  /** Modules whose exports the disk classes inject. */
  imports?: ModuleMetadata['imports'];
  /** Default `true`. */
  isGlobal?: boolean;
}

/** What `forRoot()` takes. */
export type StorageModuleRootOptions = Omit<StorageModuleOptions, 'disks'> & StorageModuleStructure;

/** What a class passed to `forRootAsync({ useClass })` implements. */
export interface StorageOptionsFactory {
  createStorageOptions(): StorageModuleOptions | Promise<StorageModuleOptions>;
}

/** What `forRootAsync()` takes: disk classes, `imports` and `isGlobal` next to `useFactory`/`useClass`/`useExisting`. */
export type StorageModuleAsyncOptions = ConfigurableModuleAsyncOptions<StorageModuleOptions, 'createStorageOptions'> &
  StorageModuleStructure;
