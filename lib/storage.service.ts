import { StorageError } from './errors/storage.error.js';
import { StorageDisk } from './disks/storage.disk.js';

/**
 * The configured disks, by name. Inject it to pick a disk at runtime
 * (`storage.disk(tenant.disk)`); inject a disk itself with `@InjectDisk(name)`, or the
 * default one as `StorageDisk`.
 */
export class Storage {
  constructor(
    private readonly disks: ReadonlyMap<string, StorageDisk>,
    readonly defaultDisk: string,
  ) {}

  /** The disk called `name`, or the default one. Throws for a name that isn't configured. */
  disk(name?: string): StorageDisk {
    const disk = this.disks.get(name ?? this.defaultDisk);
    if (!disk) {
      throw new StorageError(`No disk named "${name}". Configured disks: ${this.names().join(', ')}`);
    }
    return disk;
  }

  names(): string[] {
    return [...this.disks.keys()];
  }
}
