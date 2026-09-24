/**
 * One behavioral suite, run against every built-in disk: InMemoryDisk, LocalDisk (a temp
 * directory) and S3Disk (the fake S3, path-style and virtual-hosted). A key, a range, a
 * listing or a failure behaves the same on each, which is what lets an app develop on a local
 * disk, test on the in-memory one and run on S3.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  InMemoryDisk,
  LocalDisk,
  S3Disk,
  StorageBodyLengthError,
  StorageDisk,
  StorageError,
  StorageFileNotFoundError,
  StorageInvalidKeyError,
  StorageRangeNotSatisfiableError,
} from '../lib/index.js';
import { ACCESS_KEY, FakeS3, SECRET_KEY } from './fake-s3.js';

const fake = new FakeS3();
const dirs: string[] = [];
const signedUrls = { baseUrl: 'https://api.acme.example/files', keys: ['k'.repeat(32)] };
const publicUrl = 'https://cdn.acme.example/assets/';

beforeAll(() => fake.start());
afterAll(async () => {
  await fake.stop();
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const disks: [string, () => StorageDisk][] = [
  ['InMemoryDisk', () => new InMemoryDisk({ publicUrl, signedUrls })],
  [
    'LocalDisk',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'nest-storage-'));
      dirs.push(root);
      return new LocalDisk({ root, publicUrl, signedUrls });
    },
  ],
  [
    'S3Disk (path-style)',
    () => {
      fake.reset();
      return new S3Disk({
        bucket: 'acme',
        region: 'eu-central-1',
        endpoint: fake.ipEndpoint,
        credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
        publicUrl,
        retry: false,
      });
    },
  ],
  [
    'S3Disk (virtual-hosted, with a prefix)',
    () => {
      fake.reset();
      return new S3Disk({
        bucket: 'acme',
        region: 'eu-central-1',
        endpoint: fake.hostEndpoint,
        prefix: 'tenants/t1/',
        credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
        publicUrl,
        retry: false,
      });
    },
  ],
];

async function* generate(...parts: string[]) {
  for (const part of parts) {
    yield Buffer.from(part);
  }
}

const errorOf = (promise: Promise<unknown>) => promise.then(() => undefined, (error: unknown) => error);

describe.each(disks)('%s', (name, create) => {
  let disk: StorageDisk;
  beforeEach(() => {
    disk = create();
  });
  afterEach(() => {
    // Every request the S3 disk sent carried a valid signature
    expect(fake.signatureFailures).toEqual([]);
  });

  describe('put and get', () => {
    it.each([
      ['a Buffer', () => Buffer.from('hello')],
      ['a string', () => 'hello'],
      ['a Uint8Array', () => new TextEncoder().encode('hello')],
      ['a Readable', () => Readable.from([Buffer.from('he'), Buffer.from('llo')])],
      ['a web ReadableStream', () => new Blob(['he', 'llo']).stream()],
      ['an async generator', () => generate('he', 'l', 'lo')],
    ])('stores %s', async (_label, body) => {
      const result = await disk.put('notes/hello.txt', body());
      expect(result).toMatchObject({ key: 'notes/hello.txt', size: 5, contentType: 'text/plain; charset=utf-8' });
      expect(result.etag).toMatch(/^".+"$/);
      expect(await disk.getText('notes/hello.txt')).toBe('hello');
    });

    it('returns the body as a stream, with the metadata', async () => {
      await disk.put('covers/b1.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0]), {
        cacheControl: 'public, max-age=31536000, immutable',
        contentDisposition: 'inline',
        metadata: { BookId: 'b1', uploadedBy: 'staff-7' },
      });

      const download = await disk.get('covers/b1.jpg');
      const chunks: Buffer[] = [];
      for await (const chunk of download.body) {
        chunks.push(chunk as Buffer);
      }

      expect(Buffer.concat(chunks)).toEqual(Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
      expect(download).toMatchObject({
        key: 'covers/b1.jpg',
        size: 4,
        contentType: 'image/jpeg',
        cacheControl: 'public, max-age=31536000, immutable',
        contentDisposition: 'inline',
        metadata: { bookid: 'b1', uploadedby: 'staff-7' },
      });
      expect(download.lastModified).toBeInstanceOf(Date);
      expect(download.range).toBeUndefined();
      expect(await disk.stat('covers/b1.jpg')).toMatchObject({ size: 4, contentType: 'image/jpeg', metadata: { bookid: 'b1' } });
    });

    it('infers the content type from the extension, and an explicit one wins', async () => {
      await disk.put('a/invoice.PDF', 'x');
      await disk.put('a/noext', 'x');
      await disk.put('a/data.json', 'x', { contentType: 'application/vnd.acme+json' });

      expect((await disk.stat('a/invoice.PDF')).contentType).toBe('application/pdf');
      expect((await disk.stat('a/noext')).contentType).toBe('application/octet-stream');
      expect((await disk.stat('a/data.json')).contentType).toBe('application/vnd.acme+json');
    });

    it('stores an empty file', async () => {
      await disk.put('empty.txt', '');
      expect(await disk.getBuffer('empty.txt')).toEqual(Buffer.alloc(0));
      expect((await disk.stat('empty.txt')).size).toBe(0);
    });

    it('replaces a file, metadata included', async () => {
      await disk.put('x.txt', 'one', { metadata: { v: '1' }, cacheControl: 'no-store' });
      await disk.put('x.txt', 'two');

      expect(await disk.getText('x.txt')).toBe('two');
      const file = await disk.stat('x.txt');
      expect(file.metadata).toEqual({});
      expect(file.cacheControl).toBeUndefined();
    });

    it('stores keys with spaces, unicode and URL characters', async () => {
      const keys = ['a b/c+d.txt', 'zażółć/gęślą jaźń.txt', 'q/100%.txt', "odd/(1)!*'~@$&=;,.txt", 'emoji/📚.txt'];
      for (const key of keys) {
        await disk.put(key, key);
      }

      for (const key of keys) {
        expect(await disk.getText(key)).toBe(key);
      }

      const listed = [];
      for await (const entry of disk.listAll()) {
        listed.push(entry.key);
      }
      expect(listed.sort()).toEqual([...keys].sort());
    });

    it('throws StorageFileNotFoundError (status 404) for a missing file', async () => {
      for (const call of [() => disk.get('missing.txt'), () => disk.stat('missing.txt'), () => disk.getBuffer('missing.txt')]) {
        const error = await errorOf(call());
        expect(error).toBeInstanceOf(StorageFileNotFoundError);
        expect(error).toMatchObject({ status: 404, key: 'missing.txt' });
      }

      expect(await disk.exists('missing.txt')).toBe(false);
      await disk.put('present.txt', 'x');
      expect(await disk.exists('present.txt')).toBe(true);
    });
  });

  describe('failed writes leave nothing behind', () => {
    it('a body shorter or longer than contentLength', async () => {
      await disk.put('doc.txt', 'original');

      for (const [body, length] of [['12345', 4], ['123', 4]] as const) {
        const error = await errorOf(disk.put('doc.txt', generate(body), { contentLength: length }));
        expect(error).toBeInstanceOf(StorageBodyLengthError);
        expect(error).toMatchObject({ status: 400, expected: 4 });
      }
      expect(await disk.getText('doc.txt')).toBe('original');

      await expect(disk.put('new.txt', generate('12345'), { contentLength: 4 })).rejects.toThrow(StorageBodyLengthError);
      expect(await disk.exists('new.txt')).toBe(false);
    });

    it('a stream that fails mid-way', async () => {
      await disk.put('doc.txt', 'original');
      const failing = async function* () {
        yield Buffer.from('partial');
        throw new Error('upstream reset');
      };

      await expect(disk.put('doc.txt', failing())).rejects.toThrow('upstream reset');
      expect(await disk.getText('doc.txt')).toBe('original');
    });

    it('an aborted write', async () => {
      const controller = new AbortController();
      const slow = async function* () {
        yield Buffer.from('first');
        controller.abort(new Error('client went away'));
        yield Buffer.from('second');
      };

      await expect(disk.put('aborted.txt', slow(), { signal: controller.signal })).rejects.toThrow('client went away');
      expect(await disk.exists('aborted.txt')).toBe(false);
    });

    it('an abort while the body is stalled ends the write at once', async () => {
      const controller = new AbortController();
      const stalled = async function* () {
        yield Buffer.from('first');
        await new Promise(() => undefined); // a client that stopped sending
      };

      const put = disk.put('stalled.txt', stalled(), { signal: controller.signal });
      setTimeout(() => controller.abort(new Error('client went away')), 20);

      await expect(put).rejects.toThrow('client went away');
      expect(await disk.exists('stalled.txt')).toBe(false);
    });

    it('a body that is not bytes', async () => {
      await expect(disk.put('x', 42 as never)).rejects.toThrow(TypeError);
      await expect(disk.put('x', generate() as never)).resolves.toMatchObject({ size: 0 });
      await expect(disk.put('y', (async function* () { yield 42; })() as never)).rejects.toThrow(TypeError);
      expect(await disk.exists('y')).toBe(false);
    });
  });

  describe('ranges (S3 semantics)', () => {
    beforeEach(() => disk.put('r.bin', Buffer.from('0123456789')));

    it.each([
      [{ start: 2, end: 4 }, '234', { start: 2, end: 4 }],
      [{ start: 7 }, '789', { start: 7, end: 9 }],
      [{ start: 8, end: 100 }, '89', { start: 8, end: 9 }],
      [{ suffix: 3 }, '789', { start: 7, end: 9 }],
      [{ suffix: 50 }, '0123456789', { start: 0, end: 9 }],
      [{ start: 0, end: 0 }, '0', { start: 0, end: 0 }],
    ])('%o', async (range, text, resolved) => {
      const download = await disk.get('r.bin', { range });
      const chunks: Buffer[] = [];
      for await (const chunk of download.body) {
        chunks.push(chunk as Buffer);
      }

      expect(Buffer.concat(chunks).toString()).toBe(text);
      expect(download.range).toEqual(resolved);
      expect(download.size).toBe(10);
    });

    it('a range starting at or past the end is not satisfiable (status 416)', async () => {
      for (const range of [{ start: 10 }, { start: 50, end: 60 }, { suffix: 0 }]) {
        const error = await errorOf(disk.get('r.bin', { range }));
        expect(error).toBeInstanceOf(StorageRangeNotSatisfiableError);
        expect(error).toMatchObject({ status: 416 });
        if (!('suffix' in range)) {
          expect(error).toMatchObject({ size: 10 });
        }
      }
    });

    it('refuses malformed ranges before any request', async () => {
      await expect(disk.get('r.bin', { range: { start: 5, end: 2 } })).rejects.toThrow(TypeError);
      await expect(disk.get('r.bin', { range: { start: -1 } })).rejects.toThrow(TypeError);
      await expect(disk.get('r.bin', { range: { start: 1.5 } })).rejects.toThrow(TypeError);
    });
  });

  describe('delete, copy, move', () => {
    it('deletes one or many keys; missing ones are fine', async () => {
      await disk.put('d/1.txt', '1');
      await disk.put('d/2.txt', '2');
      await disk.put('d/3.txt', '3');

      await disk.delete('d/1.txt');
      await disk.delete(['d/2.txt', 'd/3.txt', 'd/missing.txt', 'd/2.txt']);
      await disk.delete([]);

      expect(await disk.exists('d/1.txt')).toBe(false);
      expect((await disk.list({ prefix: 'd/' })).entries).toEqual([]);
    });

    it('copies content and metadata', async () => {
      await disk.put('src/a.bin', 'payload', { contentType: 'application/x-acme', metadata: { owner: 'u1' } });
      const result = await disk.copy('src/a.bin', 'dst/nested/a.bin');

      expect(result).toMatchObject({ key: 'dst/nested/a.bin', size: 7, contentType: 'application/x-acme' });
      expect(await disk.getText('dst/nested/a.bin')).toBe('payload');
      expect(await disk.stat('dst/nested/a.bin')).toMatchObject({ contentType: 'application/x-acme', metadata: { owner: 'u1' } });
      expect(await disk.exists('src/a.bin')).toBe(true);
      await expect(disk.copy('src/missing', 'dst/x')).rejects.toMatchObject({ key: 'src/missing', status: 404 });
    });

    it('moves', async () => {
      await disk.put('incoming/u1', 'photo', { contentType: 'image/webp', metadata: { size: '5' } });
      await disk.put('avatars/old.webp', 'old');
      const result = await disk.move('incoming/u1', 'avatars/old.webp');

      expect(result).toMatchObject({ key: 'avatars/old.webp', size: 5, contentType: 'image/webp' });
      expect(await disk.exists('incoming/u1')).toBe(false);
      expect(await disk.getText('avatars/old.webp')).toBe('photo');
      expect((await disk.stat('avatars/old.webp')).metadata).toEqual({ size: '5' });
      await expect(disk.move('incoming/u1', 'x')).rejects.toBeInstanceOf(StorageFileNotFoundError);
    });

    it('copy and move onto the same key keep the file', async () => {
      await disk.put('same.txt', 'x');
      await disk.copy('same.txt', 'same.txt');
      await disk.move('same.txt', 'same.txt');
      expect(await disk.getText('same.txt')).toBe('x');
    });
  });

  describe('list', () => {
    // No two keys differ only in case: they are one file on a case-insensitive file system (see local-disk.spec.ts).
    const keys = ['docs/a-b.txt', 'docs/a/b.txt', 'docs/z.txt', 'docs/Zeta.txt', 'docs/é.txt', 'docs/ab.txt', 'other/x.txt'];
    beforeEach(async () => {
      for (const key of keys) {
        await disk.put(key, key);
      }
    });

    it('lists by prefix in UTF-8 byte order, with sizes', async () => {
      const page = await disk.list({ prefix: 'docs/' });
      expect(page.entries.map((e) => e.key)).toEqual(['docs/Zeta.txt', 'docs/a-b.txt', 'docs/a/b.txt', 'docs/ab.txt', 'docs/z.txt', 'docs/é.txt']);
      expect(page.entries[0]).toMatchObject({ size: 13 });
      expect(page.entries[0].lastModified).toBeInstanceOf(Date);
      expect(page.cursor).toBeUndefined();
    });

    it('matches a prefix that is not a whole segment', async () => {
      expect((await disk.list({ prefix: 'docs/a' })).entries.map((e) => e.key)).toEqual(['docs/a-b.txt', 'docs/a/b.txt', 'docs/ab.txt']);
      expect((await disk.list({ prefix: 'docs/a/' })).entries.map((e) => e.key)).toEqual(['docs/a/b.txt']);
      expect((await disk.list({ prefix: 'nothing/' })).entries).toEqual([]);
    });

    it('pages with a cursor', async () => {
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;

      do {
        const page = await disk.list({ limit: 2, cursor });
        expect(page.entries.length).toBeLessThanOrEqual(2);
        seen.push(...page.entries.map((e) => e.key));
        cursor = page.cursor;
        pages++;
      } while (cursor);

      expect(pages).toBe(4);
      expect(seen).toEqual([...keys].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))));
    });

    it('iterates everything with listAll()', async () => {
      const all = [];
      for await (const entry of disk.listAll({ prefix: 'docs/', limit: 4 })) {
        all.push(entry.key);
      }
      expect(all).toHaveLength(6);
    });

    it('validates its options', async () => {
      await expect(disk.list({ limit: 0 })).rejects.toThrow(TypeError);
      await expect(disk.list({ limit: 1001 })).rejects.toThrow(TypeError);
      await expect(disk.list({ prefix: '../' })).rejects.toThrow(StorageInvalidKeyError);
    });
  });

  describe('keys', () => {
    const invalid = ['', '/abs.txt', 'a//b', 'a/', '../etc/passwd', 'a/../../b', 'a/./b', '.', '..', 'a\\b', '..\\x', 'a\u0000b', 'line\nbreak', 'del\u007f', 'x'.repeat(1025), '\uD800lone'];

    it.each(invalid.map((key) => [JSON.stringify(key).slice(0, 40), key]))('refuses %s everywhere', async (_label, key) => {
      const calls = [
        () => disk.put(key, 'x'),
        () => disk.get(key),
        () => disk.stat(key),
        () => disk.exists(key),
        () => disk.delete(key),
        () => disk.copy('ok.txt', key),
        () => disk.move(key, 'ok.txt'),
        () => disk.signedUrl(key),
      ];

      for (const call of calls) {
        const error = await errorOf(call());
        expect(error).toBeInstanceOf(StorageInvalidKeyError);
        expect(error).toMatchObject({ status: 400 });
      }
      expect(() => disk.url(key)).toThrow(StorageInvalidKeyError);
    });

    // A local disk is also bound by its file system's limits (255 bytes a segment, and a
    // path length that macOS caps at 1024 bytes): see local-disk.spec.ts.
    it.skipIf(name === 'LocalDisk')('accepts a 1024-byte key', async () => {
      const key = `${'k'.repeat(201)}/${'é'.repeat(410)}/k`;
      expect(Buffer.byteLength(key)).toBe(1024);
      await disk.put(key, 'x');
      expect(await disk.getText(key)).toBe('x');
    });
  });

  describe('options', () => {
    it('refuses header injection and bad metadata', async () => {
      await expect(disk.put('x', 'x', { contentType: 'text/html\r\nSet-Cookie: a=b' })).rejects.toThrow(TypeError);
      await expect(disk.put('x', 'x', { cacheControl: 'no-store\n' })).rejects.toThrow(TypeError);
      await expect(disk.put('x', 'x', { metadata: { 'bad name': 'v' } })).rejects.toThrow(TypeError);
      await expect(disk.put('x', 'x', { metadata: { name: 'zażółć' } })).rejects.toThrow(TypeError);
      await expect(disk.put('x', 'x', { metadata: { a: '1', A: '2' } })).rejects.toThrow(TypeError);
      await expect(disk.put('x', 'x', { metadata: { big: 'v'.repeat(2100) } })).rejects.toThrow(TypeError);
      await expect(disk.put('x', 'x', { contentLength: -1 })).rejects.toThrow(TypeError);
      expect(await disk.exists('x')).toBe(false);
    });

    it('builds public URLs under publicUrl, with each segment encoded', () => {
      expect(disk.url('covers/a b/ż.jpg')).toBe('https://cdn.acme.example/assets/covers/a%20b/%C5%BC.jpg');
    });
  });

  if (!name.startsWith('S3Disk')) {
    it('signs app-served URLs that verifySignedUrl() accepts', async () => {
      const url = await disk.signedUrl('invoices/2026/INV-7.pdf', { expiresIn: '5m', filename: 'Faktura ż.pdf' });
      expect(url.startsWith('https://api.acme.example/files?key=invoices%2F2026%2FINV-7.pdf&expires=')).toBe(true);

      const claims = disk.verifySignedUrl(url);
      expect(claims).toMatchObject({
        key: 'invoices/2026/INV-7.pdf',
        method: 'GET',
        contentDisposition: `attachment; filename="Faktura _.pdf"; filename*=UTF-8''Faktura%20%C5%BC.pdf`,
      });

      const upload = await disk.signedUpload('incoming/x', { contentType: 'image/png', contentLength: 10 });
      expect(upload).toMatchObject({ method: 'PUT', headers: { 'content-type': 'image/png' } });
      expect(disk.verifySignedUrl(upload.url, 'PUT')).toMatchObject({ key: 'incoming/x', contentType: 'image/png', contentLength: 10 });
    });
  }

  it('without publicUrl, url() explains what is missing', () => {
    const bare = name === 'InMemoryDisk' ? new InMemoryDisk() : undefined;
    if (!bare) {
      return;
    }

    expect(() => bare.url('a')).toThrow(StorageError);
    expect(() => bare.url('a')).toThrow(/publicUrl/);
  });
});
