import type { StorageDisk } from '../disks/storage.disk.js';

/** What `key()` and `metadata()` get: the upload as the client described it, and what it really is. */
export interface UploadFileInfo {
  fieldname: string;
  /** The client's file name. Untrusted: don't build keys or paths from it. */
  originalname: string;
  /** The client's declared type. Untrusted. */
  mimetype: string;
  /** The type detected from the file bytes by built-in or custom detection, if any. */
  contentType: string | undefined;
  /** The usual extension for `contentType` (`.jpg`), or `''` when it has no known mapping. */
  extension: string;
}

/** What the upload engine adds to the file `@UploadedFile()` returns. */
export interface StoredUpload {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  /** Bytes stored. */
  size: number;
  /** Where the file is on the disk. */
  key: string;
  /** The disk's name, when the engine was given one. */
  disk?: string;
  /** The stored type: the detected one, else `application/octet-stream`, never the client's claim. */
  contentType: string;
  etag?: string;
}

export interface UploadToDiskOptions {
  /** The disk's name in `StorageModule`, or a disk instance. Default: the default disk. */
  disk?: string | StorageDisk;
  /**
   * The key to store the file at. Default: a random UUID plus the detected extension. Keys
   * should be unique: a failed request deletes what it stored, and a shared key would take
   * the previous file with it.
   */
  key?: (file: UploadFileInfo, req: any) => string | Promise<string>;
  /**
   * Accept only these types, detected from the file's bytes. Anything else is refused with a
   * 415 before a byte is written.
   */
  contentTypes?: string[];
  /**
   * Optional fallback for file types without a recognizable signature. It runs only when the
   * built-in detector returns `undefined`, and receives at most `contentTypeSampleBytes` from
   * the start of the file. This classifies a prefix; it does not validate the whole file.
   * `file` contains client-provided values such as `originalname` and `mimetype`, which are
   * untrusted. Its `contentType` is `undefined` and `extension` is `''` during this callback.
   * Return the detected content type, or `undefined` when the type is unknown.
   */
  detectContentType?: (
    bytes: Buffer,
    file: UploadFileInfo,
  ) => string | undefined | Promise<string | undefined>;
  /**
   * Maximum prefix size passed to `detectContentType`. Defaults to 4 KiB; must be a whole
   * number between 1 byte and 64 KiB. This option requires `detectContentType`.
   */
  contentTypeSampleBytes?: number;
  cacheControl?: string;
  metadata?: (file: UploadFileInfo, req: any) => Record<string, string>;
}

/** The storage engine contract of multer and of `@nestjs/platform-fastify/multipart`. */
export interface UploadStorageEngine {
  _handleFile(req: any, file: any, callback: (error?: any, info?: Partial<StoredUpload>) => void): void;
  _removeFile(req: any, file: any, callback: (error: Error | null) => void): void;
}
