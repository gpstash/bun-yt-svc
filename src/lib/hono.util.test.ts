import { describe, expect, test } from "bun:test";
import { isClientAbort, mapErrorToHttp, ERROR_CODES, STATUS_CLIENT_CLOSED_REQUEST } from "@/lib/hono.util";
import { HttpError } from "@/lib/http.lib";

describe("isClientAbort()", () => {
  test("detects HttpError EABORT", () => {
    const err = new HttpError("aborted", { url: "http://x", attemptCount: 1, code: "EABORT" });
    expect(isClientAbort(err)).toBe(true);
  });
  test("detects DOMException/AbortError by name", () => {
    const e1 = Object.assign(new Error("x"), { name: "AbortError" });
    const e2 = Object.assign(new Error("x"), { name: "DOMException" });
    expect(isClientAbort(e1)).toBe(true);
    expect(isClientAbort(e2)).toBe(true);
    expect(STATUS_CLIENT_CLOSED_REQUEST).toBe(499);
  });
});

describe("mapErrorToHttp()", () => {
  test("maps HttpError timeout and upstream statuses", () => {
    const t = new HttpError("timeout", { url: "http://x", attemptCount: 2, code: "ETIMEDOUT" });
    expect(mapErrorToHttp(t)).toEqual({ status: 504, code: ERROR_CODES.UPSTREAM_TIMEOUT, message: expect.any(String) });

    const r429 = new HttpError("429", { url: "u", attemptCount: 1, status: 429 });
    expect(mapErrorToHttp(r429).status).toBe(429);

    const r503 = new HttpError("503", { url: "u", attemptCount: 1, status: 503 });
    expect(mapErrorToHttp(r503).code).toBe(ERROR_CODES.UPSTREAM_UNAVAILABLE);

    const r500 = new HttpError("500", { url: "u", attemptCount: 1, status: 500 });
    expect(mapErrorToHttp(r500).code).toBe(ERROR_CODES.UPSTREAM_BAD_GATEWAY);
  });

  test("maps generic AbortError", () => {
    const e = Object.assign(new Error("x"), { name: "AbortError" });
    const m = mapErrorToHttp(e);
    expect(m.code).toBe(ERROR_CODES.UPSTREAM_ABORTED);
  });

  test("youtube-like error messages map to codes", () => {
    const e1 = new Error("Login required");
    const m1 = mapErrorToHttp(e1);
    expect([ERROR_CODES.YT_LOGIN_REQUIRED, ERROR_CODES.INTERNAL_ERROR]).toContain(m1.code);

    const e2 = new Error("video is private");
    const m2 = mapErrorToHttp(e2);
    expect([ERROR_CODES.YT_PRIVATE, ERROR_CODES.INTERNAL_ERROR]).toContain(m2.code);
  });
});
