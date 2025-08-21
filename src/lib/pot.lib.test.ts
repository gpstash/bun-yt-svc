import { describe, expect, test, mock, afterEach, afterAll, jest } from "bun:test";

// Silence logger
mock.module("@/lib/logger.lib", () => ({
  __esModule: true,
  createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
  getLogLevel: () => "info",
  setLogLevel: (_lvl: any) => {},
}));

// Mock jsdom to provide window/document
mock.module("jsdom", () => ({
  __esModule: true,
  JSDOM: class {
    window: any;
    constructor(_html: string, _opts: any) {
      this.window = {
        document: {},
        location: { href: "https://www.youtube.com/" },
        origin: "https://www.youtube.com",
        navigator: { userAgent: "ua" },
      };
    }
  }
}));

// Mock bgutils-js
mock.module("bgutils-js", () => ({
  __esModule: true,
  USER_AGENT: "ua",
  GOOG_API_KEY: "key",
  buildURL: (name: string, _bool: boolean) => `https://example.com/${name}`,
  BG: {
    BotGuardClient: {
      create: async (_args: any) => ({ snapshot: async (_opts: any) => ({ token: "botguard-token" }) }),
    },
    WebPoMinter: {
      create: async (_args: any, _out: any) => ({ mintAsWebsafeString: async (v: string) => `tok:${v}` }),
    },
    PoToken: { generateColdStartToken: (_v: string) => "cold" },
  },
}));

// Note: Avoid alias-wide mock of InnertubeService to prevent leaking to other test files

// Mock http.lib to serve interpreter js and GenerateIT response
mock.module("@/lib/http.lib", () => ({
  __esModule: true,
  http: async (url: string, _init?: any, _opts?: any) => {
    if (String(url).includes("interp.js")) return new Response("console.log('interp')", { status: 200 });
    if (String(url).includes("GenerateIT")) return new Response(JSON.stringify(["integrityToken123"]), { status: 200, headers: { "content-type": "application/json" } });
    return new Response("ok");
  }
}));

describe("generatePoToken()", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  // Restore real modules to avoid leaking to other tests
  afterAll(() => {
    mock.module("@/lib/logger.lib", () => import("@/lib/logger.lib"));
    mock.module("jsdom", () => import("jsdom"));
    mock.module("bgutils-js", () => import("bgutils-js"));
    mock.module("@/lib/http.lib", () => import("@/lib/http.lib"));
  });

  test("returns content and session tokens after mocked flow", async () => {
    const SvcMod = await import("@/service/innertube.service");
    jest.spyOn(SvcMod.InnertubeService, "createInnertube").mockResolvedValue({
      getAttestationChallenge: async (_t: string) => ({
        bg_challenge: {
          program: "prog",
          global_name: "gn",
          interpreter_url: { private_do_not_access_or_else_trusted_resource_url_wrapped_value: "//interp.js" },
        }
      })
    } as any);
    const { generatePoToken } = await import("@/lib/pot.lib");
    const res = await generatePoToken("vid", "visitor");
    expect(res.contentPoToken).toBe("tok:vid");
    expect(res.sessionPoToken).toBe("tok:visitor");
  });

  test("propagates error when challenge missing", async () => {
    // Override InnertubeService to return no bg_challenge
    const SvcMod = await import("@/service/innertube.service");
    jest.spyOn(SvcMod.InnertubeService, "createInnertube").mockResolvedValue({
      getAttestationChallenge: async () => ({})
    } as any);
    const { generatePoToken } = await import("@/lib/pot.lib");
    await expect(generatePoToken("vid", "visitor")).rejects.toThrow(/Could not get challenge/);
  });
});
