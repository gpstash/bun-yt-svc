import { beforeEach, afterEach, describe, expect, it, mock, jest } from "bun:test";

// Mocks must be registered before importing the module under test
mock.module("@/lib/logger.lib", () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    verbose: jest.fn(),
  }),
}));

// Spy on real http.lib export to ensure it affects pre-imported consumers too
import * as HttpLib from "@/lib/http.lib";
let http: any;

// Stub PoToken generator to avoid heavy jsdom/youtube calls during unit tests
const generatePoToken = jest.fn(async () => ({ contentPoToken: "c", sessionPoToken: "s" }));
mock.module("@/lib/pot.lib", () => ({ generatePoToken }));

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
