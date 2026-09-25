/**
 * What only S3 does, driven through the files app on both adapters against the fake S3 (which
 * verifies every signature): retries of throttling, 5xx, resets and slow attempts behind a
 * request, failures that reach the client as a 500 rather than a 4xx, a multipart upload
 * aborted when a part keeps failing, server-side encryption, rotating credentials with a
 * session token, both bucket addressing styles, prefixes sharing a bucket, and one-by-one
 * deletes for stores without DeleteObjects.
 */
import request from 'supertest';
import { adapters } from './support/adapters.js';
import type { S3Credentials } from '../lib/index.js';
import { ACCESS_KEY, SECRET_KEY } from './fake-s3.js';
import {
  bootFilesApp,
  bytes,
  clientUrl,
  DiskFactory,
  fetchBytes,
  type FilesApp,
  MiB,
  PDF,
  PNG,
  PUBLIC_URL,
  storedKeys,
  useFakeS3,
} from './integration.support.js';

const fake = useFakeS3();
const TOKEN = 'session-token-for-the-fake';

describe.each(adapters.map((a) => a.name))('S3 through the app on %s', (adapter) => {
  const factory = new DiskFactory('S3Disk', fake);
  let ctx: FilesApp;
  let credentialCalls = 0;
  const http = () => request(ctx.app.getHttpServer());
  const credentials = async (): Promise<S3Credentials> => {
    credentialCalls++;
    return { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY, sessionToken: TOKEN };
  };
  const requestsFor = (key: string) => fake.requests.filter((r) => r.key.endsWith(key));

  beforeAll(async () => {
    ctx = await bootFilesApp(adapter, {
      public: await factory.create('public', {
        publicUrl: PUBLIC_URL,
        s3: { endpoint: fake.hostEndpoint, credentials, timeout: '1s', batchDelete: false },
      }),
      private: await factory.create('private', { s3: { credentials, serverSideEncryption: 'AES256' } }),
      archive: await factory.create('archive', { s3: { bucket: 'missing-bucket', credentials } }),
    });
  });
  beforeEach(() => {
    fake.reset();
    fake.sessionToken = TOKEN;
  });
  afterAll(async () => {
    await ctx?.app.close();
    fake.reset();
  });

  it('retries throttling and a 5xx behind an upload, and the client never sees them', async () => {
    fake.fail((r) => r.method === 'PUT' && r.key.endsWith('retried.png'), { status: 503, code: 'SlowDown', times: 2 });

    await http().post('/public').attach('file', PNG, { filename: 'retried.png' }).expect(201);

    expect(requestsFor('retried.png').filter((r) => r.method === 'PUT')).toHaveLength(3);
    expect(fake.object('public/uploads/retried.png')?.data).toEqual(PNG);
  });

  it('retries a reset connection and a slow attempt behind a download', async () => {
    await http().post('/public').attach('file', PDF, { filename: 'flaky.pdf' }).expect(201);
    fake.fail((r) => r.method === 'GET' && r.key.endsWith('flaky.pdf'), { status: 0, code: '', reset: true, times: 1 });
    fake.fail((r) => r.method === 'GET' && r.key.endsWith('flaky.pdf'), { status: 0, code: '', delayMs: 3000, times: 1 });

    const { res, body } = await fetchBytes(`${ctx.url}/files/public?key=uploads%2Fflaky.pdf`);

    expect(res.status).toBe(200);
    expect(body).toEqual(PDF);
    expect(requestsFor('flaky.pdf').filter((r) => r.method === 'GET')).toHaveLength(3);
  });

  it('gives up after the configured attempts: the upload fails with a 500, and nothing is stored', async () => {
    fake.fail((r) => r.method === 'PUT' && r.key.endsWith('down.png'), { status: 500, code: 'InternalError', times: 3 });

    await http().post('/public').attach('file', PNG, { filename: 'down.png' }).expect(500);

    expect(requestsFor('down.png').filter((r) => r.method === 'PUT')).toHaveLength(3);
    expect(fake.object('public/uploads/down.png')).toBeUndefined();
  });

  it('aborts a multipart upload when a part keeps failing, and stores nothing', { timeout: 30_000 }, async () => {
    fake.fail((r) => r.method === 'PUT' && r.query.partNumber === '2' && r.key.endsWith('doomed.bin'), { status: 500, code: 'InternalError', times: 3 });

    await http().post('/public').attach('file', bytes(11 * MiB), { filename: 'doomed.bin' }).expect(500);

    const doomed = requestsFor('doomed.bin');
    expect(doomed.some((r) => r.method === 'POST' && 'uploads' in r.query)).toBe(true);
    expect(doomed.some((r) => r.method === 'DELETE' && r.query.uploadId)).toBe(true);
    expect(fake.uploads.size).toBe(0);
    expect(fake.object('public/uploads/doomed.bin')).toBeUndefined();
  });

  it('a missing file is a 404; access denied, a missing bucket and an encoded object are 500s', async () => {
    await http().post('/public').attach('file', PNG, { filename: 'denied.png' }).expect(201);
    fake.fail((r) => r.method === 'GET' && r.key.endsWith('denied.png'), { status: 403, code: 'AccessDenied', times: 1 });

    expect((await fetch(`${ctx.url}/files/public?key=uploads%2Fnowhere.png`)).status).toBe(404);
    expect((await fetch(`${ctx.url}/files/public?key=uploads%2Fdenied.png`)).status).toBe(500);
    expect(requestsFor('denied.png').filter((r) => r.method === 'GET')).toHaveLength(1);

    expect((await fetch(`${ctx.url}/files/archive?key=a.pdf`)).status).toBe(500);

    fake.objects.set('shop/private/logs/app.log', {
      data: Buffer.from('gzipped'),
      contentType: 'text/plain',
      contentEncoding: 'gzip',
      metadata: {},
      etag: '"e"',
      lastModified: new Date(),
    });
    expect((await fetch(`${ctx.url}/files/private?key=logs%2Fapp.log`)).status).toBe(500);
    expect((await http().get('/stat/private').query({ key: 'logs/app.log' }).expect(200)).body).toMatchObject({ size: 7 });
  });

  it('encrypts uploads and copies, and signs the encryption header into upload URLs', async () => {
    const [doc] = (await http().post('/private').attach('docs', PDF, { filename: 'secret.pdf' }).expect(201)).body;
    expect(fake.object(`private/${doc.key}`)?.encryption).toBe('AES256');

    await http().post('/copy/private').query({ from: doc.key, to: 'copies/secret.pdf' }).expect(201);
    expect(fake.object('private/copies/secret.pdf')?.encryption).toBe('AES256');

    const upload = (await http().post('/signed-upload/private').send({ key: 'incoming/e.png', contentType: 'image/png', contentLength: PNG.length }).expect(201)).body;
    expect(upload.headers).toMatchObject({ 'x-amz-server-side-encryption': 'AES256' });
    const { 'content-length': _, 'x-amz-server-side-encryption': __, ...withoutEncryption } = upload.headers;

    expect((await fetch(upload.url, { method: 'PUT', headers: withoutEncryption, body: PNG })).status).toBe(403);
    expect(fake.signatureFailures).toEqual(['signed header x-amz-server-side-encryption missing']);
    fake.signatureFailures.length = 0;

    expect((await fetch(upload.url, { method: 'PUT', headers: { ...withoutEncryption, 'x-amz-server-side-encryption': 'AES256' }, body: PNG })).status).toBe(200);
    expect(fake.object('private/incoming/e.png')).toMatchObject({ data: PNG, encryption: 'AES256' });
  });

  it('calls the credentials function per request, and the store checks the session token on signed and presigned requests', async () => {
    credentialCalls = 0;
    const [doc] = (await http().post('/private').attach('docs', PDF, { filename: 'token.pdf' }).expect(201)).body;
    await fetch(`${ctx.url}/files/private?key=${doc.key}`).then((res) => expect(res.status).toBe(200));
    expect(credentialCalls).toBeGreaterThanOrEqual(2);

    const url = clientUrl((await http().get('/signed-url/private').query({ key: doc.key }).expect(200)).body.url, ctx.url);
    expect(new URL(url).searchParams.get('X-Amz-Security-Token')).toBe(TOKEN);
    expect((await fetch(url)).status).toBe(200);

    fake.sessionToken = 'rotated';
    expect((await fetch(`${ctx.url}/files/private?key=${doc.key}`)).status).toBe(500);
    expect(fake.signatureFailures.every((failure) => failure === 'bad session token')).toBe(true);
    fake.signatureFailures.length = 0;
  });

  it('addresses one disk virtual-hosted and the other path-style, each under its prefix in one bucket', async () => {
    await http().post('/public').attach('file', PNG, { filename: 'shared.png' }).expect(201);
    await http().post('/private').attach('docs', PNG, { filename: 'shared.png' }).expect(201);

    const styles = new Set(fake.requests.map((r) => `${r.key.split('/')[0]}:${r.style}`));
    expect([...styles].sort()).toEqual(['private:path', 'public:virtual']);
    expect(storedKeys(fake, 'public')).toEqual(['uploads/shared.png']);
    expect((await http().get('/list-all/public').expect(200)).body).toEqual(['uploads/shared.png']);
    expect((await http().get('/list-all/private').expect(200)).body).toEqual(storedKeys(fake, 'private'));
    expect(storedKeys(fake, 'private')).toHaveLength(1);
  });

  it('deletes one by one with batchDelete: false, and in one DeleteObjects by default', async () => {
    for (const name of ['1.png', '2.png', '3.png']) {
      await http().post('/public').attach('file', PNG, { filename: name }).expect(201);
    }
    const docs = (await http().post('/private').attach('docs', PDF, { filename: 'a.pdf' }).attach('docs', PDF, { filename: 'b.pdf' }).expect(201)).body;
    fake.requests.length = 0;

    await http().delete('/files/public').query({ keys: 'uploads/1.png,uploads/2.png,uploads/3.png' }).expect(200);
    await http().delete('/files/private').query({ keys: docs.map((d: { key: string }) => d.key).join(',') }).expect(200);

    expect(fake.requests.map((r) => `${r.method} ${r.key.split('/')[0] || '/'}${'delete' in r.query ? '?delete' : ''}`)).toEqual([
      'DELETE public',
      'DELETE public',
      'DELETE public',
      'POST /?delete',
    ]);
    expect(storedKeys(fake, 'public')).toEqual([]);
    expect(storedKeys(fake, 'private')).toEqual([]);
  });
});
