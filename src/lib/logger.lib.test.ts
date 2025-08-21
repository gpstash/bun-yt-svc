import { describe, expect, test, beforeAll } from "bun:test";

// We'll import the real module but not assert console output; instead test level logic APIs
// Force the real module in case previous tests leaked a mock
beforeAll(() => {
  // Reset any prior mock of the logger module to the real implementation
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { mock } = require("bun:test");
  mock.module("@/lib/logger.lib", () => import("@/lib/logger.lib"));
});

describe("logger.lib", () => {
  test("set/get log level normalize values", () => {
    const { getLogLevel, setLogLevel } = require("@/lib/logger.lib");
    setLogLevel("DEBUG");
    expect(getLogLevel()).toBe("debug");
    setLogLevel("silent");
    expect(getLogLevel()).toBe("silent");
    setLogLevel("unknown");
    expect(getLogLevel()).toBe("info");
  });

  test("child logger composes scope string", () => {
    const { createLogger } = require("@/lib/logger.lib");
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
