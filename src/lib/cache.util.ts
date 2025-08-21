import { redisAcquireLock, redisReleaseLock, redisWaitForKey } from '@/lib/redis.lib';

// Add small TTL jitter (±10%) to avoid synchronized expirations (stampedes)
export function jitterTtl(ttlSeconds: number): number {
  // Normalize and guard
  const base = Number(ttlSeconds);
  if (!isFinite(base) || base <= 0) return 1;
  const jitter = 0.1 * base;
  const delta = (Math.random() * 2 - 1) * jitter;
  return Math.max(1, Math.floor(base + delta));
}

// In-process singleflight: coalesce concurrent identical work in the same instance
const inflight = new Map<string, Promise<any>>();
export async function singleflight<T>(key: string, doFetch: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;
  const p = doFetch()
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
