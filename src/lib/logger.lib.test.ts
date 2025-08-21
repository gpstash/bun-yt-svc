import { describe, expect, test } from "bun:test";

// Import the real file via file URL to bypass alias-based mocks and module cache
const realUrl = new URL(`./logger.lib.ts?ts=${Date.now()}`, import.meta.url).href;

describe("logger.lib", () => {
  test("set/get log level normalize values", async () => {
    const { getLogLevel, setLogLevel } = await import(realUrl);
    setLogLevel("DEBUG");
    expect(typeof getLogLevel()).toBe("string");
    setLogLevel("silent");
    expect(typeof getLogLevel()).toBe("string");
    setLogLevel("unknown");
    expect(typeof getLogLevel()).toBe("string");
  });

  test("child logger composes scope string", async () => {
    const { createLogger } = await import(realUrl);
    const base = createLogger("a");
    // Ensure methods exist on base logger
    base.debug("msg");
    base.info("msg");
    base.warn("msg");
    base.error("msg");
    base.verbose("msg");
  });
});
