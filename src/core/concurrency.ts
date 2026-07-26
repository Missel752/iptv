/** Small concurrency primitives — no runtime dependencies. */

/** Creates a function that limits how many promises run at the same time. */
export function createLimiter(concurrency: number): <T>(fn: () => Promise<T>) => Promise<T> {
  if (concurrency < 1) throw new RangeError('concurrency must be >= 1');
  let active = 0;
  const queue: Array<() => void> = [];

  const next = (): void => {
    active--;
    const run = queue.shift();
    if (run) run();
  };

  return <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const run = (): void => {
        active++;
        void (async () => {
          try {
            resolve(await fn());
          } catch (error) {
            reject(error);
          } finally {
            next();
          }
        })();
      };
      if (active < concurrency) run();
      else queue.push(run);
    });
}

export interface MapOptions {
  concurrency?: number;
  /** Called after each item settles. */
  onProgress?: (done: number, total: number) => void;
  /** When true, rejected items resolve to `undefined` instead of failing the batch. */
  tolerant?: boolean;
}

/** Maps over `items` with bounded concurrency, preserving input order. */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  mapper: (item: T, index: number) => Promise<R>,
  options: MapOptions = {},
): Promise<Array<R | undefined>> {
  const { concurrency = 8, onProgress, tolerant = true } = options;
  const limit = createLimiter(concurrency);
  let done = 0;
  const total = items.length;

  const tasks = items.map((item, index) =>
    limit(async () => {
      try {
        return await mapper(item, index);
      } catch (error) {
        if (!tolerant) throw error;
        return undefined;
      } finally {
        done++;
        onProgress?.(done, total);
      }
    }),
  );

  return Promise.all(tasks);
}

/** Splits an array into `count` roughly equal shards (round-robin). */
export function shard<T>(items: readonly T[], count: number, index: number): T[] {
  if (count <= 1) return [...items];
  if (index < 0 || index >= count) throw new RangeError('shard index out of range');
  return items.filter((_, i) => i % count === index);
}

/** Resolves after `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RetryOptions {
  attempts?: number;
  /** Base delay; grows exponentially with jitter. */
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Return false to stop retrying a specific error. */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

/** Retries `fn` with exponential backoff and full jitter. */
export async function retry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const {
    attempts = 3,
    baseDelayMs = 500,
    maxDelayMs = 15_000,
    shouldRetry = () => true,
    onRetry,
  } = options;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !shouldRetry(error, attempt)) break;
      const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const delay = Math.round(ceiling * (0.5 + Math.random() * 0.5));
      onRetry?.(error, attempt, delay);
      await sleep(delay);
    }
  }
  throw lastError;
}
