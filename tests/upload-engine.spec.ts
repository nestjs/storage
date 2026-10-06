/**
 * `uploadToDisk()` against the storage engine contract itself, with synthetic file streams:
 * the cases the adapters produce only under load or bad luck (a client that vanishes, a
 * stream that errors, busboy truncating at the limit), and the two parsers' rules on what an
 * engine may do with the stream.
 *
 * The contract of `@nestjs/platform-fastify/multipart` (nestjs/nest#17835, `storeFile()` in
 * multipart.parser.ts) treats a file stream that closes without ending and without an error
 * as an aborted upload, and removes what the engine stored once it calls back. So the engine
 * must never destroy the stream: on its own errors it drains the rest instead.
 */
import { PassThrough } from 'node:stream';
import { PayloadTooLargeException } from '@nestjs/common';
import { InMemoryDisk, type StoredUpload, type UploadStorageEngine, uploadToDisk } from '../lib/index.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);

function incoming(stream: PassThrough, originalname = 'a.png', mimetype = 'image/png') {
  const file = { fieldname: 'file', originalname, encoding: '7bit', mimetype };
  Object.defineProperty(file, 'stream', { value: stream, enumerable: false });
  return file as typeof file & { stream: PassThrough };
}

function handle(engine: UploadStorageEngine, file: object) {
  return new Promise<{ error?: any; info?: Partial<StoredUpload> }>((resolve) =>
    engine._handleFile({}, file, (error, info) => resolve({ error, info })),
  );
}

describe('uploadToDisk() engine', () => {
  let disk: InMemoryDisk;
  beforeEach(() => {
    disk = new InMemoryDisk();
  });

  it('stores a stream that arrives in pieces, and reports what it stored', async () => {
    const engine = uploadToDisk({ disk, key: (file) => `k${file.extension}` });
    const stream = new PassThrough();
    const result = handle(engine, incoming(stream));

    stream.write(PNG.subarray(0, 3));
    stream.write(PNG.subarray(3));
    stream.end(Buffer.alloc(100, 1));

    const { error, info } = await result;
    expect(error).toBeNull();
    expect(info).toEqual({ key: 'k.png', disk: undefined, size: 116, contentType: 'image/png', etag: expect.any(String) });
    expect((await disk.getBuffer('k.png')).length).toBe(116);
  });

  it('uses an async custom detector for unknown types and limits its byte sample', async () => {
    const body = Buffer.from('sku,name\n1,widget\n'.padEnd(80, 'x'));
    let receivedBytes: Buffer | undefined;
    let receivedFile:
      | {
          contentType: string | undefined;
          extension: string;
          originalname: string;
          mimetype: string;
        }
      | undefined;
    const engine = uploadToDisk({
      disk,
      contentTypes: ['text/csv'],
      contentTypeSampleBytes: 24,
      detectContentType: async (bytes, file) => {
        receivedBytes = bytes;
        receivedFile = file;
        return bytes.toString('utf8').startsWith('sku,name\n') ? 'text/csv' : undefined;
      },
      key: (file) => `reports/import${file.extension}`,
    });
    const stream = new PassThrough();
    const result = handle(engine, incoming(stream, 'import.csv', 'application/pdf'));

    stream.write(body.subarray(0, 7));
    stream.end(body.subarray(7));

    const { error, info } = await result;
    expect(error).toBeNull();
    expect(receivedBytes).toEqual(body.subarray(0, 24));
    expect(receivedFile).toMatchObject({
      contentType: undefined,
      extension: '',
      originalname: 'import.csv',
      mimetype: 'application/pdf',
    });
    expect(info).toMatchObject({
      key: 'reports/import.csv',
      size: body.length,
      contentType: 'text/csv',
    });
    expect(await disk.getBuffer('reports/import.csv')).toEqual(body);
  });

  it('allows a one-byte sample for custom content type detection', async () => {
    const body = Buffer.from('not a known signature');
    let receivedBytes: Buffer | undefined;
    const engine = uploadToDisk({
      disk,
      contentTypes: ['text/csv'],
      contentTypeSampleBytes: 1,
      key: () => 'detected.csv',
      detectContentType: (bytes) => {
        receivedBytes = bytes;
        return 'text/csv';
      },
    });
    const stream = new PassThrough();
    const result = handle(engine, incoming(stream, 'data.csv'));
    stream.end(body);

    const { error, info } = await result;
    expect(error).toBeNull();
    expect(receivedBytes).toEqual(body.subarray(0, 1));
    expect(info).toMatchObject({ contentType: 'text/csv', key: 'detected.csv' });
    expect(await disk.getBuffer('detected.csv')).toEqual(body);
  });

  it('keeps signature detection ahead of the custom detector', async () => {
    const detector = vi.fn(() => 'text/csv');
    const engine = uploadToDisk({
      disk,
      detectContentType: detector,
      contentTypes: ['application/pdf'],
    });
    const stream = new PassThrough();
    const result = handle(engine, incoming(stream));
    stream.end(Buffer.from('%PDF-1.7\n'));

    const { error, info } = await result;
    expect(error).toBeNull();
    expect(detector).not.toHaveBeenCalled();
    expect(info).toMatchObject({
      contentType: 'application/pdf',
      key: expect.stringMatching(/\.pdf$/),
    });
  });

  it('does not let a custom detector reclassify a known type outside the allow-list', async () => {
    const detector = vi.fn(() => 'text/csv');
    const engine = uploadToDisk({
      disk,
      contentTypes: ['text/csv'],
      detectContentType: detector,
    });
    const stream = new PassThrough();
    const result = handle(engine, incoming(stream, 'data.csv', 'text/csv'));
    stream.end(Buffer.from('%PDF-1.7\n'));

    const { error } = await result;
    expect(error.getStatus()).toBe(415);
    expect(detector).not.toHaveBeenCalled();
    expect(disk.keys()).toEqual([]);
  });

  it('rejects an unknown result against the allow-list without writing', async () => {
    const engine = uploadToDisk({
      disk,
      contentTypes: ['text/csv'],
      detectContentType: () => undefined,
    });
    const stream = new PassThrough();
    const result = handle(engine, incoming(stream, 'data.csv'));
    stream.end(Buffer.from('not recognized'));

    const { error } = await result;
    expect(error.getStatus()).toBe(415);
    expect(disk.keys()).toEqual([]);
  });

  it('does not write and drains the stream when a custom detector throws', async () => {
    const failure = new Error('detector failed');
    const engine = uploadToDisk({
      disk,
      contentTypeSampleBytes: 16,
      detectContentType: async () => Promise.reject(failure),
    });
    const stream = new PassThrough();
    const result = handle(engine, incoming(stream, 'data.csv'));
    stream.write(Buffer.from('unrecognized prefix'));

    const { error } = await result;
    expect(error).toBe(failure);

    const closed = new Promise<void>((resolve) => stream.once('close', resolve));
    stream.end(Buffer.alloc(100_000));
    await closed;
    expect(stream.readableEnded).toBe(true);
    expect(stream.errored).toBeNull();
    expect(disk.keys()).toEqual([]);
  });

  it('stores nothing when the client vanishes (the stream closes without ending or an error)', async () => {
    await disk.put('k.png', 'previous');
    const engine = uploadToDisk({ disk, key: () => 'k.png' });
    const stream = new PassThrough();
    const result = handle(engine, incoming(stream));

    stream.write(PNG);
    await new Promise((resolve) => setImmediate(resolve));
    stream.destroy();

    const { error } = await result;
    expect(error?.message).toBe('The upload ended before the file was complete');
    expect(await disk.getText('k.png')).toBe('previous');
  });

  it('stores nothing when the stream errors', async () => {
    const engine = uploadToDisk({ disk, key: () => 'k.png' });
    const stream = new PassThrough();
    const result = handle(engine, incoming(stream));

    stream.write(PNG);
    stream.destroy(new Error('Unexpected end of form'));

    expect((await result).error.message).toBe('Unexpected end of form');
    expect(disk.keys()).toEqual([]);
  });

  it('refuses a file busboy truncated at the limit, and keeps the file at its key', async () => {
    await disk.put('k.png', 'previous');
    const engine = uploadToDisk({ disk, key: () => 'k.png' });
    const stream = new PassThrough();
    const result = handle(engine, incoming(stream));

    stream.write(PNG);
    stream.emit('limit');
    Object.assign(stream, { truncated: true });
    stream.end();

    const { error } = await result;
    expect(error).toBeInstanceOf(PayloadTooLargeException);
    expect(error.message).toBe('File too large');
    expect(await disk.getText('k.png')).toBe('previous');
  });

  it('drains instead of destroying the stream when it refuses a file', async () => {
    const engine = uploadToDisk({ disk, contentTypes: ['image/jpeg'] });
    const stream = new PassThrough();
    const result = handle(engine, incoming(stream));

    stream.write(PNG);
    const { error } = await result;
    expect(error.getStatus()).toBe(415);

    // The parser can still read past the file: the rest is consumed and discarded
    stream.end(Buffer.alloc(1_000_000));
    await new Promise((resolve) => stream.once('close', resolve));
    expect(stream.readableEnded).toBe(true);
    expect(stream.errored).toBeNull();
    expect(disk.keys()).toEqual([]);
  });

  it('drains the rest when the disk fails mid-way', async () => {
    const failing = new InMemoryDisk();
    vi.spyOn(failing, 'put').mockImplementation(async (_key, body) => {
      const iterator = (body as AsyncIterable<Buffer>)[Symbol.asyncIterator]();
      await iterator.next();
      throw new Error('disk full');
    });

    const engine = uploadToDisk({ disk: failing });
    const stream = new PassThrough();
    const result = handle(engine, incoming(stream));

    stream.write(PNG);
    stream.write(Buffer.alloc(10));
    expect((await result).error.message).toBe('disk full');

    stream.end(Buffer.alloc(1_000_000));
    await new Promise((resolve) => stream.once('close', resolve));
    expect(stream.readableEnded).toBe(true);
    expect(stream.errored).toBeNull();
  });

  it('an empty file', async () => {
    const engine = uploadToDisk({ disk, key: () => 'empty' });
    const stream = new PassThrough();
    const result = handle(engine, incoming(stream));
    stream.end();
    expect((await result).info).toMatchObject({ size: 0, contentType: 'application/octet-stream' });
  });

  it('_removeFile() deletes the stored key, once', async () => {
    const engine = uploadToDisk({ disk });
    await disk.put('stored.png', PNG);
    const file = { key: 'stored.png' };

    await new Promise<void>((resolve, reject) => engine._removeFile({}, file, (error) => (error ? reject(error) : resolve())));
    expect(disk.keys()).toEqual([]);
    expect(file).toEqual({});

    // A file the engine never stored (a failed or aborted one) has no key: nothing to do
    await new Promise<void>((resolve) => engine._removeFile({}, { fieldname: 'file' }, () => resolve()));
  });

  it('_removeFile() reports a delete that failed', async () => {
    vi.spyOn(disk, 'delete').mockRejectedValue(new Error('denied'));
    const engine = uploadToDisk({ disk });
    const error = await new Promise((resolve) => engine._removeFile({}, { key: 'x' }, resolve));
    expect(error).toEqual(new Error('denied'));
  });

  it('validates its options when it is created', () => {
    expect(() => uploadToDisk({ contentTypes: [] })).toThrow('`contentTypes` must be a non-empty array');
    expect(() => uploadToDisk({ contentTypeSampleBytes: 16 })).toThrow(
      'requires `detectContentType`',
    );

    const detectContentType = () => undefined;
    expect(() => uploadToDisk({ detectContentType, contentTypeSampleBytes: 1 })).not.toThrow();
    expect(() => uploadToDisk({ detectContentType, contentTypeSampleBytes: 65_536 })).not.toThrow();
    for (const contentTypeSampleBytes of [0, 1.5, 65_537]) {
      expect(() => uploadToDisk({ detectContentType, contentTypeSampleBytes })).toThrow(
        'between 1 and 65536',
      );
    }
  });
});
