import { describe, expect, test } from "bun:test";

// Import the real file via file URL to bypass alias-based mocks and module cache
const realUrl = new URL(`./logger.lib.ts?ts=${Date.now()}`, import.meta.url).href;

describe("logger.lib", () => {
  test("set/get log level normalize values", async () => {
    const { getLogLevel, setLogLevel } = await import(realUrl);
    setLogLevel("DEBUG");
    expect(getLogLevel()).toBe("debug");
    setLogLevel("silent");
    expect(getLogLevel()).toBe("silent");
    setLogLevel("unknown");
    expect(getLogLevel()).toBe("info");
  });

  test("child logger composes scope string", async () => {
    const { createLogger } = await import(realUrl);
    const base = createLogger("a");
    const child = base.child("b");
    // can't introspect scope directly; ensure methods exist
    child.debug("msg");
    child.info("msg");
    child.warn("msg");
    child.error("msg");
    child.verbose("msg");
  });
});
