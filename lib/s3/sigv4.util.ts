import type { S3Credentials } from '../interfaces/disk-options.interface.js';
import { createHash, createHmac } from 'node:crypto';
import { encodeRfc3986 } from '../utils/keys.util.js';

export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';
const ALGORITHM = 'AWS4-HMAC-SHA256';

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/** `20150830T123600Z` */
export function amzDate(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/**
 * The canonical query string: every name and value RFC 3986-encoded, sorted by name, then
 * by value. Takes decoded pairs.
 */
export function canonicalQuery(pairs: Iterable<[string, string]>): string {
  return [...pairs]
    .map(([name, value]) => [encodeRfc3986(name), encodeRfc3986(value)] as const)
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
}

/**
 * Canonical headers: names lowercased and sorted, values trimmed with inner runs of
 * whitespace (folded lines included) collapsed to one space, repeated headers joined with
 * commas in the order they came.
 */
export function canonicalHeaders(headers: Iterable<[string, string]>): { canonical: string; signed: string } {
  const merged = new Map<string, string[]>();
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    const list = merged.get(lower) ?? [];
    list.push(value.trim().replace(/\s+/g, ' '));
    merged.set(lower, list);
  }

  const names = [...merged.keys()].sort();
  return {
    canonical: names.map((name) => `${name}:${merged.get(name)!.join(',')}\n`).join(''),
    signed: names.join(';'),
  };
}

export interface CanonicalRequestInput {
  method: string;
  /** The path exactly as sent, already encoded (S3 paths are not normalized or re-encoded). */
  path: string;
  query: Iterable<[string, string]>;
  headers: Iterable<[string, string]>;
  payloadHash: string;
}

export function canonicalRequest(input: CanonicalRequestInput): { request: string; signedHeaders: string } {
  const { canonical, signed } = canonicalHeaders(input.headers);
  const request = [
    input.method,
    input.path || '/',
    canonicalQuery(input.query),
    canonical,
    signed,
    input.payloadHash,
  ].join('\n');
  return { request, signedHeaders: signed };
}

export function credentialScope(date: Date, region: string, service: string): string {
  return `${amzDate(date).slice(0, 8)}/${region}/${service}/aws4_request`;
}

export function stringToSign(request: string, date: Date, scope: string): string {
  return [ALGORITHM, amzDate(date), scope, sha256Hex(request)].join('\n');
}

export function signature(secretAccessKey: string, date: Date, region: string, service: string, toSign: string): string {
  const dateKey = hmac(`AWS4${secretAccessKey}`, amzDate(date).slice(0, 8));
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, service);
  const signingKey = hmac(serviceKey, 'aws4_request');
  return createHmac('sha256', signingKey).update(toSign, 'utf8').digest('hex');
}

export interface SignRequestInput {
  method: string;
  url: URL;
  /** Every header to send and sign, lowercase names; `host` and `x-amz-date` are added. */
  headers: Record<string, string>;
  payloadHash: string;
  credentials: S3Credentials;
  region: string;
  service?: string;
  date?: Date;
}

/** Header-based SigV4: returns the headers to send, `authorization` included. */
export function signRequest(input: SignRequestInput): Record<string, string> {
  const date = input.date ?? new Date();
  const service = input.service ?? 's3';
  const headers: Record<string, string> = {
    ...input.headers,
    host: input.url.host,
    'x-amz-date': amzDate(date),
  };
  if (input.credentials.sessionToken) {
    headers['x-amz-security-token'] = input.credentials.sessionToken;
  }

  const { request, signedHeaders } = canonicalRequest({
    method: input.method,
    path: input.url.pathname,
    query: decodedQuery(input.url),
    headers: Object.entries(headers),
    payloadHash: input.payloadHash,
  });
  const scope = credentialScope(date, input.region, service);
  const sig = signature(input.credentials.secretAccessKey, date, input.region, service, stringToSign(request, date, scope));

  headers.authorization =
    `${ALGORITHM} Credential=${input.credentials.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${sig}`;

  // `host` is set by fetch from the URL, and fetch refuses to be given one.
  delete headers.host;
  return headers;
}

export interface PresignInput {
  method: 'GET' | 'PUT';
  url: URL;
  /** Headers the client must send, besides `host`. Lowercase names. */
  headers?: Record<string, string>;
  expiresInSeconds: number;
  credentials: S3Credentials;
  region: string;
  service?: string;
  date?: Date;
}

/** Query-string SigV4 (a presigned URL), with an unsigned payload. */
export function presignUrl(input: PresignInput): URL {
  const date = input.date ?? new Date();
  const service = input.service ?? 's3';
  const url = new URL(input.url);
  const headers: Record<string, string> = { ...input.headers, host: url.host };
  const scope = credentialScope(date, input.region, service);
  const signedHeaders = Object.keys(headers).map((name) => name.toLowerCase()).sort().join(';');

  url.searchParams.set('X-Amz-Algorithm', ALGORITHM);
  url.searchParams.set('X-Amz-Credential', `${input.credentials.accessKeyId}/${scope}`);
  url.searchParams.set('X-Amz-Date', amzDate(date));
  url.searchParams.set('X-Amz-Expires', String(input.expiresInSeconds));
  if (input.credentials.sessionToken) {
    url.searchParams.set('X-Amz-Security-Token', input.credentials.sessionToken);
  }
  url.searchParams.set('X-Amz-SignedHeaders', signedHeaders);

  const { request } = canonicalRequest({
    method: input.method,
    path: url.pathname,
    query: decodedQuery(url),
    headers: Object.entries(headers),
    payloadHash: UNSIGNED_PAYLOAD,
  });
  const sig = signature(input.credentials.secretAccessKey, date, input.region, service, stringToSign(request, date, scope));
  url.searchParams.set('X-Amz-Signature', sig);

  // URLSearchParams writes spaces as "+", which S3 would read as a literal plus: re-encode the
  // query the way it was signed.
  url.search = canonicalQueryInOrder(url);
  return url;
}

/** The URL's query as decoded pairs. `URLSearchParams` decodes `+` as a space, as S3 does. */
function decodedQuery(url: URL): [string, string][] {
  return [...url.searchParams];
}

function canonicalQueryInOrder(url: URL): string {
  return [...url.searchParams].map(([name, value]) => `${encodeRfc3986(name)}=${encodeRfc3986(value)}`).join('&');
}
