/**
 * Content types by extension, for `put()` without a `contentType`. Deliberately small:
 * the formats apps store most. Anything else is `application/octet-stream`.
 */
const BY_EXTENSION: Record<string, string> = {
  avif: 'image/avif',
  bmp: 'image/bmp',
  css: 'text/css; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  epub: 'application/epub+zip',
  gif: 'image/gif',
  gz: 'application/gzip',
  heic: 'image/heic',
  htm: 'text/html; charset=utf-8',
  html: 'text/html; charset=utf-8',
  ico: 'image/vnd.microsoft.icon',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  js: 'text/javascript; charset=utf-8',
  json: 'application/json',
  m4a: 'audio/mp4',
  md: 'text/markdown; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  ogg: 'audio/ogg',
  pdf: 'application/pdf',
  png: 'image/png',
  svg: 'image/svg+xml',
  tar: 'application/x-tar',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  txt: 'text/plain; charset=utf-8',
  wav: 'audio/wav',
  webm: 'video/webm',
  webp: 'image/webp',
  woff: 'font/woff',
  woff2: 'font/woff2',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xml: 'application/xml',
  zip: 'application/zip',
};

export const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

export function contentTypeFromKey(key: string): string {
  const name = key.slice(key.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) {
    return DEFAULT_CONTENT_TYPE;
  }
  return BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? DEFAULT_CONTENT_TYPE;
}

/** The usual extension for a detected type, for keys built from uploads. */
export const EXTENSION_BY_TYPE: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/heic': '.heic',
  'application/pdf': '.pdf',
};

/** How many leading bytes `detectContentType()` needs to recognize every format it knows. */
export const SNIFF_BYTES = 16;

const startsWith = (bytes: Uint8Array, signature: number[], offset = 0) =>
  bytes.length >= offset + signature.length &&
  signature.every((byte, i) => bytes[offset + i] === byte);
const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));

/**
 * The type of a file from its first bytes (at least 16 for every format below), or
 * `undefined` when it isn't one of: JPEG, PNG, GIF, WebP, AVIF, HEIC, PDF. Use it to check
 * what a client uploaded rather than trusting the type it declared: a declared
 * `image/png` can carry HTML.
 */
export function detectContentType(bytes: Uint8Array): string | undefined {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return 'image/jpeg';
  }
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'image/png';
  }
  if (startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a'))) {
    return 'image/gif';
  }
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) {
    return 'image/webp';
  }
  if (startsWith(bytes, ascii('%PDF-'))) {
    return 'application/pdf';
  }

  // ISO base media: a box size, then "ftyp" and the major brand
  if (startsWith(bytes, ascii('ftyp'), 4)) {
    const brand = String.fromCharCode(...bytes.subarray(8, 12));
    if (brand === 'avif' || brand === 'avis') {
      return 'image/avif';
    }
    if (['heic', 'heix', 'heim', 'heis'].includes(brand)) {
      return 'image/heic';
    }
  }

  return undefined;
}
