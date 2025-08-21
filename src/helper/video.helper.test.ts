import { describe, expect, test } from "bun:test";
import { getPublishDate, hasCaptions, parseTranscript, parseVideoInfo, finCaptionByLanguageCode } from "@/helper/video.helper";

function makeVideoInfo(overrides: any = {}) {
  return {
    basic_info: {
      id: "vid",
      title: "title",
      author: "author",
      short_description: "desc",
      category: "cat",
      tags: ["t"],
      duration: 123,
      channel: { id: "c", name: "n", url: "u" },
      view_count: 1,
      like_count: 2,
      is_private: false,
      is_unlisted: false,
      is_family_safe: true,
    },
    primary_info: {
      published: { text: "May 10, 2025" },
    },
    captions: {
      caption_tracks: [
        { name: { text: "English", rtl: false }, language_code: "en", is_translatable: true, base_url: "http://c" },
      ],
      translation_languages: [
        { language_code: "id", language_name: { text: "Indonesian" } },
      ],
    },
    ...overrides,
  } as any;
}

describe("parseVideoInfo()", () => {
  test("extracts fields and computes thumbnails", () => {
    const out = parseVideoInfo(makeVideoInfo());
    expect(out.id).toBe("vid");
    expect(out.title).toBe("title");
    expect(out.hasTranscripts).toBe(true);
    expect(out.transcriptLanguages).toEqual(["English"]);
    expect(out.hasCaptions).toBe(true);
    expect(out.captionLanguages[0].languageCode).toBe("en");
    expect(out.thumbnails.length).toBeGreaterThan(3);
    expect(out.publishDate.formatted).toMatch(/2025-05-10T00:00:00.000Z/);
  });
});

describe("getPublishDate()", () => {
  test("relative times produce recent ISO date", () => {
    const iso = getPublishDate("14 hours ago");
    expect(iso).toMatch(/T/);
  });
  test("absolute formats parse correctly", () => {
    expect(getPublishDate("May 10, 2025")).toBe("2025-05-10T00:00:00.000Z");
    expect(getPublishDate("10 May 2025")).toBe("2025-05-10T00:00:00.000Z");
  });
  test("falls back and returns empty for unknown", () => {
    expect(getPublishDate("not a date")).toBe("");
  });
});

describe("hasCaptions()", () => {
  test("true when tracks exist", () => {
    expect(hasCaptions(makeVideoInfo())).toBe(true);
  });
  test("false when no tracks", () => {
    expect(hasCaptions(makeVideoInfo({ captions: { caption_tracks: [] } }))).toBe(false);
  });
});

describe("parseTranscript()", () => {
  test("builds segments and strips baseUrl from captions", () => {
    const base = parseVideoInfo(makeVideoInfo());
    const selected = {
      selectedLanguage: "en",
      transcript: {
        content: {
          body: {
            initial_segments: [
              { type: "TranscriptSegment", start_ms: 0, end_ms: 1000, snippet: { text: "Hello" } },
              { type: "TranscriptSegment", start_ms: 1000, end_ms: 2000, snippet: { text: "world" } },
            ],
          },
        },
      },
    } as any;
    const out = parseTranscript(base, selected);
    expect(out.transcript.language).toBe("en");
    expect(out.transcript.text).toBe("Hello world");
    expect(out.captionLanguages[0].baseUrl).toBeUndefined();
  });
});

describe("finCaptionByLanguageCode()", () => {
  const caps = [
    { name: "English", languageCode: "en", rtl: false, isTranslatable: true },
    { name: "Indonesian", languageCode: "id", rtl: false, isTranslatable: false },
  ];
  test("finds case-insensitive match", () => {
    const c = finCaptionByLanguageCode(caps as any, "EN");
    expect(c.languageCode).toBe("en");
  });
  test("uses first when not found", () => {
    const c = finCaptionByLanguageCode(caps as any, "xx");
    expect(c.languageCode).toBe("en");
  });
  test("defaults empty input to 'en'", () => {
    const c = finCaptionByLanguageCode(caps as any, "");
    expect(c.languageCode).toBe("en");
  });
});
