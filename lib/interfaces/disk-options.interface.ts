import type { Duration } from './duration.interface.js';
import type { StorageRetryOptions } from './storage-retry-options.interface.js';
import type { StorageSignedUrlOptions } from './storage-signed-url.interface.js';

/** Options every disk takes. */
export interface StorageDiskOptions {
  /** Base URL of the public copy of the files (a CDN, a public bucket, a static route). Enables `url()`. */
  publicUrl?: string | URL;
  /**
   * App-served signed URLs, for disks that can't presign: `signedUrl()` and `signedUpload()`
   * return URLs under `baseUrl`, which your app serves with `serveSignedUrl()` and
   * `receiveSignedUpload()`.
   */
  signedUrls?: StorageSignedUrlOptions;
}

export interface LocalDiskOptions extends StorageDiskOptions {
  /** The directory that holds the files. Created at startup when missing. */
  root: string;
}

export type InMemoryDiskOptions = StorageDiskOptions;

export interface S3DiskOptions extends Omit<StorageDiskOptions, 'signedUrls'> {
  bucket: string;
  /**
   * Default: `AWS_REGION`, then `AWS_DEFAULT_REGION`, then `us-east-1`. Cloudflare R2 uses
   * `auto`; MinIO accepts any region it was configured with (`us-east-1` by default).
   */
  region?: string;
  /**
   * The service endpoint, for S3-compatible stores: `https://<account>.r2.cloudflarestorage.com`,
   * `http://localhost:9000` (MinIO), `https://s3.<region>.backblazeb2.com`,
   * `https://storage.googleapis.com`. Default: AWS's regional endpoint.
   */
  endpoint?: string | URL;
  /**
   * `https://endpoint/bucket/key` instead of `https://bucket.endpoint/key`. Needed by MinIO
   * and most self-hosted stores. Used anyway when the endpoint is an IP address or the bucket
   * name isn't a valid host name (dots over HTTPS, uppercase, underscores).
   */
  forcePathStyle?: boolean;
  /**
   * Default: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_SESSION_TOKEN`. A function
   * is called before every request, so it can return rotating credentials (it should cache).
   */
  credentials?: S3Credentials | (() => S3Credentials | Promise<S3Credentials>);
  /** Prefix every key with this (e.g. `'tenants/t1/'`), so several disks can share a bucket. */
  prefix?: string;
  /** Server-side encryption for new objects: `AES256` (SSE-S3) or `aws:kms` (SSE-KMS, with `kmsKeyId`). */
  serverSideEncryption?: 'AES256' | 'aws:kms' | 'aws:kms:dsse';
  /** The KMS key for `aws:kms`; the bucket's AWS-managed key without it. */
  kmsKeyId?: string;
  multipart?: {
    /**
     * Bodies up to this size go up in one request; longer ones (and streams that turn out
     * longer) in parts of this size. Bytes; at least 5 MiB (S3's minimum part size). Default 8 MiB.
     */
    partSize?: number;
    /** Parts uploaded at once. Memory use is about `(concurrency + 1) × partSize`. Default 4. */
    concurrency?: number;
  };
  /** Retries of transient failures (see `StorageRetryOptions`). Default 3 attempts. `false` for one. */
  retry?: number | false | StorageRetryOptions;
  /**
   * Per-attempt limit, e.g. `'30s'`: until the response body is read, or until the headers
   * arrive for `get()`, whose body streams. Default none (undici's own 300-second timeouts apply).
   */
  timeout?: Duration;
  /**
   * Delete several keys with one `DeleteObjects` request. Default `true`. Set `false` for
   * stores without it (Google Cloud Storage's XML API).
   */
  batchDelete?: boolean;
  /** `fetch` implementation. Default `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
}

/** AWS credentials. A session token comes with temporary credentials (STS, SSO, IRSA). */
export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}
