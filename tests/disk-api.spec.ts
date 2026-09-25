/**
 * The public API that `StorageDisk` implements for every disk (key rules, option checks, body
 * normalization, content types, public URLs, signed-URL expiry), exercised on `InMemoryDisk`
 * and on a minimal custom disk: what a third-party disk gets for free by extending the class.
 */
import { Readable } from 'node:stream';
import {
  type Duration,
  InMemoryDisk,
  Storage,
  StorageBodyLengthError,
  StorageDisk,
  StorageError,
  StorageFileNotFoundError,
  StorageInvalidKeyError,
  StorageKeyConflictError,
  StorageRangeNotSatisfiableError,
  StorageServiceError,
  StorageSignedUrlError,
  type StorageDownload,
  type StorageFile,
  type StorageListPage,
  type StorageObjectWrite,
  type StorageWriteResult,
} from '../lib/index.js';

const errorOf = (run: () => unknown) =>
  Promise.resolve()
    .then(run)
    .then(
      () => undefined,
      (error: unknown) => error,
    );

const keys = ['k'.repeat(32)];
const signedUrls = { baseUrl: 'https://api.example.com/files', keys };

describe('key rules', () => {
  const disk = new InMemoryDisk();

  it.each([
    [42, 'a key must be a string'],
    ['', 'a key cannot be empty'],
    ['x'.repeat(1025), 'a key cannot be longer than 1024 bytes'],
    ['a\u0085b', 'a key cannot contain control characters'],
    ['tab\there', 'a key cannot contain control characters'],
    ['a\\b', 'a key cannot contain a backslash'],
    ['/a', 'a key cannot start with "/"'],
    ['a/', 'a key cannot end with "/"'],
    ['a//b', 'a key cannot contain an empty segment ("//")'],
    ['a/../b', 'a key cannot contain "." or ".." segments'],
    ['\uDC00tail', 'a key must be valid Unicode'],
  ])('%j is refused with the reason "%s"', async (key, reason) => {
    const error = await errorOf(() => disk.put(key as string, 'x'));
    expect(error).toBeInstanceOf(StorageInvalidKeyError);
    expect(error).toMatchObject({ reason, status: 400, message: `Invalid storage key: ${reason}` });
  });

  it('counts UTF-8 bytes, not characters, against the 1024-byte limit', async () => {
    const fits = 'ż'.repeat(512);
    const over = `${fits}a`;
    expect(fits.length).toBe(512);

    await disk.put(fits, 'x');
    expect(await disk.exists(fits)).toBe(true);
    await expect(disk.put(over, 'x')).rejects.toBeInstanceOf(StorageInvalidKeyError);
  });

  it('accepts dots inside a segment and paired surrogates', async () => {
    for (const key of ['..hidden', 'a/...', 'v1.2/.env', 'music/🎵.mp3']) {
      await disk.put(key, key);
      expect(await disk.getText(key)).toBe(key);
    }
  });

  it('validates every key of a delete before deleting any', async () => {
    await disk.put('keep/a.txt', 'a');

    await expect(disk.delete(['keep/a.txt', '../escape'])).rejects.toBeInstanceOf(StorageInvalidKeyError);
    expect(await disk.exists('keep/a.txt')).toBe(true);
  });

  it('validates a list prefix, which may end with "/" or be empty', async () => {
    await expect(disk.list({ prefix: 'a//' })).rejects.toBeInstanceOf(StorageInvalidKeyError);
    await expect(disk.list({ prefix: '/a' })).rejects.toBeInstanceOf(StorageInvalidKeyError);
    await expect(disk.list({ prefix: 42 as never })).rejects.toMatchObject({ reason: 'a prefix must be a string' });
    await expect(disk.list({ prefix: '' })).resolves.toMatchObject({ entries: expect.any(Array) });
  });
});

describe('bodies', () => {
  let disk: InMemoryDisk;
  beforeEach(() => {
    disk = new InMemoryDisk();
  });

  it('stores only the bytes a Uint8Array view covers, not its whole buffer', async () => {
    const backing = Buffer.from('0123456789');
    const view = new Uint8Array(backing.buffer, backing.byteOffset + 3, 4);

    const result = await disk.put('view.bin', view);

    expect(result.size).toBe(4);
    expect((await disk.getBuffer('view.bin')).toString()).toBe('3456');
  });

  it('writes strings as UTF-8, and a stream of strings too', async () => {
    const direct = await disk.put('direct.txt', 'zażółć');
    expect(direct.size).toBe(Buffer.byteLength('zażółć'));

    await disk.put('stream.txt', Readable.from(['za', 'żółć']));
    expect(await disk.getText('stream.txt')).toBe('zażółć');
  });

  it('refuses a web stream that produces something other than bytes, and stores nothing', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue({ not: 'bytes' });
        controller.close();
      },
    });

    await expect(disk.put('odd.bin', stream as never)).rejects.toThrow('A storage body stream must produce bytes or strings');
    expect(disk.keys()).toEqual([]);
  });

  it.each([null, undefined, {}, 12n])('refuses %s as a body', async (body) => {
    await expect(disk.put('x', body as never)).rejects.toThrow(
      'A storage body must be a Buffer, Uint8Array, string, Readable, ReadableStream or async iterable of bytes',
    );
  });

  it('an in-memory body of another length than contentLength fails, reporting both lengths', async () => {
    const error = await errorOf(() => disk.put('short.txt', 'abc', { contentLength: 5 }));
    expect(error).toBeInstanceOf(StorageBodyLengthError);
    expect(error).toMatchObject({ expected: 5, received: 3, message: 'The body ended after 3 of the declared 5 bytes' });

    const longer = await errorOf(() => disk.put('long.txt', 'abcdef', { contentLength: 5 }));
    expect(longer).toMatchObject({ expected: 5, received: 6, message: 'The body is longer than the declared 5 bytes' });
    expect(disk.keys()).toEqual([]);
  });

  it('refuses a write whose signal is already aborted, with its reason', async () => {
    const reason = new Error('request cancelled');
    await expect(disk.put('x.txt', 'x', { signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    expect(disk.keys()).toEqual([]);
  });

  it('stops reading an endless source once it runs past contentLength', async () => {
    let finalized = false;
    const endless = (async function* () {
      try {
        for (;;) {
          yield Buffer.from('ab');
        }
      } finally {
        finalized = true;
      }
    })();

    await expect(disk.put('endless.bin', endless, { contentLength: 5 })).rejects.toMatchObject({ expected: 5, received: 6 });
    expect(finalized).toBe(true);
    expect(disk.keys()).toEqual([]);
  });
});

describe('put() options', () => {
  const disk = new InMemoryDisk();

  it.each([
    ['an empty contentType', { contentType: '' }],
    ['a blank contentType', { contentType: '   ' }],
    ['a non-ASCII contentType', { contentType: 'text/plain; name=ż' }],
    ['header injection through contentDisposition', { contentDisposition: 'inline\r\nX-Evil: 1' }],
    ['a metadata name starting with a dash', { metadata: { '-x': '1' } }],
    ['a metadata value that is not a string', { metadata: { n: 1 as never } }],
    ['a fractional contentLength', { contentLength: 1.5 }],
  ])('refuses %s', async (_label, options) => {
    await expect(disk.put('opt.txt', 'x', options)).rejects.toThrow(TypeError);
    expect(await disk.exists('opt.txt')).toBe(false);
  });

  it('allows 2048 bytes of metadata (names and values), and no more', async () => {
    await disk.put('meta.txt', 'x', { metadata: { a: 'v'.repeat(2047) } });
    expect((await disk.stat('meta.txt')).metadata.a).toHaveLength(2047);

    await expect(disk.put('meta.txt', 'x', { metadata: { a: 'v'.repeat(2048) } })).rejects.toThrow("metadata can't exceed 2048 bytes");
  });

  it('lowercases metadata names and accepts underscores and digits', async () => {
    await disk.put('m.txt', 'x', { metadata: { Owner_ID: '7', v2: 'yes' } });
    expect((await disk.stat('m.txt')).metadata).toEqual({ owner_id: '7', v2: 'yes' });
  });

  it('returns a copy of the metadata, so a caller cannot change the stored file', async () => {
    await disk.put('copy.txt', 'x', { metadata: { a: '1' } });
    const first = await disk.stat('copy.txt');
    first.metadata.a = 'changed';

    expect((await disk.stat('copy.txt')).metadata).toEqual({ a: '1' });
  });
});

describe('content types from the extension', () => {
  const disk = new InMemoryDisk();

  it.each([
    ['archive.tar.gz', 'application/gzip'],
    ['photo.JPEG', 'image/jpeg'],
    ['styles/site.css', 'text/css; charset=utf-8'],
    ['report.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['.htaccess', 'application/octet-stream'],
    ['trailing.', 'application/octet-stream'],
    ['release.v2/README', 'application/octet-stream'],
    ['data.unknownext', 'application/octet-stream'],
  ])('%s is stored as %s', async (key, type) => {
    const result = await disk.put(key, 'x');
    expect(result.contentType).toBe(type);
    expect((await disk.stat(key)).contentType).toBe(type);
  });
});

describe('ranges', () => {
  it('any range of an empty file is not satisfiable', async () => {
    const disk = new InMemoryDisk();
    await disk.put('empty.bin', '');

    for (const range of [{ start: 0 }, { start: 0, end: 0 }, { suffix: 1 }]) {
      const error = await errorOf(() => disk.get('empty.bin', { range }));
      expect(error).toBeInstanceOf(StorageRangeNotSatisfiableError);
      expect(error).toMatchObject({ size: 0, key: 'empty.bin' });
    }
  });

  it('refuses a suffix that is not a whole number', async () => {
    const disk = new InMemoryDisk();
    await disk.put('r.bin', '0123');

    await expect(disk.get('r.bin', { range: { suffix: -1 } })).rejects.toThrow('`range.suffix` must be a whole number of bytes');
    await expect(disk.get('r.bin', { range: { suffix: 1.5 } })).rejects.toThrow(TypeError);
    await expect(disk.get('r.bin', { range: { start: 0, end: -1 } })).rejects.toThrow(TypeError);
  });
});

describe('listings', () => {
  let disk: InMemoryDisk;
  beforeEach(async () => {
    disk = new InMemoryDisk();
    for (const key of ['a', 'b', 'c']) {
      await disk.put(key, key);
    }
  });

  it.each([
    ['an empty cursor', { cursor: '' }, 'must be the cursor of a previous page'],
    ['a cursor this disk never returned', { cursor: 'not/base64url!' }, 'is not a cursor this disk returned'],
    ['a fractional limit', { limit: 2.5 }, 'whole number from 1 to 1000'],
  ])('refuses %s', async (_label, options, message) => {
    await expect(disk.list(options)).rejects.toThrow(message);
  });

  it('a cursor continues after its key, even when that key was deleted meanwhile', async () => {
    const first = await disk.list({ limit: 1 });
    expect(first.entries.map((e) => e.key)).toEqual(['a']);

    await disk.delete('a');
    const second = await disk.list({ limit: 1, cursor: first.cursor });
    expect(second.entries.map((e) => e.key)).toEqual(['b']);
  });

  it('listAll() without options walks the whole disk', async () => {
    const all: string[] = [];
    for await (const entry of disk.listAll()) {
      all.push(entry.key);
    }
    expect(all).toEqual(['a', 'b', 'c']);
  });

  it('keys() is sorted in UTF-8 byte order, and clear() empties the disk', async () => {
    await disk.put('Ａ', 'fullwidth A');
    await disk.put('😀', 'astral');
    // In UTF-16 order the astral character (a surrogate pair from U+D83D) sorts before U+FF21; in UTF-8 after it.
    expect(disk.keys()).toEqual(['a', 'b', 'c', 'Ａ', '😀']);

    disk.clear();
    expect(disk.keys()).toEqual([]);
    expect((await disk.list()).entries).toEqual([]);
  });
});

describe('copy and move', () => {
  it('copy() and move() onto the same missing key fail as not found', async () => {
    const disk = new InMemoryDisk();
    await expect(disk.copy('none.txt', 'none.txt')).rejects.toBeInstanceOf(StorageFileNotFoundError);
    await expect(disk.move('none.txt', 'none.txt')).rejects.toBeInstanceOf(StorageFileNotFoundError);
  });

  it('a copy is independent of its source', async () => {
    const disk = new InMemoryDisk();
    await disk.put('src.txt', 'one', { metadata: { v: '1' } });
    await disk.copy('src.txt', 'dst.txt');
    await disk.put('src.txt', 'two', { metadata: { v: '2' } });

    expect(await disk.getText('dst.txt')).toBe('one');
    expect((await disk.stat('dst.txt')).metadata).toEqual({ v: '1' });
  });
});

describe('public URLs', () => {
  it('adds a slash after a base URL without one, and encodes every reserved character', () => {
    const disk = new InMemoryDisk({ publicUrl: 'https://cdn.example.com/assets' });
    expect(disk.url("it's (1)*!.txt")).toBe('https://cdn.example.com/assets/it%27s%20%281%29%2A%21.txt');
    expect(disk.url('a/#?.txt')).toBe('https://cdn.example.com/assets/a/%23%3F.txt');
  });

  it('takes a URL instance', () => {
    const disk = new InMemoryDisk({ publicUrl: new URL('http://localhost:3000/') });
    expect(disk.url('a.txt')).toBe('http://localhost:3000/a.txt');
  });

  it.each(['ftp://cdn.example.com', 'https://cdn.example.com/?v=1', 'https://cdn.example.com/#top', 'cdn.example.com', 'not a url'])(
    'refuses %s at startup, naming the disk class',
    (publicUrl) => {
      expect(() => new InMemoryDisk({ publicUrl })).toThrow('InMemoryDisk `publicUrl` must be an absolute http(s) URL without a query');
    },
  );
});

describe('signed URL expiry and options', () => {
  const now = Date.UTC(2026, 0, 1, 12, 0, 0);
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const disk = new InMemoryDisk({ signedUrls });

  it('expires after 15 minutes by default', async () => {
    const claims = disk.verifySignedUrl(await disk.signedUrl('a.txt'));
    expect(claims.expiresAt).toEqual(new Date(now + 15 * 60_000));
  });

  it.each([
    [1000, now + 1000],
    ['90s', now + 90_000],
    ['1.5h', now + 5_400_000],
    ['7d', now + 7 * 86_400_000],
  ] as const)('expiresIn %j', async (expiresIn, at) => {
    const claims = disk.verifySignedUrl(await disk.signedUrl('a.txt', { expiresIn }));
    expect(claims.expiresAt.getTime()).toBe(at);
  });

  it.each<Duration>([999, '0s', '7d1ms' as never, 7 * 86_400_000 + 1000])('refuses expiresIn %j', async (expiresIn) => {
    await expect(disk.signedUrl('a.txt', { expiresIn })).rejects.toThrow(TypeError);
  });

  it('explains a malformed duration', async () => {
    await expect(disk.signedUrl('a.txt', { expiresIn: 'soon' as never })).rejects.toThrow('`expiresIn`: Invalid duration "soon"');
    await expect(disk.signedUrl('a.txt', { expiresIn: -5 })).rejects.toThrow('`expiresIn`: Invalid duration -5');
  });

  it('signs the disposition: inline, inline with a name, or an attachment with a name', async () => {
    const claims = async (options: object) => disk.verifySignedUrl(await disk.signedUrl('docs/a.pdf', options)).contentDisposition;

    expect(await claims({})).toBeUndefined();
    expect(await claims({ disposition: 'inline' })).toBe('inline');
    expect(await claims({ disposition: 'inline', filename: 'a.pdf' })).toBe('inline; filename="a.pdf"');
    expect(await claims({ filename: 'dir/a.pdf/' })).toBe('attachment; filename="download"');
    await expect(disk.signedUrl('docs/a.pdf', { filename: '' })).rejects.toThrow('`filename` must be a non-empty string');
  });

  it('checks signedUpload() options before signing', async () => {
    await expect(disk.signedUpload('u.bin', {} as never)).rejects.toThrow('`contentType` must be a non-empty string');
    await expect(disk.signedUpload('u.bin', { contentType: 'image/png\r\nX: y' })).rejects.toThrow(TypeError);
    await expect(disk.signedUpload('u.bin', { contentType: 'image/png', contentLength: -1 })).rejects.toThrow('`contentLength` must be a whole number');
    await expect(disk.signedUpload('u.bin', { contentType: 'image/png', contentLength: 2.5 })).rejects.toThrow(TypeError);
    await expect(disk.signedUpload('../u.bin', { contentType: 'image/png' })).rejects.toBeInstanceOf(StorageInvalidKeyError);

    const upload = await disk.signedUpload('u.bin', { contentType: 'image/png', contentLength: 0, expiresIn: '1m' });
    expect(upload.expiresAt).toEqual(new Date(now + 60_000));
    expect(disk.verifySignedUrl(upload.url, 'PUT')).toMatchObject({ contentLength: 0, contentType: 'image/png' });
  });

  it('signedUpload() and verifySignedUrl() without signedUrls explain what to configure', async () => {
    const bare = new InMemoryDisk();
    await expect(bare.signedUpload('a', { contentType: 'x/y' })).rejects.toThrow("has no `signedUrls` option, so signedUpload() can't be used");
    expect(() => bare.verifySignedUrl('https://x/files?key=a')).toThrow("so verifySignedUrl() can't be used");
  });
});

/** The smallest disk a third party could write: a Map, and nothing else. */
class MapDisk extends StorageDisk {
  readonly files = new Map<string, { data: Buffer; file: StorageObjectWrite }>();
  readonly calls: string[] = [];

  constructor(options: { publicUrl?: string } = {}) {
    super(options);
  }

  protected async writeObject(key: string, body: AsyncIterable<Buffer>, file: StorageObjectWrite): Promise<StorageWriteResult> {
    this.calls.push(`write ${key}`);
    const chunks: Buffer[] = [];
    for await (const chunk of body) {
      chunks.push(chunk);
    }
    this.files.set(key, { data: Buffer.concat(chunks), file });
    return { key, size: Buffer.concat(chunks).length, contentType: file.contentType };
  }

  protected async readObject(key: string): Promise<StorageDownload> {
    return { ...(await this.headObject(key)), body: Readable.from([this.files.get(key)!.data]) };
  }

  protected async headObject(key: string): Promise<StorageFile> {
    this.calls.push(`head ${key}`);
    const entry = this.files.get(key);
    if (!entry) {
      throw new StorageFileNotFoundError(key);
    }
    return { key, size: entry.data.length, contentType: entry.file.contentType, lastModified: new Date(0), metadata: entry.file.metadata };
  }

  protected async deleteObjects(keys: string[]): Promise<void> {
    this.calls.push(`delete ${keys.join(',')}`);
    for (const key of keys) {
      this.files.delete(key);
    }
  }

  protected async listObjects(): Promise<StorageListPage> {
    return { entries: [] };
  }

  protected async copyObject(from: string, to: string): Promise<StorageWriteResult> {
    this.calls.push(`copy ${from} ${to}`);
    const entry = this.files.get(from);
    if (!entry) {
      throw new StorageFileNotFoundError(from);
    }
    this.files.set(to, entry);
    return { key: to, size: entry.data.length, contentType: entry.file.contentType };
  }
}

describe('a custom disk extending StorageDisk', () => {
  it('gets validated keys and normalized write options', async () => {
    const disk = new MapDisk();
    await expect(disk.put('../x', 'x')).rejects.toBeInstanceOf(StorageInvalidKeyError);
    await disk.put('docs/a.pdf', Readable.from(['%PDF']), { metadata: { Owner: 'u1' } });

    expect(disk.calls).toEqual(['write docs/a.pdf']);
    expect(disk.files.get('docs/a.pdf')!.file).toMatchObject({
      contentType: 'application/pdf',
      explicitContentType: false,
      metadata: { owner: 'u1' },
    });
    expect(disk.files.get('docs/a.pdf')!.file.contentLength).toBeUndefined();

    await disk.put('b.bin', 'four', { contentType: 'application/x-example' });
    expect(disk.files.get('b.bin')!.file).toMatchObject({ contentType: 'application/x-example', explicitContentType: true, contentLength: 4 });
  });

  it('moves by copying then deleting the source, unless it overrides moveObject()', async () => {
    const disk = new MapDisk();
    await disk.put('from.txt', 'x');
    disk.calls.length = 0;

    const result = await disk.move('from.txt', 'to.txt');

    expect(result).toMatchObject({ key: 'to.txt', size: 1 });
    expect(disk.calls).toEqual(['copy from.txt to.txt', 'delete from.txt']);
    expect([...disk.files.keys()]).toEqual(['to.txt']);
  });

  it('dedupes the keys it is asked to delete, and skips the call for none', async () => {
    const disk = new MapDisk();
    await disk.delete([]);
    await disk.delete(['a', 'b', 'a']);
    expect(disk.calls).toEqual(['delete a,b']);
  });

  it('exists() is false only for a missing file: other failures propagate', async () => {
    const disk = new MapDisk();
    expect(await disk.exists('missing')).toBe(false);

    vi.spyOn(disk as unknown as { headObject: () => Promise<never> }, 'headObject').mockRejectedValue(new Error('backend down'));
    await expect(disk.exists('any')).rejects.toThrow('backend down');
  });

  it('names its own class when something is not configured', async () => {
    const disk = new MapDisk();
    expect(() => disk.url('a')).toThrow("MapDisk has no `publicUrl`, so url() can't build a public URL");
    await expect(disk.signedUrl('a')).rejects.toThrow("MapDisk has no `signedUrls` option, so signedUrl() can't be used");
    expect(() => new MapDisk({ publicUrl: 'nope' })).toThrow('MapDisk `publicUrl`');
  });
});

describe('Storage', () => {
  it('resolves disks by name, the default one without a name', () => {
    const a = new InMemoryDisk();
    const b = new InMemoryDisk();
    const storage = new Storage(new Map([['a', a], ['b', b]]), 'b');

    expect(storage.disk()).toBe(b);
    expect(storage.disk('a')).toBe(a);
    expect(storage.names()).toEqual(['a', 'b']);
    expect(() => storage.disk('c')).toThrow(StorageError);
  });
});

describe('errors', () => {
  it('each error is a StorageError named after its class, with its status', () => {
    const errors = [
      [new StorageFileNotFoundError('a.txt'), 404, 'No file at "a.txt"'],
      [new StorageInvalidKeyError('bad'), 400, 'Invalid storage key: bad'],
      [new StorageBodyLengthError(4, 2), 400, 'The body ended after 2 of the declared 4 bytes'],
      [new StorageRangeNotSatisfiableError('r.bin', 10), 416, 'The requested range of "r.bin" is not satisfiable'],
      [new StorageKeyConflictError('a/b'), 409, '"a/b" conflicts with an existing file or directory on this disk'],
      [new StorageSignedUrlError('expired'), 403, 'The signed URL has expired'],
      [new StorageSignedUrlError('method'), 403, 'The signed URL was issued for another method'],
      [new StorageSignedUrlError('missing'), 403, 'The signed URL is invalid'],
    ] as const;

    for (const [error, status, message] of errors) {
      expect(error).toBeInstanceOf(StorageError);
      expect(error.name).toBe(error.constructor.name);
      expect(error.status).toBe(status);
      expect(error.message).toBe(message);
    }
  });

  it('StorageServiceError describes the operation, code and upstream status, and keeps the cause', () => {
    const cause = new Error('socket hang up');
    const full = new StorageServiceError({ operation: 'GetObject', code: 'SlowDown', upstreamStatus: 503, message: 'Reduce your rate', requestId: 'r1', cause });
    expect(full.message).toBe('GetObject failed: SlowDown (503): Reduce your rate');
    expect(full).toMatchObject({ name: 'StorageServiceError', operation: 'GetObject', code: 'SlowDown', upstreamStatus: 503, requestId: 'r1', cause });
    expect('status' in full).toBe(false);

    const bare = new StorageServiceError({ operation: 'PutObject', code: 'NetworkError' });
    expect(bare.message).toBe('PutObject failed: NetworkError');
    expect(bare.cause).toBeUndefined();
  });
});
