import { createLogger } from '@/lib/logger.lib';

const logger = createLogger('lib:throttle');

export type ThrottleOptions = {
  concurrency: number;
  minDelayMs: number;
  maxDelayMs: number;
  signal?: AbortSignal | null;
};

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
const rand = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;

/**
 * Concurrency-limited, jitter-delayed mapper for safe upstream crawling.
 * - Adds a random delay before each work item
 * - Runs with a fixed worker pool
 * - Optionally respects AbortSignal
 */
export async function throttleMap<T, R>(
  items: T[],
  worker: (item: T, index: number) => Promise<R>,
  opts: ThrottleOptions,
): Promise<R[]> {
  const { concurrency, minDelayMs, maxDelayMs, signal } = opts;
  const n = Math.max(0, items.length);
  const results = new Array<R>(n);
  let nextIndex = 0;

  const workers: Promise<void>[] = [];
  const pool = Math.max(1, Math.floor(concurrency));

  for (let w = 0; w < pool; w++) {
    workers.push((async () => {
      while (true) {
        const i = nextIndex++;
        if (i >= n) break;
        if (signal?.aborted) {
          const err: any = new Error('AbortError');
          err.name = 'AbortError';
          throw err;
        }

        await sleep(rand(minDelayMs, maxDelayMs));
        try {
          results[i] = await worker(items[i], i);
        } catch (e) {
          // Propagate error; caller should handle mapping
          throw e;
        }
      }
    })());
  }

  await Promise.all(workers);
  logger.debug('throttleMap completed', { count: n, concurrency: pool, minDelayMs, maxDelayMs });
  return results;
}

export type BaseThrottleOptions = Pick<ThrottleOptions, 'concurrency' | 'minDelayMs' | 'maxDelayMs'>;

/**
 * Read batch throttle settings from a plain config object.
 * Allows per-route caps to be applied by caller via arguments.
 */
export function readBatchThrottle(
  cfg: any,
  caps?: { maxConcurrency?: number; minDelayFloorMs?: number }
): BaseThrottleOptions {
  const maxConcCap = Math.max(1, Math.floor(caps?.maxConcurrency ?? 5));
  const minDelayFloor = Math.max(1, Math.floor(caps?.minDelayFloorMs ?? 50));

  const rawConcurrency = Number(cfg?.INNERTUBE_BATCH_CONCURRENCY ?? 3);
  const rawMinDelay = Number(cfg?.INNERTUBE_BATCH_MIN_DELAY_MS ?? 150);
  const rawMaxDelay = Number(cfg?.INNERTUBE_BATCH_MAX_DELAY_MS ?? 400);

  const concurrency = Math.max(1, Math.min(maxConcCap, Math.floor(rawConcurrency)));
  const minDelayMs = Math.max(minDelayFloor, Math.floor(rawMinDelay));
  const maxDelayMs = Math.max(minDelayMs, Math.floor(rawMaxDelay));

  return { concurrency, minDelayMs, maxDelayMs };
}

/**
 * Remove duplicates while preserving the first occurrence order.
 */
export function dedupeOrdered<T>(items: readonly T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const it of items) {
    if (seen.has(it)) continue;
    seen.add(it);
    out.push(it);
  }
  return out;
}
