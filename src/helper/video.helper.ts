import type { YT } from "youtubei.js";
import { parse, isValid } from "date-fns";

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
  publishDate: {
    raw: string;
    formatted: string;
  }
  transcriptLanguages: string[];
  hasTranscripts: boolean;
  captions: Caption[];
  hasCaptions: boolean;
}

export type CaptionFormat = 'srv3' | 'srv2' | 'srv1' | 'vtt' | 'ttml' | 'srt';
const CAPTION_FORMATS: CaptionFormat[] = ['srv3', 'srv2', 'srv1', 'vtt', 'ttml', 'srt'];

function generateThumbnails(videoId: string): Thumbnail[] {
  const baseUrl = `https://img.youtube.com/vi/${videoId}/`;
  if (!videoId) return [];
  return [
    { url: `${baseUrl}default.jpg`, width: 120, height: 90 },
    { url: `${baseUrl}mqdefault.jpg`, width: 320, height: 180 },
    { url: `${baseUrl}hqdefault.jpg`, width: 480, height: 360 },
    { url: `${baseUrl}sddefault.jpg`, width: 640, height: 480 },
    { url: `${baseUrl}maxresdefault.jpg`, width: 1280, height: 720 },
  ];
}

export function parseVideoInfo(info: YT.VideoInfo): ParsedVideoInfo {
  const hasTranscripts: boolean = (info?.captions?.caption_tracks ?? []).length > 0;
  const hasCaptions: boolean = (info?.captions?.caption_tracks ?? []).length > 0;


  return {
    id: info?.basic_info?.id ?? "",
    title: info?.basic_info?.title ?? "",
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
    publishDate: {
      raw: info.primary_info?.published?.text ?? "",
      formatted: info.primary_info?.published?.text ? getPublishDate(info.primary_info.published.text) : "",
    },
    transcriptLanguages: (info?.captions?.caption_tracks ?? []).map((track) => track?.name?.text ?? ""),
    hasTranscripts,
    captions: info?.captions?.caption_tracks?.map((track) => ({
      name: track?.name?.text ?? "",
      languageCode: track?.language_code ?? "",
      rtl: track?.name?.rtl ?? false,
      isTranslatable: track?.is_translatable ?? false,
      baseUrl: track?.base_url,
    })) ?? [],
    hasCaptions,
  }
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

  // Case: Absolute date like "May 10, 2025" or "Aug 4, 2025"
  // Try parsing with date-fns as UTC
  // Supported formats: 'MMM d, yyyy', 'MMMM d, yyyy', fallback to Date if needed
  let parsedDate = parse(dateStr, 'MMM d, yyyy', new Date(0));
  if (!isValid(parsedDate)) {
    parsedDate = parse(dateStr, 'MMMM d, yyyy', new Date(0));
  }
  if (isValid(parsedDate)) {
    // Set to UTC midnight
    const utcDate = new Date(Date.UTC(parsedDate.getFullYear(), parsedDate.getMonth(), parsedDate.getDate()));
    return utcDate.toISOString();
  }

  // Fallback: try native Date parsing (for ISO, RFC, etc)
  parsedDate = new Date(dateStr);
  if (!isNaN(parsedDate.getTime())) {
    // Convert to UTC midnight if time is 00:00 local
    const utcDate = new Date(Date.UTC(parsedDate.getFullYear(), parsedDate.getMonth(), parsedDate.getDate()));
    return utcDate.toISOString();
  }

  // Unknown format
  return "";
}