import { ParsedVideoInfo, ParsedVideoInfoWithCaption, TranscriptSegment } from "@/helper/video.helper";

/**
 * Decode YouTube caption JSON3 payload into normalized segments/words/text.
 * The JSON3 schema contains an `events` array; each event has `tStartMs`, optional `dDurationMs`, and `segs`.
 */
export function decodeJson3Caption(jsonText: string): { language: string; segments: TranscriptSegment[]; words: TranscriptSegment[]; text: string } {
  let obj: any;
  try {
    obj = JSON.parse(jsonText);
  } catch {
    return { language: "", segments: [], words: [], text: "" };
  }

  const events: any[] = Array.isArray(obj?.events) ? obj.events : [];
  const segments: TranscriptSegment[] = [];
  const words: TranscriptSegment[] = [];
  const texts: string[] = [];

  for (const ev of events) {
    const start = Number(ev?.tStartMs ?? 0);
    const dur = Number(ev?.dDurationMs ?? 0);
    const end = dur > 0 ? start + dur : start;
    const segs: any[] = Array.isArray(ev?.segs) ? ev.segs : [];

    // Merge event text
    const merged = segs.map((s) => (s?.utf8 ?? "")).join("");
    const mergedClean = merged.replace(/\n+/g, " ").trim();
    if (mergedClean) {
      segments.push({ text: mergedClean, start, end });
      texts.push(mergedClean);
    }

    // Word-level timings (best-effort)
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i] ?? {};
      const wText = String(s?.utf8 ?? "").trim();
      if (!wText) continue;
      const off = Number(s?.tOffsetMs ?? 0);
      const wStart = start + (off > 0 ? off : 0);
      let wEnd = wStart;
      const segDur = Number(s?.dDurationMs ?? 0);
      if (segDur > 0) {
        wEnd = wStart + segDur;
      } else if (i + 1 < segs.length && typeof segs[i + 1]?.tOffsetMs === 'number') {
        wEnd = start + Number(segs[i + 1].tOffsetMs);
      } else {
        wEnd = end > wStart ? end : wStart;
      }
      words.push({ text: wText, start: wStart, end: wEnd });
    }
  }

  const text = texts.join(' ').replace(/\s+/g, ' ').trim();
  const language = typeof obj?.language === 'string' ? obj.language : "";
  return { language, segments, words, text };
}

/**
 * Build ParsedVideoInfoWithCaption from base video info and decoded caption.
 */
export function buildParsedVideoInfoWithCaption(
  base: ParsedVideoInfo,
  decoded: { language: string; segments: TranscriptSegment[]; words: TranscriptSegment[]; text: string },
  fallbackLanguage?: string,
): ParsedVideoInfoWithCaption {
  // Remove caption baseUrl from base
  base.captionLanguages = base.captionLanguages.map((caption) => {
    return {
      ...caption,
      baseUrl: undefined,
    };
  });
  return {
    ...base,
    caption: {
      hascaption: decoded.segments.length > 0 || !!decoded.text.trim(),
      language: fallbackLanguage || decoded.language || "",
      segments: decoded.segments,
      words: decoded.words,
      text: decoded.text,
    }
  };
}
