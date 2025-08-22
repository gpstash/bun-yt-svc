import { describe, expect, test } from "bun:test";

// Helper to build a minimal Context<AppSchema>-like object for tests
function makeCtx(vars: Record<string, any> = {}) {
  const map = new Map<string, any>(Object.entries(vars));
  return {
    get: (k: string) => map.get(k),
  } as any; // Context<AppSchema> shape: we only need .get()
}

describe("batch.util", () => {
  test("processBatchIds maps successes and fetch errors (includeStatusOnError)", async () => {
    const { processBatchIds } = await import("./batch.util");

    const ids = ["a", "b", "c"];

    const ctx = makeCtx({
      config: {
        INNERTUBE_BATCH_CONCURRENCY: 2,
        INNERTUBE_BATCH_MIN_DELAY_MS: 1,
        INNERTUBE_BATCH_MAX_DELAY_MS: 2,
      },
      requestId: "rid-1",
      signal: new AbortController().signal,
    });

    const res = await processBatchIds<any>(ctx, ids, {
      extractEntityId: async (_c, id) => ({ ok: true, entityId: id }),
      fetchOne: async (entityId: string) => {
        if (entityId === "b") {
          return { __error: true, error: "bad", code: "BAD_REQUEST", __status: 400 } as any;
        }
        return { data: { id: entityId, ok: true } } as any;
      },
      includeStatusOnError: true,
      maxConcurrency: 3,
      minDelayFloorMs: 1,
    });

    // Successes for a and c
    expect((res["a"] as any).ok).toBe(true);
    expect((res["c"] as any).ok).toBe(true);
    // Error shape for b with __status present
    expect((res["b"] as any).error).toBe("bad");
    expect((res["b"] as any).code).toBe("BAD_REQUEST");
    expect((res["b"] as any).__status).toBe(400);
  });

  test("processBatchIds handles extraction failure and unexpected error", async () => {
    const { processBatchIds } = await import("./batch.util");

    const ids = ["badex", "boom"];

    const ctx = makeCtx({
      config: {
        INNERTUBE_BATCH_CONCURRENCY: 2,
        INNERTUBE_BATCH_MIN_DELAY_MS: 1,
        INNERTUBE_BATCH_MAX_DELAY_MS: 2,
      },
      requestId: "rid-2",
      signal: new AbortController().signal,
    });

    const res = await processBatchIds<any>(ctx, ids, {
      extractEntityId: async (_c, id) =>
        id === "badex"
          ? ({ ok: false, error: "no id", code: "BAD_REQUEST" } as any)
          : ({ ok: true, entityId: id } as any),
      fetchOne: async (entityId: string) => {
        if (entityId === "boom") {
          throw new Error("fail");
        }
        return { data: { id: entityId } } as any;
      },
      maxConcurrency: 3,
      minDelayFloorMs: 1,
    });

    // Extraction failure
    expect((res["badex"] as any).error).toBe("no id");
    expect((res["badex"] as any).code).toBe("BAD_REQUEST");
    // Unexpected error mapped to INTERNAL_ERROR with message
    expect((res["boom"] as any).code).toBe("INTERNAL_ERROR");
    expect((res["boom"] as any).error).toBe("fail");
  });

  test("extractFromNavigation resolves id from navigation maps", async () => {
    const { extractFromNavigation } = await import("./batch.util");

    const url = "https://www.youtube.com/watch?v=VID12345678";
    const ctx = makeCtx({
      batchUrlById: new Map<string, string | null>([["k1", url]]),
      navigationEndpointMap: new Map<string, any>([[url, { payload: { videoId: "VID12345678" } }]]),
    });

    const extractor = extractFromNavigation("videoId");
    const r = await extractor(ctx, "k1");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.entityId).toBe("VID12345678");
    }
  });

  test("extractFromNavigation fallback when no navigation map and allowed", async () => {
    const { extractFromNavigation } = await import("./batch.util");

    const ctx = makeCtx({}); // no navigationEndpointMap
    const extractor = extractFromNavigation("videoId", { allowFallbackRawIdWhenNoMap: true });
    const r = await extractor(ctx, "raw-id-1");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.entityId).toBe("raw-id-1");
    }
  });

  test("extractFromNavigation array payload fields supports playlist ids", async () => {
    const { extractFromNavigation } = await import("./batch.util");

    const url = "https://www.youtube.com/playlist?list=PLabcdef";
    const ctx = makeCtx({
      batchUrlById: new Map<string, string | null>([["k2", url]]),
      navigationEndpointMap: new Map<string, any>([[url, { payload: { listId: "PLabcdef" } }]]),
    });

    const extractor = extractFromNavigation(["playlistId", "listId"]);
    const r = await extractor(ctx, "k2");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.entityId).toBe("PLabcdef");
    }
  });
});
