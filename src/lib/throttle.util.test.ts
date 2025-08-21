import { describe, expect, test, mock, afterAll } from "bun:test";
// Silence and provide debug
mock.module("@/lib/logger.lib", () => ({
  __esModule: true,
  createLogger: () => ({ debug() {}, info() {}, warn() {}, verbose() {}, error() {} }),
  getLogLevel: () => "info",
  setLogLevel: (_lvl: any) => {},
}));
// Import lazily inside tests to ensure mocks are applied first

describe("throttle.util throttleMap()", () => {
  test("runs with concurrency and random delays, returns in input order", async () => {
    const { throttleMap } = await import("@/lib/throttle.util");
    const items = Array.from({ length: 10 }, (_, i) => i);
    const started: number[] = [];
    const results = await throttleMap<number, number>(items, async (n: number) => {
      started.push(n);
      // simulate small work
      return n * 2;
    }, { concurrency: 3, minDelayMs: 1, maxDelayMs: 5, signal: null });

    expect(results).toEqual(items.map(n => n * 2));
    expect(started.length).toBe(items.length);
  });

  test("aborts when signal is aborted", async () => {
    const { throttleMap } = await import("@/lib/throttle.util");
    const items = [1,2,3];
    const controller = new AbortController();
    const p = throttleMap(items, async (_n) => 1, { concurrency: 1, minDelayMs: 1, maxDelayMs: 2, signal: controller.signal });
    controller.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("readBatchThrottle()", () => {
  test("reads and caps values", async () => {
    const { readBatchThrottle } = await import("@/lib/throttle.util");
    const opts = readBatchThrottle({ INNERTUBE_BATCH_CONCURRENCY: 10, INNERTUBE_BATCH_MIN_DELAY_MS: 1, INNERTUBE_BATCH_MAX_DELAY_MS: 3 }, { maxConcurrency: 2, minDelayFloorMs: 2 });
    expect(opts.concurrency).toBe(2);
    expect(opts.minDelayMs).toBe(2);
    expect(opts.maxDelayMs).toBeGreaterThanOrEqual(2);
  });
});

describe("dedupeOrdered()", () => {
  test("removes duplicates preserving order", async () => {
    const { dedupeOrdered } = await import("@/lib/throttle.util");
    const arr = [1,2,1,3,2,4];
    const out = dedupeOrdered(arr);
    expect(out).toEqual([1,2,3,4]);
  });
});

// Restore real logger to avoid leaking mocks
afterAll(() => {
  mock.module("@/lib/logger.lib", () => import("@/lib/logger.lib"));
});
