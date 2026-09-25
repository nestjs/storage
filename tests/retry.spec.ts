/**
 * The retry vocabulary S3Disk takes (`retry: 3 | false | { attempts, backoff, retryIf }`):
 * the delays it computes, the options it refuses, and the waits between attempts, under fake
 * timers.
 */
import { S3Disk, StorageServiceError } from '../lib/index.js';
import { resolveRetry, sleep } from '../lib/s3/retry.util.js';

const delays = (retry: ReturnType<typeof resolveRetry>, count: number) =>
  Array.from({ length: count }, (_, i) => retry.delay(i + 1, new Error('x')));

describe('resolveRetry()', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('false is a single attempt; a number sets the attempts; nothing means 3', () => {
    expect(resolveRetry(false, 'S3Disk').attempts).toBe(1);
    expect(resolveRetry(5, 'S3Disk').attempts).toBe(5);
    expect(resolveRetry(undefined, 'S3Disk').attempts).toBe(3);
    expect(resolveRetry({}, 'S3Disk').attempts).toBe(3);
  });

  it("defaults to AWS's backoff: 100 ms doubling, capped at 20 s, with full jitter", () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    expect(delays(resolveRetry(undefined, 'S3Disk'), 3)).toEqual([50, 100, 200]);

    vi.spyOn(Math, 'random').mockReturnValue(0.999999);
    expect(resolveRetry(undefined, 'S3Disk').delay(20, undefined)).toBe(19_999);
  });

  it('grows by factor up to maxDelay without jitter', () => {
    const retry = resolveRetry({ backoff: { delay: 100, factor: 3, maxDelay: '1s', jitter: 'none' } }, 'S3Disk');
    expect(delays(retry, 5)).toEqual([100, 300, 900, 1000, 1000]);
  });

  it('a factor of 1 keeps the delay constant', () => {
    const retry = resolveRetry({ backoff: { delay: '250ms', factor: 1, jitter: 'none' } }, 'S3Disk');
    expect(delays(retry, 3)).toEqual([250, 250, 250]);
  });

  it('equal jitter waits between half the delay and the whole of it', () => {
    const retry = resolveRetry({ backoff: { delay: 1000, jitter: 'equal' } }, 'S3Disk');

    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(retry.delay(1, undefined)).toBe(500);
    vi.spyOn(Math, 'random').mockReturnValue(0.999);
    expect(retry.delay(1, undefined)).toBe(999);
  });

  it('a backoff function gets the attempt and the error, and may return a duration string', () => {
    const backoff = vi.fn((attempt: number) => `${attempt}s` as const);
    const retry = resolveRetry({ backoff }, 'S3Disk');
    const error = new Error('boom');

    expect(retry.delay(2, error)).toBe(2000);
    expect(backoff).toHaveBeenCalledWith(2, error);
  });

  it('refuses a bad duration from a backoff function when it is used', () => {
    const retry = resolveRetry({ backoff: () => 'later' as never }, 'S3Disk');
    expect(() => retry.delay(1, undefined)).toThrow('S3Disk `retry.backoff()`: Invalid duration "later"');
  });

  it.each([
    [{ attempts: 1.5 }, '`retry.attempts` must be a whole number of at least 1'],
    [{ attempts: -1 }, '`retry.attempts`'],
    [{ backoff: { delay: '1 min' as never } }, 'S3Disk `retry.backoff.delay`: Invalid duration "1 min"'],
    [{ backoff: { maxDelay: -1 } }, 'S3Disk `retry.backoff.maxDelay`: Invalid duration -1'],
  ])('refuses %o', (options, message) => {
    expect(() => resolveRetry(options, 'S3Disk')).toThrow(message);
  });

  it('keeps retryIf', () => {
    const retryIf = () => true;
    expect(resolveRetry({ retryIf }, 'S3Disk').retryIf).toBe(retryIf);
  });
});

describe('sleep()', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves after the delay', async () => {
    let done = false;
    const waiting = sleep(1000).then(() => (done = true));

    await vi.advanceTimersByTimeAsync(999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await waiting;
    expect(done).toBe(true);
  });

  it('rejects at once with the reason of an aborted signal, and clears its timer', async () => {
    const reason = new Error('stop');
    await expect(sleep(1000, AbortSignal.abort(reason))).rejects.toBe(reason);

    const controller = new AbortController();
    const waiting = sleep(60_000, controller.signal);
    expect(vi.getTimerCount()).toBe(1);

    controller.abort(reason);
    await expect(waiting).rejects.toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('S3Disk waits between attempts', () => {
  const credentials = { accessKeyId: 'AKID', secretAccessKey: 'secret' };
  const slowDown = () =>
    new Response('<Error><Code>SlowDown</Code></Error>', { status: 503, headers: { 'content-type': 'application/xml' } });

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends the next attempt only once the backoff has elapsed', async () => {
    const sent: number[] = [];
    const fetch = (async () => {
      sent.push(Date.now());
      return sent.length < 3 ? slowDown() : new Response(Buffer.from('x'));
    }) as typeof globalThis.fetch;
    const disk = new S3Disk({
      bucket: 'shop',
      endpoint: 'http://127.0.0.1:9000',
      credentials,
      fetch,
      retry: { attempts: 3, backoff: { delay: '1s', factor: 2, jitter: 'none' } },
    });

    const reading = disk.getText('a.txt');
    await vi.advanceTimersByTimeAsync(999);
    expect(sent).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(1999);
    expect(sent).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);

    expect(await reading).toBe('x');
    expect(sent.map((t) => t - sent[0])).toEqual([0, 1000, 3000]);
  });

  it('asks retryIf with the attempt number, and stops when it says no', async () => {
    let calls = 0;
    const fetch = (async () => {
      calls++;
      return slowDown();
    }) as typeof globalThis.fetch;
    const retryIf = vi.fn((_error: unknown, attempt: number) => attempt < 2);
    const disk = new S3Disk({ bucket: 'shop', endpoint: 'http://127.0.0.1:9000', credentials, fetch, retry: { attempts: 5, retryIf, backoff: { delay: 10 } } });

    const reading = disk.getText('a.txt').catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(100);

    expect(await reading).toBeInstanceOf(StorageServiceError);
    expect(calls).toBe(2);
    expect(retryIf.mock.calls.map(([, attempt]) => attempt)).toEqual([1, 2]);
  });

  it("a caller's abort during the wait ends the write with its reason, without another attempt", async () => {
    let calls = 0;
    const fetch = (async () => {
      calls++;
      return slowDown();
    }) as typeof globalThis.fetch;
    const disk = new S3Disk({ bucket: 'shop', endpoint: 'http://127.0.0.1:9000', credentials, fetch, retry: { attempts: 3, backoff: { delay: '10s', jitter: 'none' } } });
    const controller = new AbortController();
    const reason = new Error('user cancelled');

    const writing = disk.put('a.txt', 'x', { signal: controller.signal }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toBe(1);

    controller.abort(reason);
    expect(await writing).toBe(reason);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls).toBe(1);
  });
});
