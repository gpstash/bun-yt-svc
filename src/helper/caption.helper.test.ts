import { describe, expect, test } from "bun:test";
import { buildParsedVideoInfoWithCaption, decodeJson3Caption } from "@/helper/caption.helper";
import type { ParsedVideoInfo } from "@/helper/video.helper";

function makeJson3(events: any[], language?: string) {
  return JSON.stringify({ events, language });
}

describe("decodeJson3Caption()", () => {
  test("returns empty on invalid JSON", () => {
    const res = decodeJson3Caption("not-json");
    expect(res.language).toBe("");
    expect(res.segments).toEqual([]);
    expect(res.words).toEqual([]);
    expect(res.text).toBe("");
  });

  test("parses segments and words with timings", () => {
    const json = makeJson3([
      {
        tStartMs: 1000,
        dDurationMs: 2000,
        segs: [
          { utf8: "Hello ", tOffsetMs: 0, dDurationMs: 500 },
          { utf8: "world", tOffsetMs: 500, dDurationMs: 1500 },
          { utf8: "\n" },
        ],
      },
      {
        tStartMs: 4000,
        segs: [{ utf8: "Second" }],
      },
    ], "en");

    const res = decodeJson3Caption(json);
    expect(res.language).toBe("en");

    // Segments merged text
    expect(res.segments.map(s => s.text)).toEqual(["Hello world", "Second"]);
    expect(res.text).toBe("Hello world Second");

    // Word timings should be monotonic and within event bounds
    expect(res.words.length).toBeGreaterThanOrEqual(2);
    const [w1, w2] = res.words;
    expect(w1.text.trim()).toBe("Hello");
    expect(w1.start).toBeGreaterThanOrEqual(1000);
    expect(w1.end).toBeGreaterThan(w1.start);
    expect(w2.text.trim()).toBe("world");
    expect(w2.start).toBeGreaterThanOrEqual(w1.end);
  });

  test("gracefully handles missing segs and durations", () => {
    const json = makeJson3([
      { tStartMs: 0 },
      { tStartMs: 10, segs: [{ utf8: "A" }, { utf8: "B" }] },
      { tStartMs: 20, dDurationMs: 0, segs: [{ utf8: "C" }] },
    ]);
    const res = decodeJson3Caption(json);
    expect(res.text).toBe("AB C");
  });
});

describe("buildParsedVideoInfoWithCaption()", () => {
  const base: ParsedVideoInfo = {
    id: "vid",
    title: "t",
    author: "a",
    description: "d",
    thumbnails: [],
    category: "",
    tags: [],
    duration: 0,
    channel: { id: "c", name: "n", url: "u" },
    viewCount: 0,
    likeCount: 0,
    isPrivate: false,
    isUnlisted: false,
    isFamilySafe: true,
    publishDate: { raw: "", formatted: "" },
    transcriptLanguages: [],
    hasTranscripts: false,
    captionLanguages: [
      { name: "English", languageCode: "en", rtl: false, isTranslatable: true, baseUrl: "http://x" },
    ],
    hasCaptions: true,
    captionTranslationLanguages: [],
  };

  test("removes baseUrl and uses decoded values", () => {
    const decoded = {
      language: "id",
      segments: [{ text: "h", start: 0, end: 1 }],
      words: [{ text: "h", start: 0, end: 1 }],
      text: "h",
    };

    const out = buildParsedVideoInfoWithCaption(structuredClone(base), decoded);
    expect(out.caption.language).toBe("id");
    expect(out.caption.hascaption).toBe(true);
    expect(out.caption.words.length).toBe(1);
    expect(out.caption.segments.length).toBe(1);
    // baseUrl should be stripped
    expect(out.captionLanguages[0].baseUrl).toBeUndefined();
  });

  test("uses fallback language when provided", () => {
    const out = buildParsedVideoInfoWithCaption(structuredClone(base), { language: "", segments: [], words: [], text: "" }, "fr");
    expect(out.caption.language).toBe("fr");
  });
});
