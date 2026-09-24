import type { StorageDisk } from '../disks/storage.disk.js';

/** What `key()` and `metadata()` get: the upload as the client described it, and what it really is. */
export interface UploadFileInfo {
  fieldname: string;
  /** The client's file name. Untrusted: don't build keys or paths from it. */
  originalname: string;
  /** The client's declared type. Untrusted. */
  mimetype: string;
  /** The type detected from the first bytes (JPEG, PNG, GIF, WebP, AVIF, HEIC, PDF), if any. */
  contentType: string | undefined;
  /** The usual extension for `contentType` (`.jpg`), or `''`. */
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
   * Accept only these types, detected from the file's first bytes (see `detectContentType()`).
   * Anything else is refused with a 415 before a byte is written.
   */
  contentTypes?: string[];
  cacheControl?: string;
  metadata?: (file: UploadFileInfo, req: any) => Record<string, string>;
}

/** The storage engine contract of multer and of `@nestjs/platform-fastify/multipart`. */
export interface UploadStorageEngine {
  _handleFile(req: any, file: any, callback: (error?: any, info?: Partial<StoredUpload>) => void): void;
  _removeFile(req: any, file: any, callback: (error: Error | null) => void): void;
}
