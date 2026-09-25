import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalDisk, StorageFileNotFoundError, StorageInvalidKeyError, StorageKeyConflictError } from '../lib/index.js';

const made: string[] = [];
const tempDir = (label: string) => {
  const dir = mkdtempSync(join(tmpdir(), `nest-storage-${label}-`));
  made.push(dir);
  return dir;
};
afterAll(() => made.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe('LocalDisk', () => {
  let root: string;
  let outside: string;
  let disk: LocalDisk;

  beforeEach(() => {
    root = tempDir('root');
    outside = tempDir('outside');
    writeFileSync(join(outside, 'secret.txt'), 'top secret');
    disk = new LocalDisk({ root });
  });

  it('creates the root, and fails at startup without one', () => {
    const fresh = join(tempDir('parent'), 'a', 'b');
    new LocalDisk({ root: fresh });
    expect(existsSync(fresh)).toBe(true);
    expect(() => new LocalDisk({} as never)).toThrow('LocalDisk needs a `root` directory');
  });

  it('writes plain files under the root', async () => {
    await disk.put('photos/2026/p1.jpg', 'jpeg');
    expect(readFileSync(join(root, 'photos', '2026', 'p1.jpg'), 'utf8')).toBe('jpeg');
    expect(disk.path('photos/2026/p1.jpg')).toBe(join(disk['realRoot' as never] as string, 'photos', '2026', 'p1.jpg'));
  });

  describe('confinement', () => {
    it('never resolves a key outside the root', async () => {
      for (const key of ['../outside/secret.txt', `..${'/..'.repeat(20)}/etc/passwd`, join(outside, 'secret.txt'), '..\\secret.txt']) {
        await expect(disk.getText(key)).rejects.toBeInstanceOf(StorageInvalidKeyError);
        await expect(disk.put(key, 'x')).rejects.toBeInstanceOf(StorageInvalidKeyError);
      }
      expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('top secret');
    });

    it('refuses a symbolic link as the file', async () => {
      symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'));
      await expect(disk.getText('link.txt')).rejects.toBeInstanceOf(StorageFileNotFoundError);
      await expect(disk.stat('link.txt')).rejects.toBeInstanceOf(StorageFileNotFoundError);
      await expect(disk.copy('link.txt', 'copy.txt')).rejects.toBeInstanceOf(StorageFileNotFoundError);
      await expect(disk.move('link.txt', 'moved.txt')).rejects.toBeInstanceOf(StorageFileNotFoundError);

      // Deleting it leaves the link (and its target) alone
      await disk.delete('link.txt');
      expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('top secret');

      // Writing replaces the link itself, not its target
      await disk.put('link.txt', 'new');
      expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('top secret');
      expect(readFileSync(join(root, 'link.txt'), 'utf8')).toBe('new');
    });

    it('refuses a symbolic link on the way to the file', async () => {
      symlinkSync(outside, join(root, 'escape'));

      await expect(disk.getText('escape/secret.txt')).rejects.toBeInstanceOf(StorageFileNotFoundError);
      await expect(disk.exists('escape/secret.txt')).resolves.toBe(false);
      await expect(disk.put('escape/planted.txt', 'x')).rejects.toBeInstanceOf(StorageInvalidKeyError);
      await expect(disk.put('escape/deeper/planted.txt', 'x')).rejects.toBeInstanceOf(StorageInvalidKeyError);
      await expect(disk.copy('escape/secret.txt', 'stolen.txt')).rejects.toBeInstanceOf(StorageFileNotFoundError);

      await disk.delete('escape/secret.txt');
      expect(readdirSync(outside).sort()).toEqual(['secret.txt']);
      expect((await disk.list()).entries.map((e) => e.key)).toEqual([]);
      expect((await disk.list({ prefix: 'escape/' })).entries).toEqual([]);
    });

    it('allows links that stay inside the root', async () => {
      mkdirSync(join(root, 'real'));
      symlinkSync(join(root, 'real'), join(root, 'alias'));
      await disk.put('alias/file.txt', 'inside');
      expect(await disk.getText('real/file.txt')).toBe('inside');
      expect(await disk.getText('alias/file.txt')).toBe('inside');
    });

    it('keeps its internal directory out of reach', async () => {
      await disk.put('a.txt', 'x', { metadata: { m: '1' } });

      // Whatever the case: a case-insensitive file system would reach it through `.NEST-STORAGE`
      for (const key of ['.nest-storage/tmp/x', '.nest-storage', '.nest-storage/meta/abc.json', '.NEST-STORAGE/tmp/x', '.Nest-Storage']) {
        await expect(disk.put(key, 'x')).rejects.toBeInstanceOf(StorageInvalidKeyError);
        await expect(disk.get(key)).rejects.toBeInstanceOf(StorageInvalidKeyError);
      }

      expect((await disk.list()).entries.map((e) => e.key)).toEqual(['a.txt']);
      expect((await disk.list({ prefix: '.nest-storage/' })).entries).toEqual([]);

      // Dot files are ordinary keys
      await disk.put('.well-known/security.txt', 'x');
      expect(await disk.getText('.well-known/security.txt')).toBe('x');
    });
  });

  describe('atomic writes', () => {
    it('leaves no temp files, after success or failure', async () => {
      await disk.put('ok.txt', 'x');
      await expect(
        disk.put('ok.txt', (async function* () {
          yield Buffer.from('partial');
          throw new Error('boom');
        })()),
      ).rejects.toThrow('boom');

      expect(readdirSync(join(root, '.nest-storage', 'tmp'))).toEqual([]);
      expect(readFileSync(join(root, 'ok.txt'), 'utf8')).toBe('x');
    });

    it('a reader sees the old file or the new one, never a partial one', async () => {
      const before = 'A'.repeat(256 * 1024);
      const after = 'B'.repeat(512 * 1024);
      await disk.put('big.txt', before);

      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const writing = disk.put('big.txt', (async function* () {
        yield Buffer.from(after.slice(0, 1000));
        await gate;
        yield Buffer.from(after.slice(1000));
      })());

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(await disk.getText('big.txt')).toBe(before);

      release();
      await writing;
      expect(await disk.getText('big.txt')).toBe(after);
    });

    it('a stream that was opened keeps reading the version it opened', async () => {
      await disk.put('v.txt', 'version-1');
      const { body } = await disk.get('v.txt');
      await disk.put('v.txt', 'version-2');

      let text = '';
      for await (const chunk of body) {
        text += chunk;
      }
      expect(text).toBe('version-1');
    });
  });

  describe('file system limits', () => {
    it('a key and a key under it can not both exist', async () => {
      await disk.put('a', 'file');
      await expect(disk.put('a/b', 'x')).rejects.toBeInstanceOf(StorageKeyConflictError);

      await disk.put('dir/child', 'x');
      const error = await disk.put('dir', 'x').catch((e) => e);
      expect(error).toBeInstanceOf(StorageKeyConflictError);
      expect(error.status).toBe(409);
      await expect(disk.getText('dir')).rejects.toBeInstanceOf(StorageFileNotFoundError);
      expect(await disk.getText('a')).toBe('file');
    });

    it('a segment longer than the file system allows is an invalid key', async () => {
      const key = `long/${'x'.repeat(300)}`;
      await expect(disk.put(key, 'x')).rejects.toBeInstanceOf(StorageInvalidKeyError);
      await expect(disk.get(key)).rejects.toBeInstanceOf(StorageInvalidKeyError);
    });

    it.runIf(process.platform === 'darwin')('keys that differ only in case are one file on a case-insensitive file system', async () => {
      await disk.put('Photo.jpg', 'upper');
      await disk.put('photo.jpg', 'lower');
      expect(await disk.getText('Photo.jpg')).toBe('lower');
    });
  });

  describe('metadata sidecars', () => {
    it('keeps only what the extension does not imply', async () => {
      await disk.put('plain.pdf', 'x');
      expect(readdirSync(join(root, '.nest-storage', 'meta'))).toEqual([]);
      await disk.put('typed.bin', 'x', { contentType: 'application/x-example' });
      expect(readdirSync(join(root, '.nest-storage', 'meta'))).toHaveLength(1);
      await disk.delete('typed.bin');
      expect(readdirSync(join(root, '.nest-storage', 'meta'))).toEqual([]);
    });

    it('ignores a sidecar that describes another version of the file', async () => {
      await disk.put('doc.bin', 'one', { contentType: 'application/x-one', metadata: { v: '1' } });
      // Someone replaces the file behind the disk's back
      writeFileSync(join(root, 'doc.bin'), 'changed!');
      const file = await disk.stat('doc.bin');
      expect(file).toMatchObject({ contentType: 'application/octet-stream', metadata: {} });
    });

    it('keys whose sidecars would collide in a mirrored tree', async () => {
      await disk.put('a', 'a', { metadata: { k: 'a' } });
      await disk.put('a.json/b', 'b', { metadata: { k: 'b' } });
      expect((await disk.stat('a')).metadata).toEqual({ k: 'a' });
      expect((await disk.stat('a.json/b')).metadata).toEqual({ k: 'b' });
    });
  });
});
