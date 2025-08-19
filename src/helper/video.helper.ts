import type { YT } from "youtubei.js";
import { parse, isValid } from "date-fns";
import { createLogger } from "@/lib/logger.lib";

const logger = createLogger('helper:video');

export interface Thumbnail {
  url: string;
  width: number;
  height: number;
}

export interface Caption {
  name: string;
  languageCode: string;
  rtl: boolean;
  isTranslatable: boolean;
  baseUrl?: string;
}

export interface ParsedVideoInfo {
  id: string;
  title: string;
  author: string;
  description: string;
  thumbnails: Thumbnail[];
  category: string;
  tags: string[];
  duration: number;
  channel: {
    id: string;
    name: string;
    url: string;
  };
  viewCount: number;
  likeCount: number;
  isPrivate: boolean;
  isUnlisted: boolean;
  isFamilySafe: boolean;
  publishDate: {
    raw: string;
    formatted: string;
  }
  transcriptLanguages: string[];
  hasTranscripts: boolean;
  captionLanguages: Caption[];
  hasCaptions: boolean;
  captionTranslationLanguages: {
    languageCode: string;
    name: string;
  }[];
}

export interface ParsedVideoInfoWithCaption extends ParsedVideoInfo {
  caption: {
    hascaption: boolean;
    language: string;
    segments: TranscriptSegment[];
    words: TranscriptSegment[];
    text: string;
  }
}

export interface TranscriptSegment {
  text: string;
  start: number;
  end: number;
}

export interface ParsedVideoInfoWithTranscript extends ParsedVideoInfo {
  transcript: {
    language: string;
    segments: TranscriptSegment[];
    text: string;
  }
}

export type CaptionFormat = 'srv3' | 'srv2' | 'srv1' | 'vtt' | 'ttml' | 'srt';
const CAPTION_FORMATS: CaptionFormat[] = ['srv3', 'srv2', 'srv1', 'vtt', 'ttml', 'srt'];

function generateThumbnails(videoId: string): Thumbnail[] {
  if (!videoId) return [];
  const baseUrl = `https://img.youtube.com/vi/${videoId}/`;
  return [
    { url: `${baseUrl}default.jpg`, width: 120, height: 90 },
    { url: `${baseUrl}mqdefault.jpg`, width: 320, height: 180 },
    { url: `${baseUrl}hqdefault.jpg`, width: 480, height: 360 },
    { url: `${baseUrl}sddefault.jpg`, width: 640, height: 480 },
    { url: `${baseUrl}maxresdefault.jpg`, width: 1280, height: 720 },
  ];
}

export function parseVideoInfo(info: YT.VideoInfo): ParsedVideoInfo {
  const tracks = info?.captions?.caption_tracks ?? [];

  return {
    id: info?.basic_info?.id ?? "",
    title: info?.basic_info?.title ?? "",
    author: info?.basic_info?.author ?? "",
    description: info?.basic_info?.short_description ?? "",
    thumbnails: generateThumbnails(info?.basic_info?.id ?? ""),
    category: info?.basic_info?.category ?? "",
    tags: info?.basic_info?.tags ?? [],
    duration: info?.basic_info?.duration ?? 0,
    channel: info?.basic_info?.channel ?? {
      id: "",
      name: "",
      url: "",
    },
    viewCount: info?.basic_info?.view_count ?? 0,
    likeCount: info?.basic_info?.like_count ?? 0,
    isPrivate: info?.basic_info?.is_private ?? false,
    isUnlisted: info?.basic_info?.is_unlisted ?? false,
    isFamilySafe: info?.basic_info?.is_family_safe ?? false,
    publishDate: {
      raw: info.primary_info?.published?.text ?? "",
      formatted: info.primary_info?.published?.text ? getPublishDate(info.primary_info.published.text) : "",
    },
    hasTranscripts: tracks.length > 0,
    transcriptLanguages: tracks.map((track) => track?.name?.text ?? ""),
    hasCaptions: tracks.length > 0,
    captionLanguages: tracks.map((track) => ({
      name: track?.name?.text ?? "",
      languageCode: track?.language_code ?? "",
      rtl: track?.name?.rtl ?? false,
      isTranslatable: track?.is_translatable ?? false,
      baseUrl: track?.base_url,
    })) ?? [],
    captionTranslationLanguages: (info?.captions?.translation_languages ?? []).map((tLang) => ({
      name: tLang.language_name.text ?? tLang.language_code,
      languageCode: tLang.language_code,
    })),
  };
}

export function getPublishDate(dateStr: string): string {
  const now = new Date();

  // Case: Relative time like "Premiered 14 hours ago" or "14 hours ago"
  const relativeMatch = dateStr.match(/(\d+)\s+(seconds?|minutes?|hours?|days?|weeks?|months?|years?)\s+ago/i);
  if (relativeMatch) {
    const amount = parseInt(relativeMatch[1], 10);
    const unit = relativeMatch[2].toLowerCase();

    const date = new Date(now); // make a copy

    switch (unit) {
      case 'second':
      case 'seconds':
        date.setSeconds(date.getSeconds() - amount);
        break;
      case 'minute':
      case 'minutes':
        date.setMinutes(date.getMinutes() - amount);
        break;
      case 'hour':
      case 'hours':
        date.setHours(date.getHours() - amount);
        break;
      case 'day':
      case 'days':
        date.setDate(date.getDate() - amount);
        break;
      case 'week':
      case 'weeks':
        date.setDate(date.getDate() - amount * 7);
        break;
      case 'month':
      case 'months':
        date.setMonth(date.getMonth() - amount);
        break;
      case 'year':
      case 'years':
        date.setFullYear(date.getFullYear() - amount);
        break;
    }

    return date.toISOString();
  }

  // Clean common YouTube prefixes/suffixes for absolute dates
  const cleaned = dateStr
    .replace(/\(.*?\)/g, '') // remove parentheticals like (edited)
    .replace(/\b(Premiered|Streamed live|Streamed|Published|Uploaded)\b/gi, '')
    .replace(/\bon\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  // Case: Absolute date like "May 10, 2025" or "Aug 4, 2025" or day-first variants
  // Try parsing with date-fns as UTC
  // Supported formats: 'MMM d, yyyy', 'MMMM d, yyyy', 'd MMM yyyy', 'd MMMM yyyy', fallback to Date if needed
  let parsedDate = parse(cleaned, 'MMM d, yyyy', new Date(0));
  if (!isValid(parsedDate)) {
    parsedDate = parse(cleaned, 'MMMM d, yyyy', new Date(0));
  }
  if (!isValid(parsedDate)) {
    parsedDate = parse(cleaned, 'd MMM yyyy', new Date(0));
  }
  if (!isValid(parsedDate)) {
    parsedDate = parse(cleaned, 'd MMMM yyyy', new Date(0));
  }
  if (isValid(parsedDate)) {
    // Set to UTC midnight
    const utcDate = new Date(Date.UTC(parsedDate.getFullYear(), parsedDate.getMonth(), parsedDate.getDate()));
    return utcDate.toISOString();
  }

  // Fallback: try native Date parsing (for ISO, RFC, etc)
  parsedDate = new Date(cleaned);
  if (!isNaN(parsedDate.getTime())) {
    // If time component present, keep exact instant; else normalize to UTC midnight
    const hasTime = /\d{1,2}:\d{2}/.test(cleaned) || /T\d{2}:\d{2}/.test(cleaned);
    if (hasTime) {
      return parsedDate.toISOString();
    }
    const utcDate = new Date(Date.UTC(parsedDate.getFullYear(), parsedDate.getMonth(), parsedDate.getDate()));
    return utcDate.toISOString();
  }

  // Unknown format
  return "";
}

export function hasCaptions(info: YT.VideoInfo): boolean {
  return (info?.captions?.caption_tracks ?? []).length > 0;
}

export function parseTranscript(parsedVideoInfo: ParsedVideoInfo, selectedTranscript: YT.TranscriptInfo): ParsedVideoInfoWithTranscript {
  const initialSegments = selectedTranscript?.transcript?.content?.body?.initial_segments ?? [];
  const segments: TranscriptSegment[] = [];
  const textParts: string[] = [];

  for (const segment of initialSegments) {
    if (segment.type === "TranscriptSegment") {
      const start = Number(segment.start_ms);
      const end = Number(segment.end_ms);
      const segmentText = segment?.snippet?.text ?? "";

      segments.push({
        start,
        end,
        text: segmentText ?? "",
      });

      if (segmentText) textParts.push(segmentText);
    }
  }

  const text = textParts.join(' ');
  // Remove transcript baseUrl from base
  parsedVideoInfo.captionLanguages = parsedVideoInfo.captionLanguages.map((language) => {
    return {
      ...language,
      baseUrl: undefined,
    };
  });
  return {
    ...parsedVideoInfo,
    transcript: {
      language: selectedTranscript?.selectedLanguage ?? "",
      segments,
      text,
    },
  };
}

export function finCaptionByLanguageCode(captions: Caption[], languageCode: string = "en"): Caption {
  // Normalize empty/falsy language input to 'en' so callers can pass '' safely
  const effective = (languageCode && languageCode.trim()) ? languageCode : 'en';
  logger.debug('finCaptionByLanguageCode', { languageCode: effective });
  const caption = captions.find((caption) => caption.languageCode.toLowerCase() === effective.toLowerCase());
  if (caption) {
    logger.debug('finCaptionByLanguageCode: found', { caption });
    return caption;
  }
  logger.debug('finCaptionByLanguageCode: not found, using first caption', { caption: captions[0] });
  return captions[0];
}
