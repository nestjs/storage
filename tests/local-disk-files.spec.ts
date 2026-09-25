/**
 * `LocalDisk` beyond confinement and atomicity (local-disk.spec.ts): what listings make of a
 * directory other tools also write to, how sidecars follow copies and moves, and how the root
 * itself is resolved.
 */
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  LocalDisk,
  StorageFileNotFoundError,
  StorageInvalidKeyError,
  StorageKeyConflictError,
  StorageRangeNotSatisfiableError,
} from '../lib/index.js';

const made: string[] = [];
const tempDir = (label: string) => {
  const dir = mkdtempSync(join(tmpdir(), `nest-storage-${label}-`));
  made.push(dir);
  return dir;
};
afterAll(() => made.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const listed = async (disk: LocalDisk, prefix?: string) => (await disk.list({ prefix })).entries.map((e) => e.key);

describe('LocalDisk', () => {
  let root: string;
  let disk: LocalDisk;
  const sidecars = () => readdirSync(join(root, '.nest-storage', 'meta'));
  const temps = () => readdirSync(join(root, '.nest-storage', 'tmp'));

  beforeEach(() => {
    root = tempDir('files');
    disk = new LocalDisk({ root });
  });

  describe('listings of a directory other tools write to', () => {
    it('skips names no key can hold, and symbolic links', async () => {
      await disk.put('ok/a.txt', 'a');
      writeFileSync(join(root, 'ok', 'back\\slash.txt'), 'x');
      writeFileSync(join(root, 'ok', 'ctrl\u0001.txt'), 'x');
      symlinkSync(join(root, 'ok', 'a.txt'), join(root, 'ok', 'link.txt'));

      expect(await listed(disk)).toEqual(['ok/a.txt']);
    });

    it('lists files written behind its back, with their size and an ETag', async () => {
      mkdirSync(join(root, 'imports', '2026'), { recursive: true });
      writeFileSync(join(root, 'imports', '2026', 'batch.csv'), 'id\n1\n');

      const page = await disk.list({ prefix: 'imports/' });
      expect(page.entries).toEqual([{ key: 'imports/2026/batch.csv', size: 5, lastModified: expect.any(Date), etag: expect.stringMatching(/^"5-[0-9a-f]+"$/) }]);
      expect((await disk.stat('imports/2026/batch.csv')).contentType).toBe('text/csv; charset=utf-8');
    });

    it('a prefix that runs through a file lists nothing', async () => {
      await disk.put('a.txt', 'x');
      expect(await listed(disk, 'a.txt/')).toEqual([]);
      expect(await listed(disk, 'a.txt/deeper/')).toEqual([]);
    });

    it('a prefix inside a missing directory lists nothing', async () => {
      expect(await listed(disk, 'nothing/here/')).toEqual([]);
    });
  });

  describe('directories are not files', () => {
    it('a key that is a directory (a prefix of other keys) is not found, and deleting it keeps its files', async () => {
      await disk.put('dir/a.txt', 'a');

      await expect(disk.stat('dir')).rejects.toBeInstanceOf(StorageFileNotFoundError);
      await expect(disk.getText('dir')).rejects.toBeInstanceOf(StorageFileNotFoundError);
      expect(await disk.exists('dir')).toBe(false);

      await disk.delete('dir');
      expect(await disk.getText('dir/a.txt')).toBe('a');
    });

    it('moving or copying onto a directory is a conflict, and the source stays', async () => {
      await disk.put('dir/a.txt', 'a');
      await disk.put('src.bin', 'payload', { metadata: { k: 'v' } });

      await expect(disk.copy('src.bin', 'dir')).rejects.toBeInstanceOf(StorageKeyConflictError);
      await expect(disk.move('src.bin', 'dir')).rejects.toBeInstanceOf(StorageKeyConflictError);

      expect(await disk.getText('src.bin')).toBe('payload');
      expect(temps()).toEqual([]);
    });

    it('a write that conflicts leaves no temp file and no sidecar', async () => {
      await disk.put('a', 'file');
      await expect(disk.put('a/b', 'x', { metadata: { k: 'v' } })).rejects.toBeInstanceOf(StorageKeyConflictError);

      expect(temps()).toEqual([]);
      expect(sidecars()).toEqual([]);
    });
  });

  describe('sidecars', () => {
    it('follow a move: the target keeps the metadata, the source leaves none behind', async () => {
      await disk.put('in/a.bin', 'x', { contentType: 'application/x-example', metadata: { owner: 'u1' }, cacheControl: 'private' });
      const before = await disk.stat('in/a.bin');
      expect(sidecars()).toHaveLength(1);

      const result = await disk.move('in/a.bin', 'out/a.bin');

      expect(sidecars()).toHaveLength(1);
      expect(result).toMatchObject({ contentType: 'application/x-example', etag: before.etag });
      expect(await disk.stat('out/a.bin')).toMatchObject({ contentType: 'application/x-example', metadata: { owner: 'u1' }, cacheControl: 'private', etag: before.etag });
    });

    it('are copied with the file', async () => {
      await disk.put('a.bin', 'x', { contentDisposition: 'inline' });
      await disk.copy('a.bin', 'b.bin');

      expect(sidecars()).toHaveLength(2);
      expect((await disk.stat('b.bin')).contentDisposition).toBe('inline');
    });

    it('a copy or a move to another extension keeps the stored type, as on the other disks', async () => {
      await disk.put('photo.jpg', 'x');
      await disk.put('scan.jpg', 'x');

      const copied = await disk.copy('photo.jpg', 'photo.png');
      const moved = await disk.move('scan.jpg', 'scan.bin');

      expect(copied.contentType).toBe('image/jpeg');
      expect(moved.contentType).toBe('image/jpeg');
      expect((await disk.stat('photo.png')).contentType).toBe('image/jpeg');
      expect((await disk.stat('scan.bin')).contentType).toBe('image/jpeg');
    });

    it('are not written for a type the extension already implies', async () => {
      await disk.put('a.pdf', 'x', { contentType: 'application/pdf' });
      expect(sidecars()).toEqual([]);
      expect((await disk.stat('a.pdf')).contentType).toBe('application/pdf');
    });

    it('are removed when the file is replaced without metadata', async () => {
      await disk.put('a.bin', 'x', { metadata: { v: '1' } });
      await disk.put('a.bin', 'y');

      expect(sidecars()).toEqual([]);
      expect((await disk.stat('a.bin')).metadata).toEqual({});
    });
  });

  it('any range of an empty file is not satisfiable', async () => {
    await disk.put('empty.bin', '');
    const error = await disk.get('empty.bin', { range: { start: 0 } }).catch((e) => e);
    expect(error).toBeInstanceOf(StorageRangeNotSatisfiableError);
    expect(error).toMatchObject({ size: 0 });
  });

  it('reads a whole empty file as an empty stream', async () => {
    await disk.put('empty.bin', '');
    expect(await disk.getBuffer('empty.bin')).toEqual(Buffer.alloc(0));
  });

  it('path() refuses the internal directory', () => {
    expect(() => disk.path('.nest-storage/meta/x.json')).toThrow(StorageInvalidKeyError);
    expect(() => disk.path('.NEST-STORAGE/tmp')).toThrow(StorageInvalidKeyError);
  });

  it('path() applies the key rule, so a key never leads outside the root', () => {
    for (const key of ['../../etc/passwd', '/etc/passwd', 'a//b', 'a\\..\\b']) {
      expect(() => disk.path(key)).toThrow(StorageInvalidKeyError);
    }
  });
});

describe('LocalDisk roots', () => {
  it('resolves a relative root against the working directory', async () => {
    const dir = tempDir('relative');
    const disk = new LocalDisk({ root: relative(process.cwd(), join(dir, 'files')) });

    expect(disk.root).toBe(join(dir, 'files'));
    await disk.put('a.txt', 'x');
    expect(readdirSync(join(dir, 'files'))).toContain('a.txt');
  });

  it('works through a root that is itself a symbolic link', async () => {
    const real = tempDir('real');
    const link = join(tempDir('links'), 'storage');
    symlinkSync(real, link);
    const disk = new LocalDisk({ root: link });

    await disk.put('docs/a.txt', 'through the link');

    expect(await disk.getText('docs/a.txt')).toBe('through the link');
    expect(disk.path('docs/a.txt')).toBe(join(realpathSync(real), 'docs', 'a.txt'));
    expect(await listed(disk)).toEqual(['docs/a.txt']);
  });

  it('two disks on one root see the same files', async () => {
    const root = tempDir('shared');
    const writer = new LocalDisk({ root });
    const reader = new LocalDisk({ root });

    await writer.put('a.bin', 'x', { metadata: { k: 'v' } });
    expect(await reader.stat('a.bin')).toMatchObject({ metadata: { k: 'v' } });
  });

  it('refuses a root that is not a string', () => {
    expect(() => new LocalDisk({ root: '' })).toThrow('LocalDisk needs a `root` directory');
    expect(() => new LocalDisk({ root: 42 as never })).toThrow(TypeError);
  });
});
