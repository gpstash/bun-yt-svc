import { YT, Misc, YTNodes } from "youtubei.js";

export interface ParsedChannelInfo {
  id: string;
  title: string;
  description: string;
  url: string;
  vanityUrl: string;
  isFamilySafe: boolean;
  keywords: string[];
  avatars: Misc.Thumbnail[] | { url: string; width: number; height: number };
  thumbnails: Misc.Thumbnail[] | { url: string; width: number; height: number };
  tags: string[];
  isUnlisted: boolean;
  subscriberCount: number;
  viewCount: number;
  joinedDate: string;
  videoCount: number;
  country: string;
  about?: YTNodes.AboutChannel;
}

// Extract the leading numeric value from a human string like
// "6,403,179,271 views" or "358,745 videos". Falls back to 0 when invalid.
function parseCount(input: unknown): number {
  if (typeof input === 'number' && Number.isFinite(input)) return input;
  if (typeof input !== 'string') return 0;

  // Keep digits and separators/decimal, drop other characters
  const normalized = input.trim();

  // Handle compact notations like "9.91M", "123K" ONLY when a unit is present.
  // This avoids treating comma-formatted values like "6,403,179,271" as just "6".
  const compact = normalized.match(/^([0-9]+(?:\.[0-9]+)?)\s*([kKmMbB])\b/);
  if (compact) {
    const base = Number(compact[1]);
    const unit = (compact[2] || '').toLowerCase();
    if (!Number.isFinite(base)) return 0;
    switch (unit) {
      case 'k': return Math.round(base * 1_000);
      case 'm': return Math.round(base * 1_000_000);
      case 'b': return Math.round(base * 1_000_000_000);
      default: return Math.round(base);
    }
  }

  // Otherwise, extract digits and commas/periods, then parse as integer by
  // removing non-digits.
  const digits = normalized.replace(/[^0-9]/g, '');
  if (!digits) return 0;
  try {
    // Use BigInt-safe range by parsing as number; DB column is bigint but TS number
    // can safely represent up to 2^53-1; YouTube view counts fit within that today.
    const n = Number(digits);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

export async function parseChannelInfo(channel: YT.Channel): Promise<ParsedChannelInfo> {
  const about = await channel.getAbout() as YTNodes.AboutChannel;
  const aboutMetadata = about?.metadata;
  return {
    id: channel?.metadata?.external_id ?? "",
    title: channel?.metadata?.title ?? "",
    description: aboutMetadata?.description ?? "",
    url: channel?.metadata?.url ?? "",
    vanityUrl: channel?.metadata?.vanity_channel_url ?? "",
    isFamilySafe: channel?.metadata?.is_family_safe ?? false,
    keywords: channel?.metadata?.keywords ?? [],
    avatars: channel?.metadata?.avatar ?? {
      url: "",
      width: 0,
      height: 0,
    },
    thumbnails: channel?.metadata?.thumbnail ?? {
      url: "",
      width: 0,
      height: 0,
    },
    tags: channel?.metadata?.tags ?? [],
    isUnlisted: channel?.metadata?.is_unlisted ?? false,
    subscriberCount: parseCount(aboutMetadata?.subscriber_count ?? ""),
    viewCount: parseCount(aboutMetadata?.view_count ?? ""),
    joinedDate: aboutMetadata?.joined_date?.text ?? "",
    videoCount: parseCount(aboutMetadata?.video_count ?? ""),
    country: aboutMetadata?.country ?? "",
  };
}