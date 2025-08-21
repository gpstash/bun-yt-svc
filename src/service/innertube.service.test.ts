import { beforeEach, describe, expect, it, mock, jest } from "bun:test";

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

// Minimal http mock that returns a Response
const http = jest.fn(async (_url: any, _init?: any) => new Response("{\"ok\":true}", { status: 200, headers: { "content-type": "application/json" } }));
mock.module("@/lib/http.lib", () => ({ http }));

// Stub PoToken generator to avoid heavy jsdom/youtube calls during unit tests
const generatePoToken = jest.fn(async () => ({ contentPoToken: "c", sessionPoToken: "s" }));
mock.module("@/lib/pot.lib", () => ({ generatePoToken }));

// Helper mocks
const parseVideoInfo = jest.fn((_info: any) => ({
  id: "vid",
  captionLanguages: [
    { languageCode: "en", baseUrl: "https://example/c?fmt=json3", isTranslatable: true },
    { languageCode: "id", baseUrl: "https://example/c2?fmt=json3", isTranslatable: true },
  ],
  captionTranslationLanguages: [
    { languageCode: "en" },
    { languageCode: "id" },
  ],
}));
const hasCaptions = jest.fn((_info: any) => true);
const parseTranscript = jest.fn((_parsedVideoInfo: any, _transcriptInfo: any) => ({
  id: "vid",
  transcript: {
    language: "en",
    segments: [{ text: "hello", startMs: 0, endMs: 1000 }],
    text: "hello",
  },
}));
const finCaptionByLanguageCode = jest.fn((caps: any[], lang?: string) => {
  const target = (lang || "en").toLowerCase();
  return caps.find(c => c.languageCode?.toLowerCase() === target) || caps[0];
});
const buildParsedVideoInfoWithCaption = jest.fn((base: any, decoded: any, lang: string) => ({
  ...base,
  caption: {
    hascaption: true,
    language: lang,
    segments: decoded?.segments || [],
    words: decoded?.words || [],
    text: decoded?.text || "",
  },
}));
mock.module("@/helper/video.helper", () => ({
  parseVideoInfo,
  ParsedVideoInfo: {} as any,
  hasCaptions,
  parseTranscript,
  ParsedVideoInfoWithTranscript: {} as any,
  finCaptionByLanguageCode,
  ParsedVideoInfoWithCaption: {} as any,
}));

const decodeJson3Caption = jest.fn((_text: string) => ({
  segments: [{ tStartMs: 0, dDurationMs: 500, utf8: "hi" }],
  words: [{ text: "hi", startMs: 0, endMs: 500 }],
  text: "hi",
}));
mock.module("@/helper/caption.helper", () => ({
  decodeJson3Caption,
  buildParsedVideoInfoWithCaption,
}));

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
mock.module("youtubei.js", () => ({
  Innertube: { create: jest.fn(async (_cfg: any) => createInnertubeInstance()) },
  ClientType: { WEB_EMBEDDED: "WEB_EMBEDDED" },
  Log: { setLevel: (_: any) => {}, Level: { INFO: 2 } },
  UniversalCache: class { constructor(_p: boolean) {} },
  YT: {},
  YTNodes: {},
}));

// After mocks are ready, import the class under test
import { InnertubeService } from "@/service/innertube.service";

// Utility to build a service with a supplied Innertube double
const makeSvc = (inn?: any) => new InnertubeService((inn || createInnertubeInstance()) as any);

beforeEach(() => {
  jest.clearAllMocks();
  // reset http default implementation
  http.mockImplementation(async (_url: any) => new Response("{\"ok\":true}", { status: 200, headers: { "content-type": "application/json" } }));
  // reset helpers
  parseVideoInfo.mockImplementation((_info: any) => ({
    id: "vid",
    captionLanguages: [
      { languageCode: "en", baseUrl: "https://example/c?fmt=json3", isTranslatable: true },
      { languageCode: "id", baseUrl: "https://example/c2?fmt=json3", isTranslatable: true },
    ],
    captionTranslationLanguages: [
      { languageCode: "en" },
      { languageCode: "id" },
    ],
  }));
  hasCaptions.mockImplementation((_info: any) => true);
  parseTranscript.mockImplementation((_pvi: any, _ti: any) => ({
    id: "vid",
    transcript: { language: "en", segments: [{ text: "hello", startMs: 0, endMs: 1000 }], text: "hello" },
  }));
  finCaptionByLanguageCode.mockImplementation((caps: any[], lang?: string) => {
    const target = (lang || "en").toLowerCase();
    return caps.find(c => c.languageCode?.toLowerCase() === target) || caps[0];
  });
  buildParsedVideoInfoWithCaption.mockImplementation((base: any, decoded: any, lang: string) => ({
    ...base,
    caption: { hascaption: true, language: lang, segments: decoded?.segments || [], words: decoded?.words || [], text: decoded?.text || "" },
  }));
  decodeJson3Caption.mockImplementation((_text: string) => ({
    segments: [{ tStartMs: 0, dDurationMs: 500, utf8: "hi" }],
    words: [{ text: "hi", startMs: 0, endMs: 500 }],
    text: "hi",
  }));
});

describe("InnertubeService.getVideoInfo", () => {
  it("parses video info and strips baseUrl from captionLanguages", async () => {
    const svc = makeSvc();
    // Arrange parseVideoInfo to include baseUrl entries
    parseVideoInfo.mockImplementation((_i: any) => ({
      id: "vid",
      captionLanguages: [
        { languageCode: "en", baseUrl: "u1", isTranslatable: true },
        { languageCode: "id", baseUrl: "u2", isTranslatable: true },
      ],
      captionTranslationLanguages: [{ languageCode: "en" }],
    }));

    const out = await svc.getVideoInfo("abc");

    expect(parseVideoInfo).toHaveBeenCalledTimes(1);
    // Ensure baseUrl removed
    for (const c of out.captionLanguages) {
      expect("baseUrl" in c).toBeFalse();
    }
  });
});

describe("InnertubeService.getCaption", () => {
  it("returns empty caption when hasCaptions() is false", async () => {
    const svc = makeSvc();
    hasCaptions.mockImplementation(() => false);
    parseVideoInfo.mockImplementation(() => ({ id: "vid", captionLanguages: [], captionTranslationLanguages: [] }));

    const res = await svc.getCaption("abc", "en");

    expect(res.caption.hascaption).toBeFalse();
    expect(res.caption.segments).toEqual([]);
    expect(res.caption.text).toBe("");
  });

  it("fetches caption JSON3 and builds parsed info; adds tlang when translateLanguage provided", async () => {
    const svc = makeSvc();
    hasCaptions.mockImplementation(() => true);
    parseVideoInfo.mockImplementation(() => ({
      id: "vid",
      captionLanguages: [
        { languageCode: "en", baseUrl: "https://timed/text?fmt=json3", isTranslatable: true },
      ],
      captionTranslationLanguages: [{ languageCode: "id" }],
    }));

    http.mockImplementation(async (url: any) => new Response("{\"text\":\"hi\"}", { status: 200 }));

    const res = await svc.getCaption("abc", "en", "id");

    expect(http).toHaveBeenCalledTimes(1);
    const calledUrl = (http.mock.calls[0][0]) as string | URL;
    const u = new URL(String(calledUrl));
    expect(u.searchParams.get("tlang")).toBe("id");
    expect(u.searchParams.get("fmt")).toBe("json3");

    expect(buildParsedVideoInfoWithCaption).toHaveBeenCalledTimes(1);
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
    const out = await svc.getTranscript("abc", "en");

    expect(parseTranscript).toHaveBeenCalledTimes(1);
    expect(out.transcript.segments.length).toBe(1);
    expect(out.transcript.text).toBe("hello");
  });
});

describe("InnertubeService.getChannel", () => {
  it("calls innertube.getChannel and returns parsed channel", async () => {
    // Mock parseChannelInfo via module factory
    const parseChannelInfo = jest.fn(async (c: any) => ({ id: c.id, title: "T" } as any));
    mock.module("@/helper/channel.helper", () => ({ parseChannelInfo }));
    const inn = createInnertubeInstance();
    (inn as any).getChannel = async (id: string) => ({ id });

    // Re-import service to pick updated channel.helper mock for this test scope
    const { InnertubeService: ReSvc } = await import("@/service/innertube.service");
    const svc = new ReSvc(inn as any);
    const res = await svc.getChannel("CID");

    expect(parseChannelInfo).toHaveBeenCalledTimes(1);
    expect(res.id).toBe("CID");
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
