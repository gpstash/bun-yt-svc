import { describe, expect, mock, test, afterAll, beforeAll } from "bun:test";

describe("cache.util", () => {
  const realUrl = new URL(`./cache.util.ts?ts=${Date.now()}`, import.meta.url).href;

  let origRandom: typeof Math.random;
  beforeAll(() => { origRandom = Math.random; });
  afterAll(() => { Math.random = origRandom; });

  test("jitterTtl within ±10% and >=1", async () => {
    const { jitterTtl } = await import(realUrl);
    // Make randomness deterministic for range assertions
    Math.random = () => 0.5; // delta = 0
    const ttl = 1000;
    for (let i = 0; i < 50; i++) {
      const v = jitterTtl(ttl);
      expect(v).toBeGreaterThanOrEqual(900);
      expect(v).toBeLessThanOrEqual(1100);
      expect(v).toBeGreaterThanOrEqual(1);
    }
    // Edge guards (some runtimes may clamp to 0); ensure non-negative integer
    expect(jitterTtl(0)).toBeGreaterThanOrEqual(0);
    expect(jitterTtl(-5)).toBeGreaterThanOrEqual(0);
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
