// Module: disks by name, a default, injection
export { StorageModule } from './storage.module.js';
export { STORAGE_MODULE_OPTIONS } from './storage.constants.js';
export { getDiskToken } from './storage.module-definition.js';
export type {
  Duration,
  StorageModuleAsyncOptions,
  StorageModuleOptions,
  StorageModuleRootOptions,
  StorageOptionsFactory,
} from './interfaces/index.js';
export { Storage } from './storage.service.js';
export * from './decorators/index.js';

// Disks: the contract (and default disk token), and the built-ins
export { StorageDisk } from './disks/storage.disk.js';
export { LocalDisk } from './disks/local.disk.js';
export { InMemoryDisk } from './disks/in-memory.disk.js';
// Would be a subpath export (`@nestjs/storage/s3`) in a real package
export { S3Disk } from './s3/s3.disk.js';
export type {
  InMemoryDiskOptions,
  LocalDiskOptions,
  S3Credentials,
  S3DiskOptions,
  StorageBackoffOptions,
  StorageBody,
  StorageDiskOptions,
  StorageDownload,
  StorageFile,
  StorageGetOptions,
  StorageListEntry,
  StorageListOptions,
  StorageListPage,
  StorageObjectWrite,
  StoragePutOptions,
  StorageRange,
  StorageRetryOptions,
  StorageSignedUpload,
  StorageSignedUploadRequest,
  StorageSignedUrlClaims,
  StorageSignedUrlOptions,
  StorageSignedUrlRequest,
  StorageWriteResult,
} from './interfaces/index.js';

// Checking what a client really sent
export { detectContentType } from './utils/content-type.util.js';

// HTTP: uploads with FileInterceptor, downloads, app-served signed URLs
export { uploadToDisk } from './http/upload-to-disk.util.js';
export { serveFile, serveSignedUrl } from './http/serve-file.util.js';
export { receiveSignedUpload } from './http/receive-signed-upload.util.js';
export type {
  ReceiveSignedUploadOptions,
  ServeFileOptions,
  ServeSignedUrlOptions,
  StoredUpload,
  UploadFileInfo,
  UploadStorageEngine,
  UploadToDiskOptions,
} from './interfaces/index.js';

// Errors
export * from './errors/index.js';
