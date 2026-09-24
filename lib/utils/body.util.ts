import type { StorageBody } from '../interfaces/storage-disk.interface.js';
import { StorageBodyLengthError } from '../errors/storage-body-length.error.js';

/** The byte length of a body that is already in memory, else `undefined`. */
export function knownLength(body: StorageBody): number | undefined {
  if (typeof body === 'string') {
    return Buffer.byteLength(body, 'utf8');
  }
  if (body instanceof Uint8Array) {
    return body.byteLength;
  }
  return undefined;
}

/** Any accepted body as an async iterable of Buffers. Throws a `TypeError` for anything else. */
export function toChunks(body: StorageBody): AsyncIterable<Buffer> {
  if (typeof body === 'string') {
    return once(Buffer.from(body, 'utf8'));
  }
  if (body instanceof Uint8Array) {
    return once(Buffer.from(body.buffer, body.byteOffset, body.byteLength));
  }
  if (body instanceof ReadableStream) {
    return buffers(body as AsyncIterable<Uint8Array>);
  }
  if (body && typeof (body as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function') {
    return buffers(body as AsyncIterable<Uint8Array>);
  }
  throw new TypeError(
    'A storage body must be a Buffer, Uint8Array, string, Readable, ReadableStream or async iterable of bytes',
  );
}

async function* once(chunk: Buffer): AsyncIterable<Buffer> {
  if (chunk.byteLength > 0) {
    yield chunk;
  }
}

async function* buffers(source: AsyncIterable<unknown>): AsyncIterable<Buffer> {
  for await (const chunk of source) {
    if (typeof chunk === 'string') {
      yield Buffer.from(chunk, 'utf8');
    } else if (chunk instanceof Uint8Array) {
      yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    } else {
      throw new TypeError('A storage body stream must produce bytes or strings');
    }
  }
}

/**
 * Passes chunks through, and fails with `StorageBodyLengthError` as soon as the body runs
 * past `expected`, or when it ends short of it. Disks write nothing when it throws.
 */
export async function* checkLength(source: AsyncIterable<Buffer>, expected: number | undefined): AsyncIterable<Buffer> {
  let received = 0;
  for await (const chunk of source) {
    received += chunk.byteLength;
    if (expected !== undefined && received > expected) {
      throw new StorageBodyLengthError(expected, received);
    }
    yield chunk;
  }

  if (expected !== undefined && received !== expected) {
    throw new StorageBodyLengthError(expected, received);
  }
}

export async function readAll(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Throws the signal's reason as soon as it aborts: between chunks, and also while the source
 * is still producing the next one (a client that stalled), so an aborted write ends at once.
 * The source is then told to stop, without waiting for it.
 */
export async function* abortable(
  source: AsyncIterable<Buffer>,
  signal: AbortSignal | undefined,
): AsyncIterable<Buffer> {
  if (!signal) {
    return yield* source;
  }
  signal.throwIfAborted();

  const iterator = source[Symbol.asyncIterator]();
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  aborted.catch(() => undefined);

  try {
    for (;;) {
      const pending = iterator.next();
      // Dropped when the abort wins the race: its outcome must not become an unhandled rejection
      pending.catch(() => undefined);
      const next = await Promise.race([pending, aborted]);
      if (next.done) {
        return;
      }
      yield next.value;
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    const stopped = iterator.return?.()?.catch(() => undefined);
    // After an abort, the source may be stuck in `next()` and never answer `return()`
    if (!signal.aborted) {
      await stopped;
    }
  }
}
