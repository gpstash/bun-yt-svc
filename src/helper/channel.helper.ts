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
  subscriberCount: string;
  viewCount: string;
  joinedDate: string;
  videoCount: string;
  country: string;
  about?: YTNodes.AboutChannel;
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
    subscriberCount: aboutMetadata?.subscriber_count ?? "",
    viewCount: aboutMetadata?.view_count ?? "",
    joinedDate: aboutMetadata?.joined_date?.text ?? "",
    videoCount: aboutMetadata?.video_count ?? "",
    country: aboutMetadata?.country ?? "",
  };
}