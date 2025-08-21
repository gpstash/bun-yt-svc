import { describe, expect, test } from "bun:test";

// We'll import the real module but not assert console output; instead test level logic APIs
import { getLogLevel, setLogLevel, createLogger } from "@/lib/logger.lib";

describe("logger.lib", () => {
  test("set/get log level normalize values", () => {
    setLogLevel("DEBUG" as any);
    expect(getLogLevel()).toBe("debug");
    setLogLevel("silent");
    expect(getLogLevel()).toBe("silent");
    setLogLevel("unknown" as any);
    expect(getLogLevel()).toBe("info");
  });

  test("child logger composes scope string", () => {
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
