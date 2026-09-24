import type { InMemoryDiskOptions } from '../interfaces/disk-options.interface.js';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { StorageFileNotFoundError } from '../errors/storage-file-not-found.error.js';
import { StorageRangeNotSatisfiableError } from '../errors/storage-range-not-satisfiable.error.js';
import { resolveRange, StorageDisk } from './storage.disk.js';
import type {
  StorageDownload,
  StorageFile,
  StorageListPage,
  StorageObjectWrite,
  StorageRange,
  StorageWriteResult,
} from '../interfaces/storage-disk.interface.js';

interface StoredObject {
  data: Buffer;
  file: Omit<StorageFile, 'key'>;
}

/**
 * Keeps files in a `Map`, for tests. It behaves like the other disks: the same key rules,
 * S3's range and listing semantics, metadata, public and (app-served) signed URLs.
 */
export class InMemoryDisk extends StorageDisk {
  private readonly objects = new Map<string, StoredObject>();

  constructor(options: InMemoryDiskOptions = {}) {
    super(options);
  }

  /** The stored keys, sorted. For assertions in tests. */
  keys(): string[] {
    return [...this.objects.keys()].sort(compareKeys);
  }

  clear(): void {
    this.objects.clear();
  }

  protected async writeObject(
    key: string,
    body: AsyncIterable<Buffer>,
    file: StorageObjectWrite,
  ): Promise<StorageWriteResult> {
    const chunks: Buffer[] = [];
    for await (const chunk of body) {
      chunks.push(chunk);
    }

    const data = Buffer.concat(chunks);
    const etag = `"${createHash('md5').update(data).digest('hex')}"`;

    this.objects.set(key, {
      data,
      file: {
        size: data.length,
        contentType: file.contentType,
        lastModified: new Date(),
        etag,
        cacheControl: file.cacheControl,
        contentDisposition: file.contentDisposition,
        metadata: { ...file.metadata },
      },
    });

    return { key, size: data.length, contentType: file.contentType, etag };
  }

  protected async readObject(key: string, range: StorageRange | undefined): Promise<StorageDownload> {
    const object = this.require(key);
    const file = this.describe(key, object);
    if (!range) {
      return { ...file, body: Readable.from([object.data], { objectMode: false }) };
    }

    const resolved = resolveRange(range, object.data.length);
    if (!resolved) {
      throw new StorageRangeNotSatisfiableError(key, object.data.length);
    }

    const slice = object.data.subarray(resolved.start, resolved.end + 1);
    return { ...file, range: resolved, body: Readable.from([slice], { objectMode: false }) };
  }

  protected async headObject(key: string): Promise<StorageFile> {
    return this.describe(key, this.require(key));
  }

  protected async deleteObjects(keys: string[]): Promise<void> {
    for (const key of keys) {
      this.objects.delete(key);
    }
  }

  protected async listObjects(options: { prefix: string; cursor?: string; limit: number }): Promise<StorageListPage> {
    const after = options.cursor === undefined ? undefined : decodeCursor(options.cursor);
    const keys = this.keys().filter(
      (key) => key.startsWith(options.prefix) && (after === undefined || compareKeys(key, after) > 0),
    );
    const page = keys.slice(0, options.limit);

    return {
      entries: page.map((key) => {
        const { file } = this.objects.get(key)!;
        return { key, size: file.size, lastModified: file.lastModified, etag: file.etag };
      }),
      cursor: keys.length > page.length ? encodeCursor(page[page.length - 1]) : undefined,
    };
  }

  protected async copyObject(from: string, to: string): Promise<StorageWriteResult> {
    const source = this.require(from);
    const copy: StoredObject = {
      data: Buffer.from(source.data),
      file: { ...source.file, metadata: { ...source.file.metadata }, lastModified: new Date() },
    };
    this.objects.set(to, copy);
    return { key: to, size: copy.file.size, contentType: copy.file.contentType, etag: copy.file.etag };
  }

  protected override async moveObject(from: string, to: string): Promise<StorageWriteResult> {
    const result = await this.copyObject(from, to);
    this.objects.delete(from);
    return result;
  }

  private require(key: string): StoredObject {
    const object = this.objects.get(key);
    if (!object) {
      throw new StorageFileNotFoundError(key);
    }
    return object;
  }

  private describe(key: string, object: StoredObject): StorageFile {
    return { key, ...object.file, metadata: { ...object.file.metadata } };
  }
}

/** S3 lists keys in UTF-8 byte order, which isn't JavaScript's UTF-16 order for every character. */
export function compareKeys(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

export function encodeCursor(key: string): string {
  return Buffer.from(key, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): string {
  const key = Buffer.from(cursor, 'base64url').toString('utf8');
  if (key === '' || encodeCursor(key) !== cursor) {
    throw new TypeError('list(): `cursor` is not a cursor this disk returned');
  }
  return key;
}
