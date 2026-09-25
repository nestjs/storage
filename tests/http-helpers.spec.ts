/**
 * `serveFile()`, `serveSignedUrl()` and `receiveSignedUpload()` called directly with an
 * Express-shaped response and a Fastify-shaped reply: the header, status and error decisions
 * that http.spec.ts doesn't reach through the adapters (cache overrides, validators, safe
 * dispositions, parsed bodies, lengths).
 */
import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { BadRequestException, ForbiddenException, HttpException, NotFoundException, type StreamableFile } from '@nestjs/common';
import { InMemoryDisk, receiveSignedUpload, S3Disk, serveFile, serveSignedUrl } from '../lib/index.js';

const signedUrls = { baseUrl: 'https://api.example.com/files', keys: ['s'.repeat(32)] };

/** Express's response: `setHeader()`, `status()`, and the Node response's events. */
class ExpressResponse extends EventEmitter {
  headers: Record<string, string> = {};
  statusCode = 200;
  setHeader(name: string, value: string) {
    this.headers[name.toLowerCase()] = value;
  }
  status(code: number) {
    this.statusCode = code;
    return this;
  }
}

/** Fastify's reply: `header()` and `code()`, with the Node response on `raw`. */
class FastifyReply {
  headers: Record<string, string> = {};
  statusCode = 200;
  readonly raw = new EventEmitter();
  header(name: string, value: string) {
    this.headers[name.toLowerCase()] = value;
    return this;
  }
  code(code: number) {
    this.statusCode = code;
    return this;
  }
  status(code: number) {
    return this.code(code);
  }
}

const read = async (file: StreamableFile | undefined) => {
  const chunks: Buffer[] = [];
  for await (const chunk of file!.getStream()) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
};

const errorOf = (promise: Promise<unknown>) => promise.then(() => undefined, (error: unknown) => error);
const local = (url: string) => `${new URL(url).pathname}${new URL(url).search}`;

describe.each([
  ['an Express response', () => new ExpressResponse()],
  ['a Fastify reply', () => new FastifyReply()],
])('serveFile() with %s', (_label, response) => {
  let disk: InMemoryDisk;
  beforeEach(async () => {
    disk = new InMemoryDisk();
    await disk.put('docs/report.pdf', '%PDF-1.7 0123456789', { cacheControl: 'public, max-age=60' });
    await disk.put('site/icon.svg', '<svg/>');
    await disk.put('notes/a.txt', 'hello');
  });

  it('an explicit cacheControl wins over the stored one', async () => {
    const res = response();
    await serveFile(disk, 'docs/report.pdf', { res, cacheControl: 'no-store' });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it.each([
    ['docs/report.pdf', 'inline', 'inline; filename="report.pdf"'],
    ['notes/a.txt', 'inline', 'inline; filename="a.txt"'],
    ['site/icon.svg', 'inline', 'attachment; filename="icon.svg"'],
    ['docs/report.pdf', undefined, 'attachment; filename="report.pdf"'],
  ] as const)('%s asked as %s goes out as %s', async (key, disposition, header) => {
    const file = await serveFile(disk, key, { res: response(), disposition });
    expect(file!.getHeaders().disposition).toBe(header);
  });

  it('names the download after filename rather than the key', async () => {
    const file = await serveFile(disk, 'docs/report.pdf', { res: response(), filename: 'Q1 raport ż.pdf' });
    expect(file!.getHeaders()).toMatchObject({
      type: 'application/pdf',
      length: 19,
      disposition: `attachment; filename="Q1 raport _.pdf"; filename*=UTF-8''Q1%20raport%20%C5%BC.pdf`,
    });
  });

  it.each([
    ['a weak validator', (etag: string) => `W/${etag}`],
    ['a list of validators', (etag: string) => `"other", ${etag}`],
    ['a wildcard', () => '*'],
  ])('answers If-None-Match with %s with 304 and no body', async (_label, header) => {
    const { etag } = await disk.stat('docs/report.pdf');
    const res = response();
    const get = vi.spyOn(disk, 'get');

    const file = await serveFile(disk, 'docs/report.pdf', { req: { headers: { 'if-none-match': header(etag!) } }, res });

    expect(file).toBeUndefined();
    expect(res.statusCode).toBe(304);
    expect(res.headers.etag).toBe(etag);
    const { body } = await get.mock.results[0].value;
    expect(body.destroyed).toBe(true);
  });

  it('serves the file when If-None-Match names another version', async () => {
    const res = response();
    const file = await serveFile(disk, 'docs/report.pdf', { req: { headers: { 'if-none-match': '"stale"' } }, res });
    expect(res.statusCode).toBe(200);
    expect((await read(file)).toString()).toBe('%PDF-1.7 0123456789');
  });

  it('answers a range with 206, Content-Range and the length of the part', async () => {
    const res = response();
    const file = await serveFile(disk, 'docs/report.pdf', { req: { headers: { Range: 'bytes=9-12' } }, res });

    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toBe('bytes 9-12/19');
    expect(file!.getHeaders().length).toBe(4);
    expect((await read(file)).toString()).toBe('0123');
  });

  it.each(['bytes=12-9', 'bytes=-', 'bytes=99999999999999999999-', ' bytes = 1-2'])('ignores the range %j', async (range) => {
    const res = response();
    const file = await serveFile(disk, 'docs/report.pdf', { req: { headers: { range } }, res });
    expect(res.statusCode).toBe(200);
    expect(file!.getHeaders().length).toBe(19);
  });

  it('answers a zero-byte suffix with 416 and the size', async () => {
    const res = response();
    const error = await errorOf(serveFile(disk, 'docs/report.pdf', { req: { headers: { range: 'bytes=-0' } }, res }));

    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(416);
    expect(res.headers['content-range']).toBe('bytes */19');
  });

  it('releases the file when the response closes', async () => {
    const res = response();
    const get = vi.spyOn(disk, 'get');
    await serveFile(disk, 'docs/report.pdf', { res });
    const { body } = await get.mock.results[0].value;

    const node = res instanceof FastifyReply ? res.raw : res;
    node.emit('close');
    expect(body.destroyed).toBe(true);
  });

  it('sends Last-Modified, nosniff and Accept-Ranges', async () => {
    const res = response();
    await serveFile(disk, 'notes/a.txt', { res });
    const { lastModified } = await disk.stat('notes/a.txt');

    expect(res.headers).toMatchObject({
      'last-modified': lastModified.toUTCString(),
      'x-content-type-options': 'nosniff',
      'accept-ranges': 'bytes',
      'cache-control': 'private',
    });
  });
});

describe('serveFile() arguments', () => {
  it('refuses a missing or unusable response before reading anything', async () => {
    const disk = new InMemoryDisk();
    await disk.put('a.txt', 'x');
    const get = vi.spyOn(disk, 'get');

    for (const res of [undefined, {}, { header: () => undefined }]) {
      await expect(serveFile(disk, 'a.txt', { res })).rejects.toThrow('Pass the response as `res`');
    }
    expect(get).not.toHaveBeenCalled();
  });

  it('joins a header sent twice before matching it', async () => {
    const disk = new InMemoryDisk();
    await disk.put('a.txt', 'x');
    const { etag } = await disk.stat('a.txt');
    const res = new ExpressResponse();

    await serveFile(disk, 'a.txt', { req: { headers: { 'if-none-match': ['"old"', etag!] } }, res });
    expect(res.statusCode).toBe(304);
  });

  it('lets any other disk failure through unchanged', async () => {
    const disk = new InMemoryDisk();
    const failure = new Error('backend down');
    vi.spyOn(disk, 'get').mockRejectedValue(failure);
    await expect(serveFile(disk, 'a.txt', { res: new ExpressResponse() })).rejects.toBe(failure);
  });
});

describe('serveSignedUrl()', () => {
  let disk: InMemoryDisk;
  beforeEach(async () => {
    disk = new InMemoryDisk({ signedUrls });
    await disk.put('site/page.html', '<script>1</script>');
    await disk.put('img/a.png', Buffer.from('89504e470d0a1a0a', 'hex'));
  });

  it('is a 404 on a disk that does not serve its own signed URLs', async () => {
    const s3 = new S3Disk({ bucket: 'shop', credentials: { accessKeyId: 'a', secretAccessKey: 'b' } });
    for (const target of [new InMemoryDisk(), s3]) {
      await expect(serveSignedUrl(target, { req: { url: '/files?key=a' }, res: new ExpressResponse() })).rejects.toBeInstanceOf(NotFoundException);
    }
  });

  it('turns a signed inline disposition into an attachment for a type that could run script', async () => {
    const html = await serveSignedUrl(disk, { req: { url: local(await disk.signedUrl('site/page.html', { disposition: 'inline' })) }, res: new ExpressResponse() });
    const png = await serveSignedUrl(disk, { req: { url: local(await disk.signedUrl('img/a.png', { disposition: 'inline', filename: 'a.png' })) }, res: new ExpressResponse() });

    expect(html!.getHeaders().disposition).toBe('attachment');
    expect(png!.getHeaders().disposition).toBe('inline; filename="a.png"');
  });

  it('reads the URL from originalUrl (a mounted Express app), url, or the raw request', async () => {
    const url = local(await disk.signedUrl('img/a.png'));

    for (const req of [{ originalUrl: url, url: '/' }, { url }, { raw: { url } }]) {
      const file = await serveSignedUrl(disk, { req, res: new FastifyReply() });
      expect(file!.getHeaders().type).toBe('image/png');
    }
  });

  it('refuses an upload URL and an expired one with 403, saying which', async () => {
    const upload = await disk.signedUpload('img/a.png', { contentType: 'image/png' });
    const refused = await errorOf(serveSignedUrl(disk, { req: { url: local(upload.url) }, res: new ExpressResponse() }));
    expect(refused).toBeInstanceOf(ForbiddenException);
    expect((refused as ForbiddenException).message).toBe('Invalid signed URL');

    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() - 3_600_000 });
    const old = await disk.signedUrl('img/a.png', { expiresIn: '1m' });
    vi.useRealTimers();
    const expired = await errorOf(serveSignedUrl(disk, { req: { url: local(old) }, res: new ExpressResponse() }));
    expect((expired as ForbiddenException).message).toBe('The signed URL has expired');
  });

  it('is a 404 when the signed file is gone', async () => {
    const url = local(await disk.signedUrl('img/a.png'));
    await disk.delete('img/a.png');
    await expect(serveSignedUrl(disk, { req: { url }, res: new ExpressResponse() })).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('receiveSignedUpload()', () => {
  let disk: InMemoryDisk;
  beforeEach(() => {
    disk = new InMemoryDisk({ signedUrls });
  });

  /** An Express request: the request itself is the body stream. */
  const expressRequest = (url: string, headers: Record<string, string>, body?: Buffer) => {
    const req = Object.assign(new PassThrough(), { url, headers });
    if (body !== undefined) {
      req.end(body);
    }
    return req;
  };

  const statusOf = async (promise: Promise<unknown>) => {
    const error = await errorOf(promise);
    return error instanceof HttpException ? error.getStatus() : error;
  };

  it('is a 404 on a disk that does not serve its own signed URLs', async () => {
    const req = expressRequest('/files?key=a', { 'content-length': '1' }, Buffer.from('x'));
    expect(await statusOf(receiveSignedUpload(new InMemoryDisk(), { req }))).toBe(404);
  });

  it('refuses a download URL with 403', async () => {
    const url = local(await disk.signedUrl('a.bin'));
    expect(await statusOf(receiveSignedUpload(disk, { req: expressRequest(url, { 'content-length': '1' }, Buffer.from('x')) }))).toBe(403);
  });

  it.each([
    ['no Content-Length', {}],
    ['a Content-Length that is not a number', { 'content-length': '12abc' }],
    ['a negative Content-Length', { 'content-length': '-1' }],
  ])('answers %s with 411', async (_label, headers) => {
    const upload = await disk.signedUpload('a.bin', { contentType: 'application/pdf' });
    const req = expressRequest(local(upload.url), { 'content-type': 'application/pdf', ...headers }, Buffer.from('%PDF'));
    expect(await statusOf(receiveSignedUpload(disk, { req }))).toBe(411);
  });

  it('a body shorter than its Content-Length is a 400, and nothing is stored', async () => {
    const upload = await disk.signedUpload('a.bin', { contentType: 'application/pdf' });
    const req = expressRequest(local(upload.url), { 'content-type': 'application/pdf', 'content-length': '10' }, Buffer.from('%PDF'));

    const error = await errorOf(receiveSignedUpload(disk, { req }));

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).message).toBe('The body does not match its Content-Length');
    expect(disk.keys()).toEqual([]);
  });

  it('does not apply maxSize when the URL was signed with a length', async () => {
    const upload = await disk.signedUpload('big.bin', { contentType: 'application/pdf', contentLength: 2000 });
    const req = expressRequest(local(upload.url), { 'content-type': 'application/pdf', 'content-length': '2000' }, Buffer.alloc(2000, 1));

    await expect(receiveSignedUpload(disk, { req, maxSize: 1000 })).resolves.toMatchObject({ key: 'big.bin', size: 2000 });
  });

  it.each([
    ['an Express body a parser already read', (url: string, headers: Record<string, string>) => Object.assign(expressRequest(url, headers), { _body: true })],
    ['a Fastify body a parser already read', (url: string, headers: Record<string, string>) => ({ url, headers, raw: new PassThrough(), body: { parsed: true } })],
    ['a stream that already ended', (url: string, headers: Record<string, string>) => {
      const req = expressRequest(url, headers, Buffer.alloc(0));
      req.resume();
      return new Promise((resolve) => req.once('end', () => resolve(req)));
    }],
  ])('refuses %s with 400', async (_label, build) => {
    const upload = await disk.signedUpload('a.bin', { contentType: 'application/json' });
    const req = await build(local(upload.url), { 'content-type': 'application/json', 'content-length': '2' });

    const error = await errorOf(receiveSignedUpload(disk, { req }));

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).message).toBe('The upload body was already parsed; signed uploads need the raw request body');
  });

  it('reads a Fastify request body from raw, and sends the ETag on the reply', async () => {
    const upload = await disk.signedUpload('in/a.pdf', { contentType: 'application/pdf', contentLength: 4 });
    const req = { url: local(upload.url), headers: { 'content-type': 'application/pdf', 'content-length': '4' }, raw: Readable.from([Buffer.from('%PDF')]), body: undefined };
    const res = new FastifyReply();

    const result = await receiveSignedUpload(disk, { req, res });

    expect(result).toMatchObject({ key: 'in/a.pdf', size: 4, contentType: 'application/pdf' });
    expect(res.headers.etag).toBe(result.etag);
    expect(await disk.getText('in/a.pdf')).toBe('%PDF');
  });

  it('lets a disk failure other than the length through', async () => {
    const failure = new Error('disk full');
    vi.spyOn(disk, 'put').mockRejectedValue(failure);
    const upload = await disk.signedUpload('a.bin', { contentType: 'application/pdf' });
    const req = expressRequest(local(upload.url), { 'content-type': 'application/pdf', 'content-length': '4' }, Buffer.from('%PDF'));

    await expect(receiveSignedUpload(disk, { req })).rejects.toBe(failure);
  });
});
