import { detectContentType, InMemoryDisk, StorageSignedUrlError } from '../lib/index.js';
import { contentDisposition } from '../lib/disks/storage.disk.js';
import { decodeXml, xmlElements, xmlText } from '../lib/s3/xml.util.js';

describe('detectContentType()', () => {
  const ftyp = (brand: string) => Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from(`ftyp${brand}`), Buffer.alloc(8)]);
  it.each([
    [Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0, 0]), 'image/jpeg'],
    [Buffer.from('89504e470d0a1a0a0000000d', 'hex'), 'image/png'],
    [Buffer.from('GIF89a......'), 'image/gif'],
    [Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 ', 'latin1'), 'image/webp'],
    [Buffer.from('%PDF-1.7\n'), 'application/pdf'],
    [ftyp('avif'), 'image/avif'],
    [ftyp('heic'), 'image/heic'],
    [ftyp('mp42'), undefined],
    [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), undefined],
    [Buffer.from('<html>'), undefined],
    [Buffer.from('RIFF\x10\x00\x00\x00WAVEfmt ', 'latin1'), undefined],
    [Buffer.alloc(0), undefined],
    [Buffer.from([0xff, 0xd8]), undefined],
  ])('%#', (bytes, type) => {
    expect(detectContentType(bytes)).toBe(type);
  });
});

describe('contentDisposition()', () => {
  it.each([
    ['report.pdf', 'attachment; filename="report.pdf"'],
    ['Faktura ż.pdf', `attachment; filename="Faktura _.pdf"; filename*=UTF-8''Faktura%20%C5%BC.pdf`],
    ['a"b.txt', `attachment; filename="a_b.txt"; filename*=UTF-8''a%22b.txt`],
    ['x\r\nSet-Cookie: a=b.txt', `attachment; filename="x__Set-Cookie: a=b.txt"; filename*=UTF-8''x%0D%0ASet-Cookie%3A%20a%3Db.txt`],
    ['../../etc/passwd', 'attachment; filename="passwd"'],
    ['C:\\Users\\me\\cv.pdf', 'attachment; filename="cv.pdf"'],
    ['100%.txt', `attachment; filename="100_.txt"; filename*=UTF-8''100%25.txt`],
  ])('%j', (name, header) => {
    expect(contentDisposition('attachment', name)).toBe(header);
    expect(header).toMatch(/^[\x20-\x7e]+$/);
  });
});

describe('app-served signed URLs', () => {
  const keys = ['a'.repeat(32), 'b'.repeat(32)];
  const signer = new InMemoryDisk({ signedUrls: { baseUrl: 'https://api.acme.example/files', keys } });

  it('verifies with any key, signs with the first (rotation)', async () => {
    const old = new InMemoryDisk({ signedUrls: { baseUrl: 'https://api.acme.example/files', keys: [keys[1]] } });
    const url = await old.signedUrl('a.txt');
    expect(signer.verifySignedUrl(url).key).toBe('a.txt');

    const retired = new InMemoryDisk({ signedUrls: { baseUrl: 'https://api.acme.example/files', keys: ['c'.repeat(32)] } });
    expect(() => retired.verifySignedUrl(url)).toThrow(StorageSignedUrlError);
  });

  it('binds a URL to the route it was issued for: another disk with the same keys refuses it', async () => {
    const archive = new InMemoryDisk({ signedUrls: { baseUrl: 'https://api.acme.example/archive', keys } });
    const url = await signer.signedUrl('invoices/1.pdf');

    const error = (() => {
      try {
        archive.verifySignedUrl(url);
      } catch (e) {
        return e;
      }
    })();

    expect(error).toBeInstanceOf(StorageSignedUrlError);
    expect(error).toMatchObject({ reason: 'invalid' });
    // The disk that issued it still takes the query alone: the route isn't read from the request
    expect(signer.verifySignedUrl(new URL(url).search).key).toBe('invoices/1.pdf');
  });

  it('accepts the URL, the query string or a parsed query', async () => {
    const url = await signer.signedUrl('a b/ż.txt', { filename: 'x.txt' });
    const parsed = new URL(url);
    expect(signer.verifySignedUrl(`${parsed.pathname}${parsed.search}`).key).toBe('a b/ż.txt');
    expect(signer.verifySignedUrl(parsed.searchParams).key).toBe('a b/ż.txt');
    expect(signer.verifySignedUrl(Object.fromEntries(parsed.searchParams)).key).toBe('a b/ż.txt');
  });

  it.each([
    ['no parameters', (_: URL) => '/files', 'missing'],
    ['another key', (u: URL) => (u.searchParams.set('key', 'b.txt'), u), 'invalid'],
    ['a later expiry', (u: URL) => (u.searchParams.set('expires', String(Number(u.searchParams.get('expires')) + 1)), u), 'invalid'],
    ['an added disposition', (u: URL) => (u.searchParams.set('disposition', 'inline'), u), 'invalid'],
    ['a repeated key', (u: URL) => (u.searchParams.append('key', 'b.txt'), u), 'invalid'],
    ['a non-numeric expiry', (u: URL) => (u.searchParams.set('expires', '1e12'), u), 'invalid'],
    ['a truncated signature', (u: URL) => (u.searchParams.set('signature', u.searchParams.get('signature')!.slice(1)), u), 'invalid'],
    ['a PUT method on a GET URL', (u: URL) => (u.searchParams.set('method', 'PUT'), u), 'invalid'],
  ])('refuses %s', async (_label, tamper, reason) => {
    const url = new URL(await signer.signedUrl('a.txt'));
    const error = (() => {
      try {
        signer.verifySignedUrl(String(tamper(url)));
      } catch (e) {
        return e;
      }
    })();

    expect(error).toBeInstanceOf(StorageSignedUrlError);
    expect(error).toMatchObject({ reason, status: 403 });
  });

  it('refuses a parsed query that is not plain strings (qs arrays and objects)', async () => {
    const query = Object.fromEntries(new URL(await signer.signedUrl('a.txt')).searchParams) as Record<string, unknown>;
    expect(() => signer.verifySignedUrl({ ...query, key: ['a.txt', 'b.txt'] })).toThrow(StorageSignedUrlError);
    expect(() => signer.verifySignedUrl({ ...query, key: { a: 1 } })).toThrow(StorageSignedUrlError);
  });

  it('refuses weak keys and bad base URLs at startup', () => {
    expect(() => new InMemoryDisk({ signedUrls: { baseUrl: 'https://x/files', keys: ['short'] } })).toThrow('`signedUrls.keys[0]` must be a string of at least 32 characters');
    expect(() => new InMemoryDisk({ signedUrls: { baseUrl: 'https://x/files', keys: [] } })).toThrow('`signedUrls.keys` needs at least one key');
    expect(() => new InMemoryDisk({ signedUrls: { baseUrl: '/files', keys } })).toThrow('`signedUrls.baseUrl`');
    expect(() => new InMemoryDisk({ signedUrls: { baseUrl: 'https://x/files?a=1', keys } })).toThrow('`signedUrls.baseUrl`');
    expect(() => new InMemoryDisk({ signedUrls: { baseUrl: 'https://x/files', keys: [Buffer.alloc(31)] } })).toThrow('Buffer of at least 32 bytes');
  });

  it('signedUrl() without signedUrls explains what to configure', async () => {
    await expect(new InMemoryDisk().signedUrl('a')).rejects.toThrow('has no `signedUrls` option, so signedUrl() can\'t be used');
  });
});

describe('XML', () => {
  it('decodes entities, including numeric ones', () => {
    expect(decodeXml('a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos; &#233; &#x1F4DA;')).toBe(`a & b <c> "d" 'e' é 📚`);
    expect(xmlText('<Error><Code>SlowDown</Code></Error>', 'Code')).toBe('SlowDown');
    expect(xmlElements('<A><B>1</B></A><A/><A x="1">2</A>', 'A')).toEqual(['<B>1</B>', '', '2']);
    expect(xmlText('<Contents><Key>a&amp;b</Key></Contents>', 'Key')).toBe('a&b');
    expect(xmlText('<NoKey/>', 'Key')).toBeUndefined();
  });
});
