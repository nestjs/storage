import type { LocalDiskOptions } from '../interfaces/disk-options.interface.js';
import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream, mkdirSync, realpathSync, type BigIntStats, type Stats } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { contentTypeFromKey } from '../utils/content-type.util.js';
import { assertValidKey } from '../utils/keys.util.js';
import { StorageFileNotFoundError } from '../errors/storage-file-not-found.error.js';
import { StorageInvalidKeyError } from '../errors/storage-invalid-key.error.js';
import { StorageKeyConflictError } from '../errors/storage-key-conflict.error.js';
import { StorageRangeNotSatisfiableError } from '../errors/storage-range-not-satisfiable.error.js';
import { StorageError } from '../errors/storage.error.js';
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

/**
 * What a sidecar holds: what the file name can't tell. Its name is the version key of the file it
 * describes (see `versionKey()`). `from` is where that version was written before its rename,
 * relative to the root, as processes sharing a disk may mount it at different paths.
 */
interface Sidecar {
  from?: string;
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
 *   Each chunk is written completely; a write that makes no progress fails before committing.
 * - **Confined to `root`.** Keys can't contain `..`, absolute paths, backslashes or NUL (the
 *   rule every disk applies), the internal `.nest-storage` directory is off limits, and a
 *   symbolic link on the way to a file, or as the file, is refused, so a link placed inside
 *   the root can't lead reads or writes outside it.
 * - **Metadata** that the extension doesn't imply (an explicit content type, cache control,
 *   disposition, your metadata) is kept in a JSON sidecar, one per version of the file, at
 *   `.nest-storage/meta/<sha256 of the key>/<size-mtime-inode>.json`. A sidecar never describes
 *   another version, and concurrent writes to one key, from any process, never share one: the
 *   last write renamed over the key wins, with its metadata, as on the other disks.
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
        let offset = 0;
        while (offset < chunk.byteLength) {
          file.signal?.throwIfAborted();
          const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset, null);
          if (bytesWritten === 0) {
            throw new StorageError(`Local disk write made no progress for "${key}"`);
          }
          offset += bytesWritten;
          size += bytesWritten;
        }
      }

      await handle.sync();
      const stats = await handle.stat();
      if (stats.size !== size) {
        throw new StorageError(`Local disk write size does not match the written body for "${key}"`);
      }
      const version = this.versionKey(await handle.stat({ bigint: true }));

      await handle.close();
      handle = undefined;

      await this.commit(key, tmp, target, version, sidecarOf(key, file));
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
      const meta = keepContentType(await this.readSidecar(from, source.stats, source.version), from, to);
      await source.handle.close();

      // A clone where the file system supports it (APFS, Btrfs, XFS), a copy elsewhere.
      await copyFile(source.path, tmp, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
      const stats = await lstat(tmp);
      const version = this.versionKey(await lstat(tmp, { bigint: true }));
      const target = this.pathOf(this.checkKey(to));
      await this.commit(to, tmp, target, version, meta);

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
    const meta = keepContentType(await this.readSidecar(from, source.stats, source.version), from, to);
    await source.handle.close();

    const target = this.pathOf(this.checkKey(to));
    // A rename keeps size, mtime and inode, so the version doesn't change.
    await this.commit(to, source.path, target, source.version, meta);
    await this.removeStaleSidecars(from, source.path);
    await this.prune([dirname(source.path)]);

    const contentType = meta?.contentType ?? contentTypeFromKey(to);
    return { key: to, size: source.stats.size, contentType, etag: etagOf(source.stats) };
  }

  /**
   * Renames `file` to `target`: its version's sidecar first, then the file, then the sidecars of
   * versions no longer readable are removed. Each version has its own sidecar, so whichever of
   * several concurrent writes is renamed last, its sidecar is there, and a crash in between
   * leaves the old file with its own. On Windows, a rename onto a file another process has open
   * can fail (EPERM); that is untested.
   */
  private async commit(key: string, file: string, target: string, version: string, sidecar: Sidecar | undefined) {
    await this.ensureParent(key, target);

    const metaPath =
      sidecar && (await this.writeSidecar(key, version, { ...sidecar, from: relative(this.realRoot, file) }));
    try {
      await this.place(key, file, target);
    } catch (error) {
      if (metaPath) {
        await rm(metaPath, { force: true });
        await removeIfEmpty(dirname(metaPath));
      }
      throw error;
    }

    await this.removeStaleSidecars(key, target);
  }

  /** Written to a temp file, then renamed: `removeStaleSidecars()` may remove the key's directory in between. */
  private async writeSidecar(key: string, version: string, sidecar: Sidecar): Promise<string> {
    const dir = this.sidecarDir(key);
    const path = join(dir, `${version}.json`);
    const tmp = join(this.tmpDir, `${randomUUID()}.json`);
    await writeFile(tmp, JSON.stringify(sidecar), { flag: 'wx' });

    try {
      for (let attempt = 1; ; attempt++) {
        await mkdir(dir, { recursive: true });
        try {
          await rename(tmp, path);
          return path;
        } catch (error) {
          if (!isMissing(error) || attempt === 3) {
            throw error;
          }
        }
      }
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
  }

  /**
   * Removes a key's sidecars that no version at the key can read any more. A version whose file
   * is still at `from` is being written, and kept. Once it moved, it is the file at the key
   * (kept), or one that a later write replaced or a failed write removed: neither comes back.
   * It decides from the file system alone, so writes from other processes are safe.
   */
  private async removeStaleSidecars(key: string, target: string): Promise<void> {
    // TODO: remove after 0.1, with readLegacySidecar()
    await rm(this.legacySidecarPath(key), { force: true });

    const dir = this.sidecarDir(key);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (error) {
      if (isMissing(error)) {
        return;
      }
      throw error;
    }

    for (const name of names) {
      const path = join(dir, name);
      const from = (await readSidecarFile(path))?.from;
      if (from !== undefined && (await exists(join(this.realRoot, from)))) {
        continue;
      }
      // After `from` is gone: a version renamed after this check is a later one
      const current = await lstat(target, { bigint: true }).then(
        (stats) => (stats.isFile() ? this.versionKey(stats) : undefined),
        () => undefined,
      );
      if (name !== `${current}.json`) {
        await rm(path, { force: true });
      }
    }

    await removeIfEmpty(dir);
  }

  /**
   * Renames `file` over the key. An empty directory at the key (from a delete before pruning
   * existed, or from another tool) is removed first: it holds no key, so it can't conflict. A
   * directory that a concurrent delete pruned after `ensureParent()` is created again.
   */
  private async place(key: string, file: string, target: string): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await rename(file, target);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (attempt === 3) {
          throw conflictOr(error, key);
        }
        if (code === 'ENOENT') {
          await this.ensureParent(key, target);
        } else if (!(isDirectoryInTheWay(code) && (await removeIfEmpty(target)))) {
          throw conflictOr(error, key);
        }
      }
    }
  }

  // --- reads ---------------------------------------------------------------------------

  protected async readObject(key: string, range: StorageRange | undefined): Promise<StorageDownload> {
    const { handle, stats, version } = await this.openFile(key);

    try {
      const file = await this.describe(key, stats, version);

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
    const { handle, stats, version } = await this.openFile(key);
    try {
      return await this.describe(key, stats, version);
    } finally {
      await handle.close();
    }
  }

  protected async deleteObjects(keys: string[]): Promise<void> {
    const emptied = new Set<string>();
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
          emptied.add(dirname(path));
        }
      } catch (error) {
        if (!isMissing(error)) {
          throw error;
        }
      }

      await this.removeStaleSidecars(key, path);
    }

    await this.prune(emptied);
  }

  /**
   * Removes the directories a delete or a move left empty, up to (not including) the root, so
   * a deleted `a/b` doesn't keep `a` from being a key. Best effort: it stops at the first
   * directory that still holds something, or that it can't remove (EPERM or EBUSY, untested).
   * Deepest first, so a parent is tried after all its emptied children.
   */
  private async prune(dirs: Iterable<string>): Promise<void> {
    const deepestFirst = [...dirs].sort((a, b) => b.length - a.length);
    for (const start of deepestFirst) {
      for (let dir = start; dir.startsWith(this.realRoot + sep); dir = dirname(dir)) {
        if (!(await removeIfEmpty(dir))) {
          break;
        }
      }
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

  /** A directory per key, flat and hashed: `a` and `a.json/b` would collide in a mirrored tree. */
  private sidecarDir(key: string): string {
    return join(this.metaDir, createHash('sha256').update(key).digest('hex'));
  }

  /** Where 0.0.x kept the one sidecar of a key, tied to the etag by its `for` field. */
  private legacySidecarPath(key: string): string {
    return `${this.sidecarDir(key)}.json`;
  }

  /**
   * The name of a version's sidecar: size, modification time and inode, all kept by a rename.
   * Unlike the etag, two versions written at the same time never share it, even where timestamps
   * are coarse (seconds on HFS+ and FAT). Bigints, as Windows file IDs exceed 2^53.
   */
  private versionKey(stats: BigIntStats): string {
    return `${stats.size.toString(16)}-${stats.mtimeNs.toString(16)}-${stats.ino.toString(16)}`;
  }

  /** Opens the file without following a link, after checking its directory resolves inside the root. */
  private async openFile(key: string): Promise<{ handle: FileHandle; stats: Stats; version: string; path: string }> {
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

    return { handle, stats, version: this.versionKey(await handle.stat({ bigint: true })), path };
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
    // A first segment such as ..foo is a valid key: only .. or .. plus a separator leaves the root
    const leavesRoot = rel === '..' || rel.startsWith(`..${sep}`);
    return rel === '' || (!leavesRoot && !isAbsolute(rel) && !isInternalDir(rel.split(sep)[0]));
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
          throw new StorageInvalidKeyError("the key leads outside the disk's root through a link");
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
        throw new StorageInvalidKeyError("the key leads outside the disk's root through a link");
      }
    }
  }

  /** The sidecar of this version: by its version key, else by size and time, else a 0.0.x one. */
  private async readSidecar(key: string, stats: Stats, version: string): Promise<Sidecar | undefined> {
    const exact = await readSidecarFile(join(this.sidecarDir(key), `${version}.json`));
    if (exact) {
      return storedFields(exact);
    }

    const names = await readdir(this.sidecarDir(key)).catch(() => []);
    if (names.length > 0) {
      return this.readSameTimeSidecar(key, version, names);
    }
    return this.readLegacySidecar(key, stats);
  }

  /**
   * Where inode numbers might not last (assumed, untested: FAT on Linux, some network mounts),
   * the one sidecar of the same size and modification time stands in, unless it belongs to a
   * write still in flight: that one describes another file of the same size and time.
   */
  private async readSameTimeSidecar(key: string, version: string, names: string[]): Promise<Sidecar | undefined> {
    const sameTime = version.slice(0, version.lastIndexOf('-') + 1);
    const candidates = names.filter((name) => name.startsWith(sameTime));
    if (candidates.length !== 1) {
      return undefined;
    }

    const sidecar = await readSidecarFile(join(this.sidecarDir(key), candidates[0]));
    const inFlight = sidecar?.from !== undefined && (await exists(join(this.realRoot, sidecar.from)));
    return sidecar && !inFlight ? storedFields(sidecar) : undefined;
  }

  // TODO: remove after 0.1, with the legacy removal in removeStaleSidecars()
  /** A 0.0.x sidecar: one per key, flat, and tied to the file's etag by its `for` field. */
  private async readLegacySidecar(key: string, stats: Stats): Promise<Sidecar | undefined> {
    const legacy = await readSidecarFile(this.legacySidecarPath(key));
    return legacy?.for === etagOf(stats) ? storedFields(legacy) : undefined;
  }

  private async describe(key: string, stats: Stats, version: string): Promise<StorageFile> {
    const sidecar = await this.readSidecar(key, stats, version);
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
  const { contentType: _stored, ...rest } = sidecar ?? {};
  const next: Sidecar = contentType === contentTypeFromKey(to) ? rest : { ...rest, contentType };

  return Object.keys(next).length > 0 ? next : undefined;
}

/** A stored sidecar, or `undefined` when it is missing or unreadable. */
async function readSidecarFile(path: string): Promise<(Sidecar & { for?: string }) | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Sidecar & { for?: string };
  } catch {
    return undefined;
  }
}

/** What a stored sidecar says about the file, without the fields that tie it to a version. */
function storedFields({ contentType, cacheControl, contentDisposition, metadata }: Sidecar): Sidecar {
  return Object.fromEntries(
    Object.entries({ contentType, cacheControl, contentDisposition, metadata }).filter(
      ([, value]) => value !== undefined,
    ),
  );
}

/** Size and modification time, as Express's `serve-static` does. Stable across a rename. */
function etagOf(stats: Stats): string {
  return `"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs * 1000).toString(16)}"`;
}

function sidecarOf(key: string, file: StorageObjectWrite): Sidecar | undefined {
  const sidecar: Sidecar = {};
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

  return Object.keys(sidecar).length > 0 ? sidecar : undefined;
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
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

/** What `rename()` reports when a directory is at the target. EPERM is meant for Windows, which is untested. */
function isDirectoryInTheWay(code: string | undefined): boolean {
  return code === 'EISDIR' || code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'EPERM';
}

/** `rmdir` only removes an empty directory, and never follows a link: a file or a link fails with ENOTDIR. */
async function removeIfEmpty(dir: string): Promise<boolean> {
  return rmdir(dir).then(
    () => true,
    () => false,
  );
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
