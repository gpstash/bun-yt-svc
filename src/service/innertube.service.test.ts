import { beforeEach, afterEach, afterAll, describe, expect, it, mock, jest, beforeAll as suiteBeforeAll } from "bun:test";

// Limit logger mock to this suite lifecycle to avoid leaking across files
suiteBeforeAll(() => {
  mock.module("@/lib/logger.lib", () => ({
    __esModule: true,
    createLogger: () => {
      const logger: any = {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        verbose: jest.fn(),
      };
      logger.child = (_c: string) => logger;
      return logger;
    },
    ...(() => { let level = "info" as any; return { getLogLevel: () => level, setLogLevel: (l: any) => { level = String(l).toLowerCase(); } }; })(),
  }));
  // Simple in-memory redis/cache stubs for playlist tests
  const mem = new Map<string, any>();
  mock.module("@/lib/redis.lib", () => ({
    __esModule: true,
    redisGetJson: async (key: string) => mem.get(key),
    redisSetJson: async (key: string, val: any, _ttl?: number) => { mem.set(key, val); },
  }));
  mock.module("@/lib/cache.util", () => ({
    __esModule: true,
    jitterTtl: (n: number) => n,
    singleflight: async (_key: string, fn: () => Promise<any>) => fn(),
    fetchWithRedisLock: async (_key: string, _ttl: number, fn: () => Promise<any>) => fn(),
  }));
});

describe("InnertubeService.getVideoInfoWithPoToken (integration-ish)", () => {
  it("applies WEB_EMBEDDED bypass and augments streaming/caption URLs with Po tokens", async () => {
    const svc = makeSvc();

    // Stub player-enabled innertube and Po token minting
    const webInn = createInnertubeInstance();
    jest.spyOn(InnertubeService as any, "createPlayerInnertubeSafe").mockResolvedValue(webInn as any);
    jest.spyOn(InnertubeService as any, "mintPoTokensSafe").mockResolvedValue({ contentPoToken: "CP", sessionPoToken: "SP" });

    // Arrange initial WEB fetch result as age-restricted trailer scenario
    const baseInfo: any = {
      playability_status: { status: "LOGIN_REQUIRED", reason: "Sign in to confirm your age", error_screen: { video_id: "realVid" } },
      has_trailer: true,
      getTrailerInfo: () => null,
      basic_info: { start_timestamp: null, duration: 111 },
      captions: { caption_tracks: [{ base_url: "https://timed/text?fmt=json3&xosf=1" }] },
      storyboards: {},
      streaming_data: undefined,
    };
    jest.spyOn(InnertubeService as any, "getWebOrMwebInfoWithRetries").mockResolvedValue({ info: baseInfo, clientName: "WEB" });

    // MWEB best-effort returns nothing so we depend on WEB_EMBEDDED
    jest.spyOn(InnertubeService as any, "getMwebInfoBestEffort").mockResolvedValue(undefined);

    // Mock bypass to mutate info in-place to a playable state
    jest.spyOn(InnertubeService as any, "tryWebEmbeddedBypassBestEffort").mockImplementation(async (_inn: any, info: any, _id: string, _po: string) => {
      info.playability_status = { status: "OK" };
      info.streaming_data = { dash_manifest_url: "https://dash/manifest.mpd" };
      info.basic_info.duration = 222;
      info.captions = { caption_tracks: [{ base_url: "https://timed/text?fmt=json3&xosf=1" }] };
      info.storyboards = { sb: true };
      return { updated: true, clientName: "WEB_EMBEDDED", hasTrailer: false, trailerIsAgeRestricted: false };
    });

    const out = await (svc as any).getVideoInfoWithPoToken("VID", false);

    // Playable now
    expect(out.playability_status.status).toBe("OK");
    // Streaming URL augmented with sessionPoToken and mpd_version
    expect(out.streaming_data.dash_manifest_url).toContain("/pot/SP/");
    expect(out.streaming_data.dash_manifest_url).toContain("/mpd_version/7");

    // Caption URLs augmented with contentPoToken and clientName propagated from bypass
    const u = new URL(out.captions.caption_tracks[0].base_url);
    expect(u.searchParams.get("pot")).toBe("CP");
    expect(u.searchParams.get("potc")).toBe("1");
    expect(u.searchParams.get("c")).toBe("WEB_EMBEDDED");
    expect(u.searchParams.get("fmt")).toBe("json3");
    expect(u.searchParams.get("xosf")).toBeNull();
  });
});

describe("InnertubeService.getChannelVideos", () => {
  function makeChannelWithPages(pages: Array<{ videos: Array<{ video_id: string; title?: { text?: string } }> }>, opts?: { failOnceWith?: Error }) {
    let idx = 0;
    const mkPage = (i: number): any => ({
      videos: pages[i]?.videos ?? [],
      has_continuation: i < pages.length - 1,
      async getContinuation() {
        if (opts?.failOnceWith) {
          const err = opts.failOnceWith;
          // Consume the failOnceWith so it only fails once
          (opts as any).failOnceWith = undefined;
          throw err;
        }
        idx = Math.min(idx + 1, pages.length - 1);
        return mkPage(idx);
      },
    });
    return {
      async getVideos() { return mkPage(0); },
    };
  }

  it("aggregates videos across continuations and de-duplicates by id", async () => {
    const inn = createInnertubeInstance();
    (inn as any).getChannel = async () => makeChannelWithPages([
      { videos: [ { video_id: 'v1', title: { text: 'A' } }, { video_id: 'v2', title: { text: 'B' } } ] },
      { videos: [ { video_id: 'v2', title: { text: 'B dup' } }, { video_id: 'v3', title: { text: 'C' } } ] },
    ]);

    const svc = makeSvc(inn);
    const out = await svc.getChannelVideos('CID', { minDelayMs: 0, maxDelayMs: 0 });

    expect(out.map(v => v.id)).toEqual(['v1', 'v2', 'v3']);
  });

  it("respects AbortSignal and stops paging", async () => {
    const inn = createInnertubeInstance();
    (inn as any).getChannel = async () => makeChannelWithPages([
      { videos: [ { video_id: 'v1' } ] },
      { videos: [ { video_id: 'v2' } ] },
    ]);

    const svc = makeSvc(inn);
    const controller = new AbortController();
    // Abort immediately to simulate client cancellation before continuation
    controller.abort(Object.assign(new Error('aborted'), { name: 'AbortError' }));

    await expect(svc.getChannelVideos('CID', { signal: controller.signal, minDelayMs: 0, maxDelayMs: 0 }))
      .rejects.toMatchObject({ name: 'AbortError' });
  });

  it("retries continuation on transient HttpError and then succeeds", async () => {
    const inn = createInnertubeInstance();
    const transient = new HttpLib.HttpError('rate limited', { url: 'https://youtubei', method: 'POST', attemptCount: 1, status: 429 });
    (inn as any).getChannel = async () => makeChannelWithPages([
      { videos: [ { video_id: 'v1' } ] },
      { videos: [ { video_id: 'v2' } ] },
    ], { failOnceWith: transient });

    const svc = makeSvc(inn);
    const out = await svc.getChannelVideos('CID', { minDelayMs: 0, maxDelayMs: 0 });

    // Despite first failure, it should retry and include v2 from second page
    expect(out.map(v => v.id)).toEqual(['v1', 'v2']);
  });
});

// Ensure we don't leak mocks to other test files
afterAll(() => {
  mock.module("@/lib/logger.lib", () => import("@/lib/logger.lib"));
});

// Spy on real http.lib export to ensure it affects pre-imported consumers too
import * as HttpLib from "@/lib/http.lib";
let http: any;

// Do not mock pot.lib globally; tests stub instance methods to avoid PoToken paths when needed

// Use real helper modules to avoid affecting other tests
import * as VideoHelper from "@/helper/video.helper";
import * as CaptionHelper from "@/helper/caption.helper";

// youtubei.js runtime surface mock
const createInnertubeInstance = () => ({
  // getInfo/getBasicInfo used in retries and PoToken path
  getInfo: async (_id: string, _opts?: any) => ({
    playability_status: { status: "OK" },
    has_trailer: false,
    getTrailerInfo: () => ({ basic_info: {}, playability_status: {}, streaming_data: {} }),
    basic_info: { start_timestamp: null, duration: 123 },
    captions: { caption_tracks: [{ base_url: "https://cc?fmt=json3" }] },
    storyboards: {},
    streaming_data: { dash_manifest_url: "https://dash/manifest.mpd" },
  }),
  getBasicInfo: async (_id: string, _opts?: any) => ({
    playability_status: { status: "OK" },
    streaming_data: { formats: [] },
    basic_info: { start_timestamp: null, duration: 123 },
    captions: { caption_tracks: [{ base_url: "https://cc?fmt=json3" }] },
  }),
  getChannel: async (_id: string) => ({ id: _id, metadata: {} }),
  session: {
    context: { client: { clientName: "WEB", visitorData: "vd" } },
    player: { sts: 123 },
  },
});

// After mocks are ready, import the class under test (relative path to bypass alias-based mocks in other tests)
import { InnertubeService } from "./innertube.service";

// Utility to build a service with a supplied Innertube double
const makeSvc = (inn?: any) => new InnertubeService((inn || createInnertubeInstance()) as any);

beforeEach(() => {
  jest.clearAllMocks();
  http = jest.spyOn(HttpLib, "http").mockImplementation(async (_url: any) => new Response("{\"ok\":true}", { status: 200, headers: { "content-type": "application/json" } }));
  // Reset InnertubeService static state to avoid interference from other tests in the suite
  const S = InnertubeService as any;
  try {
    S.instance = undefined;
    S.playerAssetCache?.clear?.();
    S.playerAssetInflight?.clear?.();
    S.playerInnertube = undefined;
    S.playerInit = undefined;
    // do not touch sharedCache intentionally; it's fine to be undefined
  } catch {}
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("InnertubeService.getVideoInfo", () => {
  it("parses video info and strips baseUrl from captionLanguages", async () => {
    const svc = makeSvc();
    // Spy to arrange parseVideoInfo to include baseUrl entries
    const spy = jest.spyOn(VideoHelper, "parseVideoInfo").mockImplementation((_i: any) => ({
      id: "vid",
      captionLanguages: [
        { languageCode: "en", baseUrl: "u1", isTranslatable: true },
        { languageCode: "id", baseUrl: "u2", isTranslatable: true },
      ],
      captionTranslationLanguages: [{ languageCode: "en" }],
    } as any));

    const out = await svc.getVideoInfo("abc");

    expect(spy).toHaveBeenCalledTimes(1);
    // Ensure baseUrl removed
    for (const c of out.captionLanguages) {
      expect("baseUrl" in c).toBeFalse();
    }
    spy.mockRestore();
  });
});

describe("InnertubeService.getCaption", () => {
  it("returns empty caption when hasCaptions() is false", async () => {
    const svc = makeSvc();
    // Avoid touching static internals by stubbing the instance method used
    jest.spyOn(svc as any, "getVideoInfoWithPoToken").mockResolvedValue({} as any);
    jest.spyOn(VideoHelper, "hasCaptions").mockImplementation(() => false);
    jest.spyOn(VideoHelper, "parseVideoInfo").mockImplementation(() => ({ id: "vid", captionLanguages: [], captionTranslationLanguages: [] } as any));

    const res = await svc.getCaption("abc", "en");

    expect(res.caption.hascaption).toBeFalse();
    expect(res.caption.segments).toEqual([]);
    expect(res.caption.text).toBe("");
  });

  it("fetches caption JSON3 and builds parsed info; adds tlang when translateLanguage provided", async () => {
    const svc = makeSvc();
    // Avoid static internals
    jest.spyOn(svc as any, "getVideoInfoWithPoToken").mockResolvedValue({} as any);
    jest.spyOn(VideoHelper, "hasCaptions").mockImplementation(() => true);
    jest.spyOn(VideoHelper, "parseVideoInfo").mockImplementation(() => ({
      id: "vid",
      captionLanguages: [
        { languageCode: "en", baseUrl: "https://timed/text?fmt=json3", isTranslatable: true },
      ],
      captionTranslationLanguages: [{ languageCode: "id" }],
    } as any));

    http.mockImplementation(async (url: any) => new Response("{\"text\":\"hi\"}", { status: 200 }));

    // We don't return actual JSON3 in the mock HTTP response; stub decoder to expected shape
    jest
      .spyOn(CaptionHelper, "decodeJson3Caption")
      .mockReturnValue({ language: "en", segments: [], words: [], text: "hi" });

    const res = await svc.getCaption("abc", "en", "id");

    expect(http).toHaveBeenCalledTimes(1);
    const calledUrl = (http.mock.calls[0][0]) as string | URL;
    const u = new URL(String(calledUrl));
    expect(u.searchParams.get("tlang")).toBe("id");
    expect(u.searchParams.get("fmt")).toBe("json3");

    expect(res.caption.language).toBe("en");
    expect(res.caption.text).toBe("hi");
  });
});

describe("InnertubeService.getTranscript", () => {
  it("parses transcript and includes segments", async () => {
    const inn = createInnertubeInstance();
    // getTranscript surface expected by service
    (inn as any).getInfo = async () => ({
      playability_status: { status: "OK" },
      has_trailer: false,
      getTrailerInfo: () => ({ basic_info: {}, playability_status: {}, streaming_data: {} }),
      basic_info: { start_timestamp: null, duration: 123 },
      captions: { caption_tracks: [{ base_url: "https://cc?fmt=json3" }] },
      storyboards: {},
      streaming_data: { dash_manifest_url: "https://dash/manifest.mpd" },
      // youtubei.js API: expose getTranscript()
      getTranscript: async () => ({
        languages: ["en", "id"],
        selectLanguage: async (_lang: string) => ({ /* selected */ }),
      }),
    });

    const svc = makeSvc(inn);
    // Avoid touching real getInfo retry logic by stubbing the instance method
    jest.spyOn(svc as any, "getVideoInfoRawWithRetries").mockResolvedValue({
      playability_status: { status: "OK" },
      has_trailer: false,
      getTrailerInfo: () => ({ basic_info: {}, playability_status: {}, streaming_data: {} }),
      basic_info: { start_timestamp: null, duration: 123 },
      captions: { caption_tracks: [{ base_url: "https://cc?fmt=json3" }] },
      storyboards: {},
      streaming_data: { dash_manifest_url: "https://dash/manifest.mpd" },
      getTranscript: async () => ({
        languages: ["en", "id"],
        selectLanguage: async (_lang: string) => ({ /* selected */ }),
      }),
    } as any);
    const spy = jest.spyOn(VideoHelper, "parseTranscript").mockImplementation((_pvi: any, _ti: any) => ({
      id: "vid",
      transcript: {
        language: "en",
        segments: [{ text: "hello", startMs: 0, endMs: 1000 }],
        text: "hello",
      },
    } as any));
    const out = await svc.getTranscript("abc", "en");

    expect(spy).toHaveBeenCalledTimes(1);
    expect(out.transcript.segments.length).toBe(1);
    expect(out.transcript.text).toBe("hello");
    spy.mockRestore();
  });
});

describe("InnertubeService.getChannel", () => {
  it("calls innertube.getChannel and returns parsed channel", async () => {
    const inn = createInnertubeInstance();
    (inn as any).getChannel = async (id: string) => ({
      getAbout: async () => ({ metadata: { description: "about desc", subscriber_count: "1", view_count: "2", joined_date: { text: "J" }, video_count: "3", country: "US" } }),
      metadata: {
        external_id: id,
        title: "Chan",
        url: `https://www.youtube.com/channel/${id}`,
        vanity_channel_url: "https://youtube.com/@chan",
        is_family_safe: true,
        keywords: ["k1"],
        avatar: { url: "a", width: 1, height: 1 },
        thumbnail: { url: "t", width: 1, height: 1 },
        tags: ["t1"],
        is_unlisted: false,
      },
    });

    const svc = await makeSvc(inn);
    const res = await svc.getChannel("CID");

    expect(res.id).toBe("CID");
    expect(res.title).toBe("Chan");
    expect(res.description).toBe("about desc");
  });
});

describe("InnertubeService.fetch (player asset cache)", () => {
  it("caches player asset GET responses in-memory", async () => {
    const url = "https://i.ytimg.com/s/player/abcdef/player_ias.vflset/en_US/base.js";
    http.mockImplementation(async () => new Response("console.log('p');", { status: 200, headers: { "content-type": "text/javascript" } }));

    const res1 = await InnertubeService.fetch(url);
    expect(http).toHaveBeenCalledTimes(1);
    const text1 = await res1.text();
    expect(text1).toContain("console.log");

    const res2 = await InnertubeService.fetch(url);
    // Should be served from cache; no extra http calls
    expect(http).toHaveBeenCalledTimes(1);
    const text2 = await res2.text();
    expect(text2).toContain("console.log");
  });
});

describe("InnertubeService helpers (playability and URL augmentation)", () => {
  it("needsAgeBypass returns true for age-confirm requirement", () => {
    const S: any = InnertubeService as any;
    const info: any = {
      playability_status: { status: "UNPLAYABLE", reason: "Sign in to confirm your age" },
      has_trailer: false,
      getTrailerInfo: () => ({})
    };
    expect(S.needsAgeBypass(info, info.has_trailer, false)).toBeTrue();
  });

  it("needsAgeBypass returns true when trailer is age restricted", () => {
    const S: any = InnertubeService as any;
    const info: any = {
      playability_status: { status: "LOGIN_REQUIRED", reason: "Sign in to confirm your age" },
      has_trailer: true,
      getTrailerInfo: () => null,
    };
    expect(S.needsAgeBypass(info, true, true)).toBeTrue();
  });

  it("isUnavailablePlayability detects common unavailable states", () => {
    const S: any = InnertubeService as any;
    expect(S.isUnavailablePlayability({ playability_status: { status: "OK" } })).toBeFalse();
    expect(S.isUnavailablePlayability({ playability_status: { status: "ERROR" } })).toBeTrue();
    expect(S.isUnavailablePlayability({ playability_status: { status: "UNPLAYABLE" } })).toBeTrue();
    expect(S.isUnavailablePlayability({ playability_status: { status: "LOGIN_REQUIRED" } })).toBeTrue();
    expect(S.isUnavailablePlayability({ playability_status: { status: "OK", reason: "Temporarily unavailable" } })).toBeTrue();
    expect(S.isUnavailablePlayability({ playability_status: { status: "OK", embeddable: false } })).toBeTrue();
  });

  it("augmentCaptionsWithPot adds pot/potc/c/fmt and removes xosf", () => {
    const S: any = InnertubeService as any;
    const info: any = {
      captions: {
        caption_tracks: [
          { base_url: "https://timed/text?fmt=json3&xosf=1" },
          { base_url: "https://timed/text2?fmt=json3" },
        ],
      },
    };
    S.augmentCaptionsWithPot(info, "CONTENT_POT", "WEB");
    for (const track of info.captions.caption_tracks) {
      const u = new URL(track.base_url);
      expect(u.searchParams.get("potc")).toBe("1");
      expect(u.searchParams.get("pot")).toBe("CONTENT_POT");
      expect(u.searchParams.get("c")).toBe("WEB");
      expect(u.searchParams.get("fmt")).toBe("json3");
      expect(u.searchParams.get("xosf")).toBeNull();
    }
  });

  it("augmentStreamingDataWithSessionPot appends pot for MPD URLs with and without query", () => {
    const S: any = InnertubeService as any;
    const infoWithQuery: any = { streaming_data: { dash_manifest_url: "https://dash/manifest.mpd?foo=bar" } };
    const infoNoQuery: any = { streaming_data: { dash_manifest_url: "https://dash/manifest.mpd" } };

    S.augmentStreamingDataWithSessionPot(infoWithQuery, "SESSION_POT");
    const u1 = new URL(infoWithQuery.streaming_data.dash_manifest_url);
    expect(u1.searchParams.get("pot")).toBe("SESSION_POT");
    expect(u1.searchParams.get("mpd_version")).toBe("7");

    S.augmentStreamingDataWithSessionPot(infoNoQuery, "SESSION_POT");
    expect(infoNoQuery.streaming_data.dash_manifest_url).toContain("/pot/SESSION_POT/");
    expect(infoNoQuery.streaming_data.dash_manifest_url).toContain("/mpd_version/7");
  });
});

describe("InnertubeService.tryWebEmbeddedBypassBestEffort", () => {
  it("merges WEB_EMBEDDED info when bypass succeeds and returns updated=true", async () => {
    const S: any = InnertubeService as any;
    // Arrange base innertube (web) and info indicating trailer is age-restricted
    const webInn = createInnertubeInstance();
    const info: any = {
      playability_status: { status: "LOGIN_REQUIRED", reason: "Sign in to confirm your age", error_screen: { video_id: "realVid" } },
      has_trailer: true,
      getTrailerInfo: () => null,
      basic_info: { start_timestamp: 999, duration: 111 },
      captions: undefined,
      storyboards: undefined,
      streaming_data: undefined,
    };

    // Mock createInnertube to return a WEB_EMBEDDED double
    const embedded = {
      getBasicInfo: async (vid: string, opts: any) => ({
        playability_status: { status: "OK" },
        streaming_data: { formats: [1] },
        basic_info: { start_timestamp: 0, duration: 222 },
        captions: { caption_tracks: [{ base_url: "https://cc?fmt=json3" }] },
        storyboards: { sb: true },
      }),
      session: { context: { client: { clientName: "WEB_EMBEDDED" } }, player: (webInn as any).session.player },
    } as any;
    const spyCreate = jest.spyOn(InnertubeService as any, "createInnertube").mockResolvedValue(embedded);

    const res = await S.tryWebEmbeddedBypassBestEffort(webInn as any, info, "originalId", "POTOKEN");

    expect(res.updated).toBeTrue();
    expect(res.clientName).toBe("WEB_EMBEDDED");
    expect(res.hasTrailer).toBeFalse();
    expect(res.trailerIsAgeRestricted).toBeFalse();
    expect(info.playability_status.status).toBe("OK");
    expect(info.streaming_data.formats.length).toBe(1);
    expect(info.basic_info.duration).toBe(222);
    expect(info.captions).toBeDefined();
    expect(info.storyboards).toBeDefined();

    spyCreate.mockRestore();
  });

  it("returns updated=false on failure and preserves trailer flags", async () => {
    const S: any = InnertubeService as any;
    const webInn = createInnertubeInstance();
    const info: any = {
      playability_status: { status: "LOGIN_REQUIRED", reason: "Sign in to confirm your age" },
      has_trailer: true,
      getTrailerInfo: () => null,
      basic_info: { start_timestamp: null, duration: 111 },
    };

    const embedded = {
      getBasicInfo: async () => { throw new Error("fail"); },
      session: { context: { client: { clientName: "WEB_EMBEDDED" } }, player: (webInn as any).session.player },
    } as any;
    const spyCreate = jest.spyOn(InnertubeService as any, "createInnertube").mockResolvedValue(embedded);

    const res = await S.tryWebEmbeddedBypassBestEffort(webInn as any, info, "id", "POTOKEN");

    expect(res.updated).toBeFalse();
    expect(res.hasTrailer).toBeTrue();
    expect(res.trailerIsAgeRestricted).toBeTrue();

    spyCreate.mockRestore();
  });
});
