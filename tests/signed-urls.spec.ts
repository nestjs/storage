/**
 * App-served signed URLs (`signedUrls` on `InMemoryDisk` and `LocalDisk`): what a URL carries,
 * when it stops working, and the order of the checks, beyond the tampering cases in
 * units.spec.ts.
 */
import { InMemoryDisk, StorageSignedUrlError } from '../lib/index.js';

const baseUrl = 'https://api.example.com/v1/files';
const key32 = 'k'.repeat(32);
const now = Date.UTC(2026, 5, 1, 8, 0, 0);

const reasonOf = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(StorageSignedUrlError);
    return (error as StorageSignedUrlError).reason;
  }
  return 'accepted';
};

describe('app-served signed URLs', () => {
  const disk = new InMemoryDisk({ signedUrls: { baseUrl, keys: [key32] } });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the base URL path and puts the claims in the query', async () => {
    const url = new URL(await disk.signedUrl('reports/q1 2026.csv', { expiresIn: '10m', filename: 'q1.csv' }));

    expect(`${url.origin}${url.pathname}`).toBe(baseUrl);
    expect([...url.searchParams.keys()]).toEqual(['key', 'expires', 'disposition', 'signature']);
    expect(url.searchParams.get('key')).toBe('reports/q1 2026.csv');
    expect(url.searchParams.get('expires')).toBe(String(now / 1000 + 600));
    expect(url.searchParams.get('signature')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('an upload URL carries its method, type and length', async () => {
    const upload = await disk.signedUpload('in/a.png', { contentType: 'image/png', contentLength: 12 });
    const url = new URL(upload.url);

    expect(url.searchParams.get('method')).toBe('PUT');
    expect(url.searchParams.get('type')).toBe('image/png');
    expect(url.searchParams.get('length')).toBe('12');
    expect(upload).toMatchObject({ method: 'PUT', headers: { 'content-type': 'image/png' }, expiresAt: new Date(now + 15 * 60_000) });
  });

  it('returns only the claims that were signed', async () => {
    const claims = disk.verifySignedUrl(await disk.signedUrl('a.txt'));
    expect(claims).toEqual({ key: 'a.txt', method: 'GET', expiresAt: new Date(now + 15 * 60_000) });
    expect(Object.keys(claims)).toEqual(['key', 'method', 'expiresAt']);
  });

  it('works until the second it expires, and not from then on', async () => {
    const url = await disk.signedUrl('a.txt', { expiresIn: '1m' });

    vi.setSystemTime(now + 59_999);
    expect(disk.verifySignedUrl(url).key).toBe('a.txt');

    vi.setSystemTime(now + 60_000);
    expect(reasonOf(() => disk.verifySignedUrl(url))).toBe('expired');
  });

  it('checks the signature before the expiry: a forged URL never reports "expired"', async () => {
    const url = new URL(await disk.signedUrl('a.txt', { expiresIn: '1m' }));
    url.searchParams.set('key', 'b.txt');

    vi.setSystemTime(now + 3_600_000);
    expect(reasonOf(() => disk.verifySignedUrl(url))).toBe('invalid');
  });

  it('refuses a download URL for an upload and the reverse, with the reason "method"', async () => {
    const download = await disk.signedUrl('a.txt');
    const upload = (await disk.signedUpload('a.txt', { contentType: 'text/plain' })).url;

    expect(reasonOf(() => disk.verifySignedUrl(download, 'PUT'))).toBe('method');
    expect(reasonOf(() => disk.verifySignedUrl(upload, 'GET'))).toBe('method');
    expect(reasonOf(() => disk.verifySignedUrl(upload, 'PUT'))).toBe('accepted');
  });

  it.each([
    ['another method', (u: URL) => u.searchParams.set('method', 'DELETE')],
    ['a non-numeric length', (u: URL) => u.searchParams.set('length', '12abc')],
    ['an expiry of more than 12 digits', (u: URL) => u.searchParams.set('expires', '1'.repeat(13))],
    ['a repeated signature', (u: URL) => u.searchParams.append('signature', u.searchParams.get('signature')!)],
    ['a dropped type', (u: URL) => u.searchParams.delete('type')],
    ['a signature from another key', (u: URL) => u.searchParams.set('signature', Buffer.alloc(32, 1).toString('base64url'))],
  ])('refuses %s as invalid', async (_label, tamper) => {
    const url = new URL((await disk.signedUpload('a.bin', { contentType: 'application/pdf', contentLength: 12 })).url);
    tamper(url);
    expect(reasonOf(() => disk.verifySignedUrl(url, 'PUT'))).toBe('invalid');
  });

  it.each([
    ['a path without a query', '/v1/files'],
    ['an empty query', '/v1/files?'],
    ['no signature', '/v1/files?key=a.txt&expires=9999999999'],
    ['an empty key', '/v1/files?key=&expires=9999999999&signature=abc'],
  ])('reports %s as missing', (_label, url) => {
    expect(reasonOf(() => disk.verifySignedUrl(url))).toBe('missing');
  });

  it('accepts a URL instance, and ignores unset entries of a parsed query', async () => {
    const url = new URL(await disk.signedUrl('a.txt'));
    expect(disk.verifySignedUrl(url).key).toBe('a.txt');
    expect(disk.verifySignedUrl({ ...Object.fromEntries(url.searchParams), page: undefined }).key).toBe('a.txt');
  });

  it('a Buffer key and a string of the same bytes are the same key', async () => {
    const byString = new InMemoryDisk({ signedUrls: { baseUrl, keys: [key32] } });
    const byBuffer = new InMemoryDisk({ signedUrls: { baseUrl, keys: [Buffer.from(key32)] } });

    expect(byBuffer.verifySignedUrl(await byString.signedUrl('a.txt')).key).toBe('a.txt');
  });

  it('signs with the first key only: a URL from the new key fails on a disk that has only the old one', async () => {
    const rotated = new InMemoryDisk({ signedUrls: { baseUrl, keys: ['n'.repeat(32), key32] } });
    const old = new InMemoryDisk({ signedUrls: { baseUrl, keys: [key32] } });

    const url = await rotated.signedUrl('a.txt');
    expect(rotated.verifySignedUrl(url).key).toBe('a.txt');
    expect(reasonOf(() => old.verifySignedUrl(url))).toBe('invalid');
  });
});

describe('signedUrls options', () => {
  it.each([
    ['a base URL with credentials', { baseUrl: 'https://user:pass@api.example.com/files', keys: [key32] }, '`signedUrls.baseUrl`'],
    ['a base URL with a fragment', { baseUrl: 'https://api.example.com/files#x', keys: [key32] }, '`signedUrls.baseUrl`'],
    ['a non-http base URL', { baseUrl: 'ftp://api.example.com/files', keys: [key32] }, '`signedUrls.baseUrl`'],
    ['keys that are not an array', { baseUrl, keys: key32 as never }, '`signedUrls.keys` needs at least one key'],
    ['a weak second key', { baseUrl, keys: [key32, 'short'] }, '`signedUrls.keys[1]`'],
    ['a key that is neither a string nor a Buffer', { baseUrl, keys: [42 as never] }, '`signedUrls.keys[0]`'],
  ])('refuses %s at startup', (_label, signedUrls, message) => {
    expect(() => new InMemoryDisk({ signedUrls })).toThrow(message);
    expect(() => new InMemoryDisk({ signedUrls })).toThrow(TypeError);
  });

  it('takes the base URL as a URL instance', async () => {
    const disk = new InMemoryDisk({ signedUrls: { baseUrl: new URL('http://localhost:3000/files'), keys: [key32] } });
    expect(await disk.signedUrl('a.txt')).toMatch(/^http:\/\/localhost:3000\/files\?key=a.txt&expires=\d+&signature=/);
  });
});
