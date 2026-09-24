import type { LocalDiskOptions } from '../interfaces/disk-options.interface.js';
import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream, mkdirSync, realpathSync, type Stats } from 'node:fs';
import { copyFile, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, unlink, writeFile, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { contentTypeFromKey } from '../utils/content-type.util.js';
import { assertValidKey } from '../utils/keys.util.js';
import { StorageFileNotFoundError } from '../errors/storage-file-not-found.error.js';
import { StorageInvalidKeyError } from '../errors/storage-invalid-key.error.js';
import { StorageKeyConflictError } from '../errors/storage-key-conflict.error.js';
import { StorageRangeNotSatisfiableError } from '../errors/storage-range-not-satisfiable.error.js';
import { resolveRange, StorageDisk } from './storage.disk.js';
import type {
  StorageDownload,
  StorageFile,
  StorageListEntry,
  StorageListPage,
  StorageObjectWrite,
  StorageRange,
  StorageWriteResult,
} from '../interfaces/storage-disk.interface.js';
import { compareKeys, decodeCursor, encodeCursor } from './in-memory.disk.js';

/** Temp files and metadata live here, inside the root, so a rename never crosses file systems. */
const INTERNAL_DIR = '.nest-storage';

/** What a sidecar holds: what the file name can't tell. `for` ties it to one version of the file. */
interface Sidecar {
  for: string;
  contentType?: string;
  cacheControl?: string;
  contentDisposition?: string;
  metadata?: Record<string, string>;
}

/**
 * Files in a local directory, on `node:fs`.
 *
 * - **Atomic writes.** A file is written to a temp file, flushed, then renamed over the key:
 *   readers see the old file or the new one. A failed or aborted write leaves nothing.
 * - **Confined to `root`.** Keys can't contain `..`, absolute paths, backslashes or NUL (the
 *   rule every disk applies), the internal `.nest-storage` directory is off limits, and a
 *   symbolic link on the way to a file, or as the file, is refused, so a link placed inside
 *   the root can't lead reads or writes outside it.
 * - **Metadata** that the extension doesn't imply (an explicit content type, cache control,
 *   disposition, your metadata) is kept in a JSON sidecar under `.nest-storage/meta/`, tied to
 *   the file's size and modification time, so a sidecar never describes another version.
 */
export class LocalDisk extends StorageDisk {
  readonly root: string;
  private readonly realRoot: string;
  private readonly tmpDir: string;
  private readonly metaDir: string;

  constructor(options: LocalDiskOptions) {
    super(options);
    if (typeof options?.root !== 'string' || options.root === '') {
      throw new TypeError('LocalDisk needs a `root` directory');
    }

    this.root = resolve(options.root);
    mkdirSync(join(this.root, INTERNAL_DIR, 'tmp'), { recursive: true });
    mkdirSync(join(this.root, INTERNAL_DIR, 'meta'), { recursive: true });

    this.realRoot = realpathSync(this.root);
    this.tmpDir = join(this.realRoot, INTERNAL_DIR, 'tmp');
    this.metaDir = join(this.realRoot, INTERNAL_DIR, 'meta');
  }

  /**
   * The absolute path of a key's file, for tools that need a path (such as an image library).
   * Built from the key alone: unlike `get()`, it doesn't check for symbolic links on the way,
   * so keep links out of the root when handing paths to tools that follow them.
   */
  path(key: string): string {
    assertValidKey(key);
    return this.pathOf(this.checkKey(key));
  }

  // --- writes --------------------------------------------------------------------------

  protected async writeObject(
    key: string,
    body: AsyncIterable<Buffer>,
    file: StorageObjectWrite,
  ): Promise<StorageWriteResult> {
    const target = this.pathOf(this.checkKey(key));
    const tmp = join(this.tmpDir, randomUUID());
    let handle: FileHandle | undefined = await open(tmp, 'wx', 0o644);

    try {
      let size = 0;
      for await (const chunk of body) {
        await handle.write(chunk);
        size += chunk.byteLength;
      }

      await handle.sync();
      const stats = await handle.stat();
      await handle.close();
      handle = undefined;

      await this.commit(key, tmp, target, stats, sidecarOf(key, file));
      return { key, size, contentType: file.contentType, etag: etagOf(stats) };
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await rm(tmp, { force: true });
      throw error;
    }
  }

  protected async copyObject(from: string, to: string): Promise<StorageWriteResult> {
    const source = await this.openFile(from);
    const tmp = join(this.tmpDir, randomUUID());

    try {
      const meta = keepContentType(await this.readSidecar(from, source.stats), from, to);
      await source.handle.close();

      // A clone where the file system supports it (APFS, Btrfs, XFS), a copy elsewhere.
      await copyFile(source.path, tmp, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
      const stats = await lstat(tmp);
      const target = this.pathOf(this.checkKey(to));
      await this.commit(to, tmp, target, stats, meta);

      const contentType = meta?.contentType ?? contentTypeFromKey(to);
      return { key: to, size: stats.size, contentType, etag: etagOf(stats) };
    } catch (error) {
      await source.handle.close().catch(() => undefined);
      await rm(tmp, { force: true });
      throw error;
    }
  }

  protected override async moveObject(from: string, to: string): Promise<StorageWriteResult> {
    const source = await this.openFile(from);
    const meta = keepContentType(await this.readSidecar(from, source.stats), from, to);
    await source.handle.close();

    const target = this.pathOf(this.checkKey(to));
    // A rename keeps size and mtime, so the sidecar still matches the file.
    await this.commit(to, source.path, target, source.stats, meta);
    await rm(this.sidecarPath(from), { force: true });

    const contentType = meta?.contentType ?? contentTypeFromKey(to);
    return { key: to, size: source.stats.size, contentType, etag: etagOf(source.stats) };
  }

  /**
   * Renames `file` to `target`: the sidecar first (or the stale one removed), then the file.
   * A reader in between sees the old file, whose version no longer matches the sidecar, so it
   * gets inferred metadata rather than another version's.
   */
  private async commit(key: string, file: string, target: string, stats: Stats, sidecar: Sidecar | undefined) {
    await this.ensureParent(key, target);

    const metaPath = this.sidecarPath(key);
    if (sidecar) {
      const metaTmp = join(this.tmpDir, `${randomUUID()}.json`);
      await writeFile(metaTmp, JSON.stringify({ ...sidecar, for: etagOf(stats) }), { flag: 'wx' });
      await rename(metaTmp, metaPath).catch(async (error) => {
        await rm(metaTmp, { force: true });
        throw error;
      });
    } else {
      await rm(metaPath, { force: true });
    }

    try {
      await rename(file, target);
    } catch (error) {
      throw conflictOr(error, key);
    }
  }

  // --- reads ---------------------------------------------------------------------------

  protected async readObject(key: string, range: StorageRange | undefined): Promise<StorageDownload> {
    const { handle, stats } = await this.openFile(key);

    try {
      const file = await this.describe(key, stats);

      let bounds: { start: number; end: number } | undefined;
      if (range) {
        bounds = resolveRange(range, stats.size);
        if (!bounds) {
          throw new StorageRangeNotSatisfiableError(key, stats.size);
        }
      }

      // The stream owns the handle from here and closes it when it ends or is destroyed.
      const body = createReadStream('', {
        fd: handle,
        start: bounds?.start ?? 0,
        end: bounds ? bounds.end : Math.max(0, stats.size - 1),
        autoClose: true,
      });
      return bounds ? { ...file, range: bounds, body } : { ...file, body };
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  protected async headObject(key: string): Promise<StorageFile> {
    const { handle, stats } = await this.openFile(key);
    try {
      return await this.describe(key, stats);
    } finally {
      await handle.close();
    }
  }

  protected async deleteObjects(keys: string[]): Promise<void> {
    for (const key of keys) {
      const path = this.pathOf(this.checkKey(key));
      if (!(await this.parentInside(path))) {
        continue;
      }

      try {
        const stats = await lstat(path);
        // Only files: a directory (a prefix of other keys) or a link isn't a stored file.
        if (stats.isFile()) {
          await unlink(path);
        }
      } catch (error) {
        if (!isMissing(error)) {
          throw error;
        }
      }

      await rm(this.sidecarPath(key), { force: true });
    }
  }

  /**
   * Walks the directory under the prefix and sorts the keys, so the order matches S3's.
   * Every page reads the whole subtree: fine for development and moderate trees, not for
   * millions of files.
   */
  protected async listObjects(options: { prefix: string; cursor?: string; limit: number }): Promise<StorageListPage> {
    const after = options.cursor === undefined ? undefined : decodeCursor(options.cursor);
    const slash = options.prefix.lastIndexOf('/');
    const base = slash === -1 ? '' : options.prefix.slice(0, slash);

    const found: StorageListEntry[] = [];
    if (!isInternalDir(base.split('/', 1)[0]) && (base === '' || (await this.parentInside(this.pathOf(base + '/x'))))) {
      await this.walk(base, options.prefix, found);
    }

    const keys = found
      .filter((entry) => after === undefined || compareKeys(entry.key, after) > 0)
      .sort((a, b) => compareKeys(a.key, b.key));
    const page = keys.slice(0, options.limit);
    return { entries: page, cursor: keys.length > page.length ? encodeCursor(page[page.length - 1].key) : undefined };
  }

  private async walk(dirKey: string, prefix: string, found: StorageListEntry[]): Promise<void> {
    let names: string[];
    try {
      names = await readdir(dirKey === '' ? this.realRoot : this.pathOf(dirKey));
    } catch (error) {
      if (isMissing(error) || (error as NodeJS.ErrnoException).code === 'ENOTDIR') {
        return;
      }
      throw error;
    }

    for (const name of names) {
      if (dirKey === '' && isInternalDir(name)) {
        continue;
      }

      const key = dirKey === '' ? name : `${dirKey}/${name}`;
      // Skip what a key can't name, and everything outside the prefix
      if (!isListableName(name)) {
        continue;
      }
      if (!key.startsWith(prefix) && !prefix.startsWith(`${key}/`)) {
        continue;
      }

      const stats = await lstat(this.pathOf(key)).catch(() => undefined);
      if (stats?.isDirectory()) {
        await this.walk(key, prefix, found);
      } else if (stats?.isFile() && key.startsWith(prefix)) {
        found.push({ key, size: stats.size, lastModified: stats.mtime, etag: etagOf(stats) });
      }
    }
  }

  // --- paths and checks -------------------------------------------------------------------

  /** Case-insensitive: on macOS and Windows, `.NEST-STORAGE` is the same directory. */
  private checkKey(key: string): string {
    if (isInternalDir(key.split('/', 1)[0])) {
      throw new StorageInvalidKeyError(`"${INTERNAL_DIR}" is reserved on a local disk`);
    }
    return key;
  }

  /** Keys are validated (no `..`, no absolute paths, no backslashes), so this stays in the root. */
  private pathOf(key: string): string {
    return join(this.realRoot, ...key.split('/'));
  }

  /** Flat and hashed: `a` and `a.json/b` would collide in a mirrored tree. */
  private sidecarPath(key: string): string {
    return join(this.metaDir, `${createHash('sha256').update(key).digest('hex')}.json`);
  }

  /** Opens the file without following a link, after checking its directory resolves inside the root. */
  private async openFile(key: string): Promise<{ handle: FileHandle; stats: Stats; path: string }> {
    const path = this.pathOf(this.checkKey(key));
    if (!(await this.parentInside(path))) {
      throw new StorageFileNotFoundError(key);
    }

    let handle: FileHandle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (isMissing(error) || code === 'ELOOP' || code === 'ENOTDIR' || code === 'EMLINK') {
        throw new StorageFileNotFoundError(key);
      }
      if (code === 'ENAMETOOLONG') {
        throw tooLong();
      }
      throw error;
    }

    const stats = await handle.stat();
    if (!stats.isFile()) {
      await handle.close();
      throw new StorageFileNotFoundError(key);
    }

    return { handle, stats, path };
  }

  /** Whether the directory holding `path` resolves (through any links) to a place inside the root. */
  private async parentInside(path: string): Promise<boolean> {
    try {
      return this.inside(await realpath(dirname(path)));
    } catch (error) {
      if (isMissing(error) || (error as NodeJS.ErrnoException).code === 'ENOTDIR') {
        return false;
      }
      if ((error as NodeJS.ErrnoException).code === 'ENAMETOOLONG') {
        throw tooLong();
      }
      throw error;
    }
  }

  private inside(real: string): boolean {
    const rel = relative(this.realRoot, real);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !isInternalDir(rel.split(sep)[0]));
  }

  /**
   * Creates the key's directories. Before creating anything, the deepest directory that
   * already exists must resolve inside the root: `mkdir -p` follows links.
   */
  private async ensureParent(key: string, target: string): Promise<void> {
    const parent = dirname(target);
    let existing = parent;

    for (;;) {
      try {
        const real = await realpath(existing);
        if (!this.inside(real)) {
          throw new StorageInvalidKeyError('the key leads outside the disk\'s root through a link');
        }
        if (!(await lstat(real)).isDirectory()) {
          throw new StorageKeyConflictError(key);
        }
        break;
      } catch (error) {
        if (!isMissing(error)) {
          throw conflictOr(error, key);
        }
        existing = dirname(existing);
      }
    }

    if (existing !== parent) {
      try {
        await mkdir(parent, { recursive: true });
      } catch (error) {
        throw conflictOr(error, key);
      }

      if (!(await this.parentInside(target))) {
        throw new StorageInvalidKeyError('the key leads outside the disk\'s root through a link');
      }
    }
  }

  private async readSidecar(key: string, stats: Stats): Promise<Sidecar | undefined> {
    try {
      const sidecar = JSON.parse(await readFile(this.sidecarPath(key), 'utf8')) as Sidecar;
      return sidecar.for === etagOf(stats) ? sidecar : undefined;
    } catch {
      return undefined;
    }
  }

  private async describe(key: string, stats: Stats): Promise<StorageFile> {
    const sidecar = await this.readSidecar(key, stats);
    return {
      key,
      size: stats.size,
      contentType: sidecar?.contentType ?? contentTypeFromKey(key),
      lastModified: stats.mtime,
      etag: etagOf(stats),
      cacheControl: sidecar?.cacheControl,
      contentDisposition: sidecar?.contentDisposition,
      metadata: { ...sidecar?.metadata },
    };
  }
}

/**
 * A type inferred from the source's extension is stored explicitly when the new key would infer
 * another, so a copy or move keeps its type, as on the other disks.
 */
function keepContentType(sidecar: Sidecar | undefined, from: string, to: string): Sidecar | undefined {
  const contentType = sidecar?.contentType ?? contentTypeFromKey(from);
  const { contentType: _stored, ...rest } = sidecar ?? { for: '' };
  const next: Sidecar = contentType === contentTypeFromKey(to) ? rest : { ...rest, contentType };

  return Object.keys(next).length > 1 ? next : undefined;
}

/** Size and modification time, as Express's `serve-static` does. Stable across a rename. */
function etagOf(stats: Stats): string {
  return `"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs * 1000).toString(16)}"`;
}

function sidecarOf(key: string, file: StorageObjectWrite): Sidecar | undefined {
  const sidecar: Sidecar = { for: '' };
  if (file.explicitContentType && file.contentType !== contentTypeFromKey(key)) {
    sidecar.contentType = file.contentType;
  }
  if (file.cacheControl !== undefined) {
    sidecar.cacheControl = file.cacheControl;
  }
  if (file.contentDisposition !== undefined) {
    sidecar.contentDisposition = file.contentDisposition;
  }
  if (Object.keys(file.metadata).length > 0) {
    sidecar.metadata = file.metadata;
  }

  return Object.keys(sidecar).length > 1 ? sidecar : undefined;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

function isInternalDir(segment: string): boolean {
  return segment.toLowerCase() === INTERNAL_DIR;
}

/** A file where a directory must go, or the reverse: `a` and `a/b` can't both exist on a file system. */
function conflictOr(error: unknown, key: string): unknown {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === 'ENAMETOOLONG') {
    return tooLong();
  }
  if (code === 'ENOTDIR' || code === 'EISDIR' || code === 'EEXIST' || code === 'ENOTEMPTY') {
    return new StorageKeyConflictError(key);
  }
  return error;
}

/** The key is valid, but longer than this file system allows for a name or a path. */
function tooLong(): StorageInvalidKeyError {
  return new StorageInvalidKeyError('a segment or the whole path is longer than the local file system allows');
}

// eslint-disable-next-line no-control-regex
const listable = /^[^\u0000-\u001f\u007f-\u009f\\]+$/;
function isListableName(name: string): boolean {
  return name !== '.' && name !== '..' && listable.test(name);
}
