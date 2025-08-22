import { redisAcquireLock, redisReleaseLock, redisWaitForKey } from '@/lib/redis.lib';
import { redisGetJson, redisSetJsonGzip } from '@/lib/redis.lib';
import { mapErrorToHttp, ERROR_CODES } from '@/lib/hono.util';

// Add small TTL jitter (±10%) to avoid synchronized expirations (stampedes)
export function jitterTtl(ttlSeconds: number): number {
  // Normalize and guard
  const base = Number(ttlSeconds);
  if (!isFinite(base) || base <= 0) return 1;
  const jitter = 0.1 * base;
  const delta = (Math.random() * 2 - 1) * jitter;
  return Math.max(1, Math.floor(base + delta));
}

// In-process singleflight: coalesce concurrent identical work.
// Use a global store to survive potential module duplication in certain runners (e.g., Docker + ESM).
const SINGLEFLIGHT_STORE = Symbol.for('bun-yt-svc:singleflight');
type InflightStore = Map<string, Promise<any>>;
const g = globalThis as any;
if (!g[SINGLEFLIGHT_STORE]) {
  g[SINGLEFLIGHT_STORE] = new Map<string, Promise<any>>();
}
const inflight: InflightStore = g[SINGLEFLIGHT_STORE] as InflightStore;
export async function singleflight<T>(key: string, doFetch: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;
  // Schedule doFetch on the next microtask so the inflight entry is visible
  // to any concurrent callers before doFetch actually runs.
  const p = Promise.resolve()
    .then(() => doFetch())
    .catch((e) => { throw e; })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p as Promise<T>;
}

// Distributed coordination using Redis lock + optional wait-for-cache fallback
export async function fetchWithRedisLock<T>(
  fetchKey: string,
  ttlSeconds: number,
  doFetch: () => Promise<T>,
  waitMs: number = 5000,
): Promise<T> {
  const lockKey = `${fetchKey}:_lock`;
  const token = await redisAcquireLock(lockKey, Math.max(10000, ttlSeconds * 1000)); // ms
  if (!token) {
    const waited = await redisWaitForKey<any>(fetchKey, waitMs, 100);
    if (waited) return waited as T;
    // Fall through without lock to avoid long stalls
    return await doFetch();
  }
  try {
    return await doFetch();
  } finally {
    try { await redisReleaseLock(lockKey, token); } catch { /* noop */ }
  }
}

// Negative cache helpers
export type NegativeCache = { __err: true; __status: number; error: string; code: string } & Record<string, any>;
export function isNegativeCache(obj: any): obj is NegativeCache {
  return !!obj && typeof obj === 'object' && obj.__err === true && typeof obj.__status === 'number';
}
export function makeNegativeCache(message: string, code: string, status: number): NegativeCache {
  return { __err: true, __status: status, error: message, code };
}

// Compute age in seconds from a Date-like value
export function ageSeconds(updatedAt: Date | string | number): number {
  const ms = new Date(updatedAt as any).getTime();
  return Math.max(0, Math.floor((Date.now() - ms) / 1000));
}

// Shared SWR flow abstraction
export type SwrResult<T> = { data: T } | { __error: true; error: string; code: string; __status: number };

export type SwrHandlers<T, DbT> = {
  cacheKey: string;
  ttlSeconds: number;
  serveStale?: boolean;
  // DB layer
  getFromDb: () => Promise<DbT | null>;
  dbUpdatedAt: (db: DbT) => Date | string;
  assembleFromDb: (db: DbT, remainingTtl: number) => Promise<T> | T;
  // Upstream fetch + persist layer (should persist to DB); returns the final payload to cache/serve
  fetchPersist: () => Promise<T>;
  // Optional negative-cache policy
  shouldNegativeCache?: (status: number, code: string) => boolean;
};

export async function swrResolve<T, DbT>(handlers: SwrHandlers<T, DbT>): Promise<SwrResult<T>> {
  const { cacheKey, ttlSeconds, serveStale = false, getFromDb, dbUpdatedAt, assembleFromDb, fetchPersist, shouldNegativeCache } = handlers;

  // 1) Cache first
  const cached = await redisGetJson<any>(cacheKey).catch(() => undefined);
  if (cached) {
    if (isNegativeCache(cached)) {
      return { __error: true, error: cached.error, code: cached.code, __status: (cached as any).__status ?? 400 };
    }
    return { data: cached as T };
  }

  // 2) DB next
  try {
    const dbRes = await getFromDb();
    if (dbRes) {
      const age = ageSeconds(dbUpdatedAt(dbRes));
      if (age < ttlSeconds) {
        const remaining = Math.max(1, ttlSeconds - age);
        const assembled = await assembleFromDb(dbRes, remaining);
        try { await redisSetJsonGzip(cacheKey, assembled, jitterTtl(remaining)); } catch { /* noop */ }
        return { data: assembled };
      }
      // Stale-while-revalidate
      if (serveStale) {
        const assembled = await assembleFromDb(dbRes, Math.max(1, Math.floor(ttlSeconds / 10)));
        void (async () => {
          try {
            await fetchWithRedisLock(cacheKey, ttlSeconds, async () => {
              const fresh = await fetchPersist();
              try { await redisSetJsonGzip(cacheKey, fresh, jitterTtl(ttlSeconds)); } catch { /* noop */ }
              return fresh;
            });
          } catch (e) {
            const mapped = mapErrorToHttp(e);
            const shouldNeg = shouldNegativeCache
              ? shouldNegativeCache(mapped.status, mapped.code)
              : (mapped.status >= 400 && mapped.status < 500 && mapped.code === ERROR_CODES.BAD_REQUEST);
            if (shouldNeg) {
              const neg = makeNegativeCache(mapped.message || 'Bad Request', mapped.code, mapped.status);
              try { await redisSetJsonGzip(cacheKey, neg, jitterTtl(60)); } catch { /* noop */ }
            }
          }
        })();
        return { data: assembled };
      }
    }
  } catch {
    // Non-fatal: proceed to fetch
  }

  // 3) Fetch -> persist -> cache with singleflight + distributed lock
  try {
    const info = await singleflight(cacheKey, async () => {
      return await fetchWithRedisLock(cacheKey, ttlSeconds, async () => {
        const r = await fetchPersist();
        try { await redisSetJsonGzip(cacheKey, r, jitterTtl(ttlSeconds)); } catch { /* noop */ }
        return r;
      });
    });
    return { data: info };
  } catch (e) {
    const mapped = mapErrorToHttp(e);
    const shouldNeg = shouldNegativeCache
      ? shouldNegativeCache(mapped.status, mapped.code)
      : (mapped.status >= 400 && mapped.status < 500 && mapped.code === ERROR_CODES.BAD_REQUEST);
    if (shouldNeg) {
      const neg = makeNegativeCache(mapped.message || 'Bad Request', mapped.code, mapped.status);
      try { await redisSetJsonGzip(cacheKey, neg, jitterTtl(60)); } catch { /* noop */ }
    }
    return { __error: true, error: mapped.message || 'Internal Server Error', code: mapped.code, __status: mapped.status };
  }
}
