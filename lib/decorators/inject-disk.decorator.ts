import { Inject } from '@nestjs/common';
import { StorageDisk } from '../disks/storage.disk.js';
import { getDiskToken, requestDiskName } from '../storage.module-definition.js';

/**
 * Injects the disk called `name`: `@InjectDisk('photos') private readonly photos: StorageDisk`.
 * Without a name, the default disk (the same as typing the parameter as `StorageDisk`).
 */
export function InjectDisk(name?: string): PropertyDecorator & ParameterDecorator {
  if (name === undefined) {
    return Inject(StorageDisk);
  }
  if (typeof name !== 'string' || name === '') {
    throw new TypeError('@InjectDisk(): the disk name must be a non-empty string');
  }
  requestDiskName(name);
  return Inject(getDiskToken(name));
}
