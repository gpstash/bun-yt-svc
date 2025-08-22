import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { http, httpJson, HttpError, __setFetch } from "@/lib/http.lib";

// Use injection hook instead of overriding global fetch

type RespInit = { status?: number; headers?: HeadersInit };
function createResponse(body: string, init: RespInit = {}) {
  const status = init.status ?? 200;
  const headersObj = new Headers(init.headers ?? {});
  return new Response(body, { status, headers: headersObj });
}

function setFetch(fn: (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  __setFetch(fn as unknown as typeof fetch);
}

describe.skip("http()", () => {
  beforeEach(() => {
    __setFetch(undefined);
  });
  afterEach(() => {
    __setFetch(undefined);
  });

  test("returns OK response on first try", async () => {
    let calls = 0;
    setFetch(async () => {
      calls++;
      return createResponse("ok", { status: 200 });
    });
    const res = await http("http://x.test/");
    expect(res.ok).toBe(true);
    expect(calls).toBe(1);
  });

  test("retries on 429 honoring Retry-After and then succeeds", async () => {
    const sequence = [
      createResponse("too many", { status: 429, headers: { "retry-after": "0" } }),
      createResponse("ok", { status: 200 }),
    ];
    let idx = 0;
    let onRetryDelay: number | undefined;
    setFetch(async () => sequence[idx++]);

    const res = await http("http://x/", undefined, {
      maxAttempts: 2,
      onRetry: ({ delayMs }) => { onRetryDelay = delayMs; },
    });
    expect(res.status).toBe(200);
    expect(onRetryDelay).toBeDefined();
  });

  test("times out per-attempt and throws HttpError with ETIMEDOUT code when not retrying further", async () => {
    setFetch(async (_url, init) => {
      // pending until aborted; then reject with AbortError so http() can handle it
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(Object.assign(new Error("timeout"), { name: "AbortError" })),
          { once: true },
        );
      });
    });

    await expect(async () => {
      await http("http://slow/", undefined, { maxAttempts: 1, timeoutMs: 10 });
    }).toThrowError(HttpError);

    try {
      await http("http://slow/", undefined, { maxAttempts: 1, timeoutMs: 10 });
    } catch (e) {
      const err = e as HttpError;
      expect(err).toBeInstanceOf(HttpError);
      expect(err.code).toBe("ETIMEDOUT");
      expect(err.attemptCount).toBe(1);
    }
  });

  test("external abort is treated as EABORT when not retrying", async () => {
    // Simulate fetch rejecting immediately with AbortError (external cancel)
    setFetch(async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); });

    await expect(async () => {
      await http("http://abort/", undefined, { maxAttempts: 1 });
    }).toThrowError(HttpError);
    try {
      await http("http://abort/", undefined, { maxAttempts: 1 });
    } catch (e) {
      const err = e as HttpError;
      expect(err.code).toBe("EABORT");
    }
  });

  test("custom shouldRetry=false prevents default retry", async () => {
    let calls = 0;
    setFetch(async () => {
      calls++;
      return createResponse("nope", { status: 503 });
    });
    const res = await http("http://x/", undefined, {
      maxAttempts: 3,
      shouldRetry: () => false,
    });
    expect(res.status).toBe(503);
    expect(calls).toBe(1);
  });
});

describe.skip("httpJson()", () => {
  test("parses JSON when content-type present", async () => {
    setFetch(async () => createResponse(JSON.stringify({ a: 1 }), { status: 200, headers: { "content-type": "application/json" } }));
    const { data, response } = await httpJson<{ a: number }>("http://json/");
    expect(response.ok).toBe(true);
    expect(data.a).toBe(1);
  });

  test("throws HttpError with EJSONPARSE on invalid JSON", async () => {
    setFetch(async () => createResponse("not-json", { status: 200, headers: { "content-type": "application/json" } }));
    await expect(async () => {
      await httpJson("http://json-bad/");
    }).toThrowError(HttpError);

    try {
      await httpJson("http://json-bad/");
    } catch (e) {
      const err = e as HttpError;
      expect(err.code).toBe("EJSONPARSE");
      expect(err.status).toBe(200);
    }
  });
});
