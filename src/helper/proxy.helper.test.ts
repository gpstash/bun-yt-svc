import { describe, expect, test, mock, afterAll } from "bun:test";

// Mock logger to avoid console noise
mock.module("@/lib/logger.lib", () => ({ __esModule: true, createLogger: () => ({ debug() {}, info() {}, warn() {} }) }));

describe("buildProxyUrlFromConfig()", () => {
  test("returns undefined when PROXY_STATUS is inactive", async () => {
    mock.module("@/config", () => ({ __esModule: true, parseConfig: () => ({ PROXY_STATUS: "inactive" }) }));
    const { buildProxyUrlFromConfig } = await import("./proxy.helper");
    expect(buildProxyUrlFromConfig()).toBeUndefined();
  });

  test("builds URL without auth when active and no credentials", async () => {
    mock.module("@/config", () => ({ __esModule: true, parseConfig: () => ({ PROXY_STATUS: "active", PROXY_HOST: "127.0.0.1", PROXY_PORT: "8080", PROXY_USERNAME: "", PROXY_PASSWORD: "" }) }));
    const { buildProxyUrlFromConfig } = await import("./proxy.helper");
    expect(buildProxyUrlFromConfig()).toBe("http://127.0.0.1:8080");
  });

  test("builds URL with auth when credentials provided", async () => {
    mock.module("@/config", () => ({ __esModule: true, parseConfig: () => ({ PROXY_STATUS: "active", PROXY_HOST: "h", PROXY_PORT: "1", PROXY_USERNAME: "u s", PROXY_PASSWORD: "p@ss" }) }));
    const { buildProxyUrlFromConfig } = await import("./proxy.helper");
    expect(buildProxyUrlFromConfig()).toBe("http://u%20s:p%40ss@h:1");
  });

  test("returns undefined on thrown error", async () => {
    mock.module("@/config", () => ({ __esModule: true, parseConfig: () => { throw new Error("boom"); } }));
    const { buildProxyUrlFromConfig } = await import("./proxy.helper");
    expect(buildProxyUrlFromConfig()).toBeUndefined();
  });

  // Restore real modules to avoid leaking mocks to other test files
  afterAll(() => {
    mock.module("@/lib/logger.lib", () => import("@/lib/logger.lib"));
    mock.module("@/config", () => import("@/config"));
  });
});
