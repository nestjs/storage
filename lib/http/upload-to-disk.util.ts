import type {
  StoredUpload,
  UploadFileInfo,
  UploadStorageEngine,
  UploadToDiskOptions,
} from '../interfaces/upload-to-disk.interface.js';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { PayloadTooLargeException, UnsupportedMediaTypeException } from '@nestjs/common';
import { DEFAULT_CONTENT_TYPE, detectContentType, EXTENSION_BY_TYPE, SNIFF_BYTES } from '../utils/content-type.util.js';
import { StorageError } from '../errors/storage.error.js';
import type { StorageDisk } from '../disks/storage.disk.js';
import { storageForRequest } from './app-registry.util.js';

const DEFAULT_CONTENT_TYPE_SAMPLE_BYTES = 4 * 1024;
const MIN_CONTENT_TYPE_SAMPLE_BYTES = 1;
const MAX_CONTENT_TYPE_SAMPLE_BYTES = 64 * 1024;

/**
 * A storage engine for `FileInterceptor()` and friends that streams each upload straight into a
 * disk, on Express (multer) and Fastify (`@nestjs/platform-fastify/multipart`) alike:
 *
 * ```ts
 * @UseInterceptors(FileInterceptor('photo', {
 *   storage: uploadToDisk({ disk: 'photos', contentTypes: ['image/jpeg', 'image/png'] }),
 *   limits: { fileSize: 5_000_000 },
 * }))
 * ```
 *
 * - The type is checked before anything is written. Signature detection runs first; when it
 *   cannot identify a type, an optional `detectContentType` callback can classify a bounded
 *   prefix. A prefix detector does not validate the whole file.
 * - For a text format such as CSV, opt in with `detectContentType` and allow its returned type:
 *   ```ts
 *   uploadToDisk({
 *     contentTypes: ['text/csv'],
 *     detectContentType: (bytes) =>
 *       bytes.toString('utf8').startsWith('sku,name\n') ? 'text/csv' : undefined,
 *   });
 *   ```
 * - A file over `limits.fileSize` is refused with a 413, and nothing is written: a truncated
 *   upload never becomes visible, and never replaces the file at its key.
 * - When the request fails after a file was stored (another file too large, a missing
 *   field), multer and the Fastify parser delete it through `_removeFile()`.
 *
 * Validation that runs later, in pipes or the handler, sees a file that is already stored:
 * delete `file.key` when you reject it there.
 */
export function uploadToDisk(options: UploadToDiskOptions = {}): UploadStorageEngine {
  const allowed = options.contentTypes;
  if (allowed !== undefined && (!Array.isArray(allowed) || allowed.length === 0)) {
    throw new TypeError('uploadToDisk(): `contentTypes` must be a non-empty array');
  }
  if (options.detectContentType !== undefined && typeof options.detectContentType !== 'function') {
    throw new TypeError('uploadToDisk(): `detectContentType` must be a function');
  }
  if (options.contentTypeSampleBytes !== undefined && options.detectContentType === undefined) {
    throw new TypeError('uploadToDisk(): `contentTypeSampleBytes` requires `detectContentType`');
  }
  const contentTypeSampleBytes =
    options.contentTypeSampleBytes ?? DEFAULT_CONTENT_TYPE_SAMPLE_BYTES;
  if (
    options.contentTypeSampleBytes !== undefined &&
    (!Number.isSafeInteger(contentTypeSampleBytes) ||
      contentTypeSampleBytes < MIN_CONTENT_TYPE_SAMPLE_BYTES ||
      contentTypeSampleBytes > MAX_CONTENT_TYPE_SAMPLE_BYTES)
  ) {
    throw new TypeError(
      'uploadToDisk(): `contentTypeSampleBytes` must be a whole number between ' +
        `${MIN_CONTENT_TYPE_SAMPLE_BYTES} and ${MAX_CONTENT_TYPE_SAMPLE_BYTES}`,
    );
  }

  const diskName = typeof options.disk === 'string' ? options.disk : undefined;
  const resolveDisk = (req: any): StorageDisk => {
    if (options.disk !== undefined && typeof options.disk !== 'string') {
      return options.disk;
    }

    const storage = storageForRequest(req);
    if (!storage) {
      throw new StorageError(
        'uploadToDisk(): no StorageModule in the application handling this request. Import ' +
          'StorageModule.forRoot() or forRootAsync(), or pass a StorageDisk instance as `disk`.',
      );
    }

    return storage.disk(diskName);
  };

  return {
    _handleFile(req, file, callback) {
      const stream: Readable & { truncated?: boolean } = file.stream;
      let limitHit = false;
      // Registered first: busboy may have hit the limit on the chunk at hand already.
      stream.once('limit', () => (limitHit = true));
      const source = chunksOf(stream)[Symbol.asyncIterator]();

      const store = async (): Promise<Partial<StoredUpload>> => {
        const disk = resolveDisk(req);

        const head: Buffer[] = [];
        let headLength = 0;
        let ended = false;
        while (headLength < SNIFF_BYTES) {
          const next = await source.next();
          if (next.done) {
            ended = true;
            break;
          }
          head.push(next.value);
          headLength += next.value.length;
        }

        let detected = detectContentType(Buffer.concat(head));
        if (detected === undefined && options.detectContentType) {
          while (headLength < contentTypeSampleBytes && !ended) {
            const next = await source.next();
            if (next.done) {
              ended = true;
              break;
            }
            head.push(next.value);
            headLength += next.value.length;
          }

          const fileInfo: UploadFileInfo = {
            fieldname: file.fieldname,
            originalname: file.originalname,
            mimetype: file.mimetype,
            contentType: undefined,
            extension: '',
          };
          detected = await options.detectContentType(
            Buffer.concat(head).subarray(0, contentTypeSampleBytes),
            fileInfo,
          );
        }
        if (allowed && (detected === undefined || !allowed.includes(detected))) {
          throw new UnsupportedMediaTypeException(`File type not allowed. Allowed types: ${allowed.join(', ')}`);
        }

        const info: UploadFileInfo = {
          fieldname: file.fieldname,
          originalname: file.originalname,
          mimetype: file.mimetype,
          contentType: detected,
          extension: detected ? (EXTENSION_BY_TYPE[detected] ?? '') : '',
        };
        const key = options.key ? await options.key(info, req) : `${randomUUID()}${info.extension}`;

        const body = async function* () {
          yield* head;
          if (!ended) {
            for (let next = await source.next(); !next.done; next = await source.next()) {
              yield next.value;
            }
          }
          // busboy truncates a file at the limit and ends it normally: refuse to commit it.
          if (limitHit || stream.truncated) {
            throw new PayloadTooLargeException('File too large');
          }
        };
        const result = await disk.put(key, body(), {
          contentType: detected ?? DEFAULT_CONTENT_TYPE,
          cacheControl: options.cacheControl,
          metadata: options.metadata?.(info, req),
        });
        return { key, disk: diskName, size: result.size, contentType: result.contentType, etag: result.etag };
      };

      store().then(
        (info) => callback(null, info),
        async (error) => {
          // Let the parser go on (or wind down) without this file: read the rest and discard it.
          await source.return?.();
          if (!stream.readableEnded && !stream.destroyed) {
            stream.resume();
          }
          callback(error);
        },
      );
    },

    _removeFile(req, file, callback) {
      if (typeof file?.key !== 'string') {
        return callback(null);
      }

      let disk: StorageDisk;
      try {
        disk = resolveDisk(req);
      } catch (error) {
        return callback(error as Error);
      }

      const key = file.key;
      delete file.key;
      disk.delete(key).then(
        () => callback(null),
        (error: Error) => callback(error),
      );
    },
  };
}

/**
 * A file stream's chunks, read with events rather than the stream's async iterator: leaving the
 * loop early drains the stream instead of destroying it, so the multipart parser can carry on
 * or finish cleanly. A stream that closes before it ends (a client that disconnected, a
 * parser that gave up) fails the loop, and the write is abandoned.
 */
function chunksOf(stream: Readable): AsyncIterable<Buffer> {
  return {
    async *[Symbol.asyncIterator]() {
      const queue: Buffer[] = [];
      let ended = false;
      let failure: unknown;
      let wake: (() => void) | undefined;

      const notify = () => {
        const resume = wake;
        wake = undefined;
        resume?.();
      };
      const onData = (chunk: Buffer) => {
        queue.push(chunk);
        if (queue.length >= 8) {
          stream.pause();
        }
        notify();
      };
      const onEnd = () => {
        ended = true;
        notify();
      };
      const onError = (error: unknown) => {
        failure ??= error;
        notify();
      };
      const onClose = () => {
        if (!ended) {
          failure ??= new StorageError('The upload ended before the file was complete');
        }
        notify();
      };

      stream.on('data', onData);
      stream.once('end', onEnd);
      stream.once('error', onError);
      stream.once('close', onClose);

      try {
        for (;;) {
          if (queue.length > 0) {
            const chunk = queue.shift()!;
            if (queue.length < 8 && stream.isPaused()) {
              stream.resume();
            }
            yield chunk;
          } else if (failure !== undefined) {
            throw failure;
          } else if (ended) {
            return;
          } else {
            await new Promise<void>((resolve) => (wake = resolve));
          }
        }
      } finally {
        stream.off('data', onData);
        stream.off('end', onEnd);
        stream.off('close', onClose);
        // Keep an error listener: an unhandled 'error' would crash the process.
        stream.off('error', onError);
        stream.on('error', () => undefined);
        if (!ended && !stream.destroyed) {
          stream.resume();
        }
      }
    },
  };
}
