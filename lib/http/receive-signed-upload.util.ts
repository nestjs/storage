import type { ReceiveSignedUploadOptions } from '../interfaces/http-options.interface.js';
import { BadRequestException, ForbiddenException, HttpException, HttpStatus, PayloadTooLargeException } from '@nestjs/common';
import type { Readable } from 'node:stream';
import { StorageBodyLengthError } from '../errors/storage-body-length.error.js';
import type { StorageDisk } from '../disks/storage.disk.js';
import type { StorageWriteResult } from '../interfaces/storage-disk.interface.js';
import { requestHeaders, setHeader, verify } from './serve-file.util.js';

/**
 * Receives a `PUT` to an app-served signed upload URL (`signedUpload()` on a `LocalDisk` or
 * `InMemoryDisk` with `signedUrls`), the way S3 receives one to a presigned URL: the
 * signature, expiry and method are checked, the `Content-Type` must be the signed one, a
 * signed `Content-Length` must match, and the body streams onto the disk. A bad URL or header
 * is a `ForbiddenException`; a body of the wrong length, a `BadRequestException`.
 *
 * On Fastify, register a catch-all content type parser that leaves the body unread, so the
 * upload reaches the handler as a stream:
 * `app.getHttpAdapter().getInstance().addContentTypeParser('*', (req, payload, done) => done(null))`.
 */
export async function receiveSignedUpload(disk: StorageDisk, options: ReceiveSignedUploadOptions): Promise<StorageWriteResult> {
  const claims = verify(disk, options.req, 'PUT');
  const headers = requestHeaders(options.req);

  if (claims.contentType !== undefined && headers['content-type'] !== claims.contentType) {
    throw new ForbiddenException('The Content-Type does not match the signed URL');
  }

  const declared = headers['content-length'];
  if (declared === undefined || !/^\d+$/.test(declared)) {
    throw new HttpException('Length Required', HttpStatus.LENGTH_REQUIRED);
  }
  const length = Number(declared);
  if (claims.contentLength !== undefined && length !== claims.contentLength) {
    throw new ForbiddenException('The Content-Length does not match the signed URL');
  }
  if (claims.contentLength === undefined && options.maxSize !== undefined && length > options.maxSize) {
    throw new PayloadTooLargeException();
  }

  const body = rawBody(options.req);
  let result: StorageWriteResult;
  try {
    result = await disk.put(claims.key, body, { contentType: claims.contentType, contentLength: length });
  } catch (error) {
    if (error instanceof StorageBodyLengthError) {
      throw new BadRequestException('The body does not match its Content-Length');
    }
    throw error;
  }

  if (options.res && result.etag) {
    setHeader(options.res, 'ETag', result.etag);
  }

  return result;
}

/** Express's request is the stream; Fastify's is on `raw`. Refuses a body a parser already read. */
function rawBody(req: unknown): Readable {
  const r = req as { raw?: Readable; body?: unknown; _body?: boolean; readableEnded?: boolean } & Readable;
  const stream = (r.raw ?? r) as Readable & { _body?: boolean };
  const parsed = r.raw ? r.body !== undefined && r.body !== null : r._body === true;
  if (parsed || stream.readableEnded) {
    throw new BadRequestException('The upload body was already parsed; signed uploads need the raw request body');
  }
  return stream;
}
