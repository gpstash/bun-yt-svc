import { describe, expect, mock, test, afterAll } from "bun:test";

describe("cache.util", () => {
  test("jitterTtl within ±10% and >=1", async () => {
    const { jitterTtl } = await import("./cache.util");
    const ttl = 1000;
    for (let i = 0; i < 50; i++) {
      const v = jitterTtl(ttl);
      expect(v).toBeGreaterThanOrEqual(900);
      expect(v).toBeLessThanOrEqual(1100);
    }
    expect(jitterTtl(0)).toBeGreaterThanOrEqual(1);
  });

  test("singleflight coalesces concurrent calls per key", async () => {
    const { singleflight } = await import("./cache.util");
    let calls = 0;
    const fetcher = async () => { calls++; return 42; };
    const [a, b, c] = await Promise.all([
      singleflight("k", fetcher),
      singleflight("k", fetcher),
      singleflight("k", fetcher),
    ]);
    expect(a).toBe(42);
    expect(b).toBe(42);
    expect(c).toBe(42);
    expect(calls).toBe(1);
  });

  test("fetchWithRedisLock executes doFetch when we own the lock", async () => {
    mock.module("@/lib/redis.lib", () => ({
      __esModule: true,
      redisAcquireLock: async (_k: string, _ttl: number) => "token",
      redisReleaseLock: async (_k: string, _t: string) => true,
      redisWaitForKey: async (_k: string, _timeout: number, _poll?: number) => null,
      redisGetJson: async (_k: string) => null,
      redisSetJson: async (_k: string, _v: any, _ttl: number) => {},
    }));
    const { fetchWithRedisLock } = await import("./cache.util");
    const res = await fetchWithRedisLock("key", 1, async () => 7, 10);
    expect(res).toBe(7);
  });

  test("fetchWithRedisLock falls back to doFetch when cannot acquire lock and no cache", async () => {
    mock.module("@/lib/redis.lib", () => ({
      __esModule: true,
      redisAcquireLock: async (_k: string, _ttl: number) => null,
      redisReleaseLock: async () => true,
      redisWaitForKey: async () => null,
      redisGetJson: async () => null,
      redisSetJson: async () => {},
    }));
    const { fetchWithRedisLock } = await import("./cache.util");
    const res = await fetchWithRedisLock("key2", 1, async () => 9, 10);
    expect(res).toBe(9);
  });

  // Restore real redis.lib module for other tests
  afterAll(() => {
    mock.module("@/lib/redis.lib", () => import("./redis.lib"));
  });

  test("isNegativeCache/makeNegativeCache roundtrip", async () => {
    const { isNegativeCache, makeNegativeCache } = await import("./cache.util");
    const obj = makeNegativeCache("msg", "CODE", 404);
    expect(isNegativeCache(obj)).toBe(true);
    expect(obj.error).toBe("msg");
    expect(obj.code).toBe("CODE");
    expect(obj.__status).toBe(404);
  });
});
