/**
 * The signer against AWS's published vectors:
 * - the AWS Signature Version 4 test suite (fixtures/aws4-testsuite, Apache-2.0, as shipped in
 *   botocore's tests): canonical request, string to sign and Authorization header per case;
 * - the S3 examples of the "Signature Calculations for the Authorization Header" and "Query
 *   String Authentication" pages of the Amazon S3 API reference (GET with a range, PUT,
 *   ?lifecycle, list with max-keys and prefix, a presigned GET), with their canonical
 *   requests, strings to sign and signatures.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  canonicalRequest,
  credentialScope,
  presignUrl,
  sha256Hex,
  signature,
  signRequest,
  stringToSign,
} from '../lib/s3/sigv4.util.js';
import { encodeRfc3986 } from '../lib/utils/keys.util.js';

const SUITE = join(import.meta.dirname, 'fixtures', 'aws4-testsuite');
const suiteCredentials = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' };
const suiteDate = new Date(Date.UTC(2015, 7, 30, 12, 36, 0));
const SESSION_TOKEN = '6e86291e8372ff2a2260956d9b8aae1d763fbf315fa00fa31553b73ebf194267';

/** Parses a `.req` file: request line, headers (with folded continuation lines), body. */
function parseRequest(text: string) {
  const [head, ...bodyParts] = text.split('\n\n');
  const [requestLine, ...headerLines] = head.split('\n');
  const [method, ...rest] = requestLine.split(' ');
  const target = rest.slice(0, -1).join(' ');

  const headers: [string, string][] = [];
  for (const line of headerLines.filter((l) => l !== '')) {
    if (/^\s/.test(line) && headers.length) {
      headers[headers.length - 1][1] += `\n${line}`;
    } else {
      const colon = line.indexOf(':');
      headers.push([line.slice(0, colon), line.slice(colon + 1)]);
    }
  }

  const [path, query = ''] = target.split(/\?(.*)/s);
  const pairs: [string, string][] = query
    ? query.split('&').map((pair) => {
        const [name, value = ''] = pair.split(/=(.*)/s);
        return [decodeURIComponent(name), decodeURIComponent(value)];
      })
    : [];
  return { method, path, pairs, headers, body: bodyParts.join('\n\n') };
}

const read = (name: string, ext: string) => readFileSync(join(SUITE, name, `${name}.${ext}`), 'utf8');

describe('AWS Signature Version 4 test suite', () => {
  const cases = readdirSync(SUITE, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);

  it('has the vectors', () => {
    expect(cases.length).toBe(24);
  });

  it.each(cases)('%s', (name) => {
    const request = parseRequest(read(name, 'req'));
    const headers = [...request.headers];
    if (name === 'get-vanilla-with-session-token') {
      headers.push(['X-Amz-Security-Token', SESSION_TOKEN]);
    }

    // The suite's paths are raw; each segment is encoded once, as S3 paths are.
    const path = request.path.split('/').map((segment) => encodeRfc3986(decodeURIComponent(segment))).join('/');
    const { request: canonical, signedHeaders } = canonicalRequest({
      method: request.method,
      path,
      query: request.pairs,
      headers,
      payloadHash: sha256Hex(request.body),
    });
    expect(canonical).toBe(read(name, 'creq'));

    const scope = credentialScope(suiteDate, 'us-east-1', 'service');
    const toSign = stringToSign(canonical, suiteDate, scope);
    expect(toSign).toBe(read(name, 'sts'));
    const sig = signature(suiteCredentials.secretAccessKey, suiteDate, 'us-east-1', 'service', toSign);
    expect(
      `AWS4-HMAC-SHA256 Credential=${suiteCredentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${sig}`,
    ).toBe(read(name, 'authz'));
  });
});

describe('Amazon S3 API reference examples', () => {
  const credentials = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };
  const date = new Date(Date.UTC(2013, 4, 24));
  const EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

  function sign(url: string, method: string, headers: Record<string, string>, payloadHash: string) {
    return signRequest({ method, url: new URL(url), headers: { ...headers, 'x-amz-content-sha256': payloadHash }, payloadHash, credentials, region: 'us-east-1', date });
  }
  const sigOf = (authorization: string) => /Signature=([0-9a-f]+)$/.exec(authorization)![1];

  it('GET Object with a range', () => {
    const { request } = canonicalRequest({
      method: 'GET',
      path: '/test.txt',
      query: [],
      headers: [['host', 'examplebucket.s3.amazonaws.com'], ['range', 'bytes=0-9'], ['x-amz-content-sha256', EMPTY], ['x-amz-date', '20130524T000000Z']],
      payloadHash: EMPTY,
    });

    expect(request).toBe(
      'GET\n/test.txt\n\nhost:examplebucket.s3.amazonaws.com\nrange:bytes=0-9\n' +
        `x-amz-content-sha256:${EMPTY}\nx-amz-date:20130524T000000Z\n\nhost;range;x-amz-content-sha256;x-amz-date\n${EMPTY}`,
    );
    expect(stringToSign(request, date, credentialScope(date, 'us-east-1', 's3'))).toBe(
      'AWS4-HMAC-SHA256\n20130524T000000Z\n20130524/us-east-1/s3/aws4_request\n7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972',
    );

    const headers = sign('https://examplebucket.s3.amazonaws.com/test.txt', 'GET', { range: 'bytes=0-9' }, EMPTY);
    expect(sigOf(headers.authorization)).toBe('f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
    expect(headers.authorization).toContain('SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,');
  });

  it('PUT Object', () => {
    const payload = sha256Hex('Welcome to Amazon S3.');
    expect(payload).toBe('44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072');
    // "$" is encoded in the path: the key goes through the same encoder S3Disk uses
    const url = `https://examplebucket.s3.amazonaws.com/${encodeRfc3986('test$file.text')}`;
    const headers = sign(url, 'PUT', { date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' }, payload);
    expect(sigOf(headers.authorization)).toBe('98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
  });

  it('GET Bucket Lifecycle (a subresource without a value)', () => {
    const headers = sign('https://examplebucket.s3.amazonaws.com/?lifecycle', 'GET', {}, EMPTY);
    expect(sigOf(headers.authorization)).toBe('fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543');
  });

  it('Get Bucket (List Objects), query sorted', () => {
    const headers = sign('https://examplebucket.s3.amazonaws.com/?prefix=J&max-keys=2', 'GET', {}, EMPTY);
    expect(sigOf(headers.authorization)).toBe('34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7');
  });

  it('presigned GET', () => {
    const url = presignUrl({
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      expiresInSeconds: 86400,
      credentials,
      region: 'us-east-1',
      date,
    });

    expect(url.searchParams.get('X-Amz-Signature')).toBe('aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
    expect(url.toString()).toBe(
      'https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256' +
        '&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request' +
        '&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host' +
        '&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
    );
  });
});
