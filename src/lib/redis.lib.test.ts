import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { __setRedisFactory, getRedis, redisGetJson, redisSetJson, redisAcquireLock, redisReleaseLock, redisWaitForKey } from "@/lib/redis.lib";

class FakeRedis {
  public status: "ready" | "end" | "connecting" = "end";
  private store = new Map<string, Buffer>();

  async connect() {
    this.status = "ready";
  }

  // Minimal signatures used in our lib
  async getBuffer(key: string): Promise<Buffer | null> {
    return this.store.has(key) ? Buffer.from(this.store.get(key)!) : null;
  }

  async set(key: string, value: any, mode?: string, ttl?: number, nx?: string): Promise<string | null> {
    // Handle NX semantics for lock acquisition
    if (nx === "NX") {
      if (this.store.has(key)) return null;
    }
    const buf = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(String(value), "utf8");
    this.store.set(key, buf);
    // Ignore TTL in fake
    return "OK";
  }

  async eval(_lua: string, _numKeys: number, key: string, token: string): Promise<number> {
    const cur = this.store.get(key);
    if (!cur) return 0;
    const curStr = cur.toString("utf8");
    if (curStr === token) {
      this.store.delete(key);
      return 1;
    }
    return 0;
  }

  on() { /* noop */ }
}

const bigObject = { x: "x".repeat(9000) }; // >8KB when stringified

describe.skip("redis.lib", () => {
  beforeEach(() => {
    __setRedisFactory(() => new FakeRedis() as any);
  });
  afterEach(() => {
    __setRedisFactory(undefined);
  });

  test("getRedis uses injected factory", () => {
    const r = getRedis();
    expect(r).toBeTruthy();
  });

  test("redisSetJson / redisGetJson small payload (no compression)", async () => {
    const key = "k:small";
    const val = { a: 1, b: "two" };
    await redisSetJson(key, val, 60);
    const out = await redisGetJson<typeof val>(key);
    expect(out).toEqual(val);
  });

  test("redisSetJson / redisGetJson compressed payload (>8KB)", async () => {
    const key = "k:big";
    await redisSetJson(key, bigObject, 60);
    // Ensure it's retrievable and equal
    const out = await redisGetJson<typeof bigObject>(key);
    expect(out?.x.length).toBe(bigObject.x.length);
  });

  test("redisAcquireLock / redisReleaseLock flow", async () => {
    const token = await redisAcquireLock("lock:1", 1000);
    expect(typeof token === "string" || token === null).toBe(true);
    if (!token) throw new Error("expected a token");
    // Second acquire should fail due to NX
    const token2 = await redisAcquireLock("lock:1", 1000);
    expect(token2).toBeNull();
    const ok = await redisReleaseLock("lock:1", token);
    expect(ok).toBe(true);
  });

  test("redisWaitForKey polls until value exists", async () => {
    const key = "k:wait";
    // Start polling first
    const p = redisWaitForKey<{ v: number }>(key, 200, 20);
    // Set after a short delay
    setTimeout(async () => {
      await redisSetJson(key, { v: 42 }, 60);
    }, 50);
    const out = await p;
    expect(out).toEqual({ v: 42 });
  });

  test("when no redis provided by factory, functions return safe fallbacks", async () => {
    __setRedisFactory(() => undefined);
    const none = await redisGetJson("nope");
    const token = await redisAcquireLock("lk", 10);
    const rel = await redisReleaseLock("lk", "t");
    const waited = await redisWaitForKey("lk", 10, 5);
    expect(none).toBeNull();
    expect(token).toBeNull();
    expect(rel).toBe(false);
    expect(waited).toBeNull();
  });
});
