import { db } from '@/db/client';
import { channels } from '@/db/schema';
import type { ParsedChannelInfo } from '@/helper/channel.helper';
import { createLogger } from '@/lib/logger.lib';
import { eq } from 'drizzle-orm';

const logger = createLogger('service:channel');

type ChannelRow = typeof channels.$inferSelect;

function mapParsedToRow(parsed: ParsedChannelInfo) {
  return {
    id: parsed.id,
    title: parsed.title,
    description: parsed.description,
    url: parsed.url,
    vanityUrl: parsed.vanityUrl,
    isFamilySafe: parsed.isFamilySafe,
    keywords: parsed.keywords,
    avatars: parsed.avatars as any,
    thumbnails: parsed.thumbnails as any,
    tags: parsed.tags,
    isUnlisted: parsed.isUnlisted,
    subscriberCount: parsed.subscriberCount,
    viewCount: parsed.viewCount,
    joinedDate: parsed.joinedDate,
    videoCount: parsed.videoCount,
    country: parsed.country,
    updatedAt: new Date(),
  };
}

export async function upsertChannel(parsed: ParsedChannelInfo) {
  if (!db) {
    logger.warn('DB is not initialized. Skipping upsert for channel', { id: parsed.id });
    return { upserted: false } as const;
  }
  const row = mapParsedToRow(parsed);
  logger.debug('Upserting channel', { id: row.id });
  await db
    .insert(channels)
    .values(row)
    .onConflictDoUpdate({
      target: channels.id,
      set: {
        title: row.title,
        description: row.description,
        url: row.url,
        vanityUrl: row.vanityUrl,
        isFamilySafe: row.isFamilySafe,
        keywords: row.keywords,
        avatars: row.avatars,
        thumbnails: row.thumbnails,
        tags: row.tags,
        isUnlisted: row.isUnlisted,
        subscriberCount: row.subscriberCount,
        viewCount: row.viewCount,
        joinedDate: row.joinedDate,
        videoCount: row.videoCount,
        country: row.country,
        updatedAt: new Date(),
      },
    });
  return { upserted: true } as const;
}

function mapRowToParsed(row: ChannelRow): ParsedChannelInfo {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    url: row.url,
    vanityUrl: row.vanityUrl,
    isFamilySafe: row.isFamilySafe,
    keywords: row.keywords,
    avatars: row.avatars as any,
    thumbnails: row.thumbnails as any,
    tags: row.tags,
    isUnlisted: row.isUnlisted,
    subscriberCount: row.subscriberCount,
    viewCount: row.viewCount,
    joinedDate: row.joinedDate,
    videoCount: row.videoCount,
    country: row.country,
  };
}

export async function getChannelById(id: string): Promise<{ channel: ParsedChannelInfo; updatedAt: Date } | null> {
  if (!db) {
    logger.warn('DB is not initialized. Skipping getChannelById', { id });
    return null;
  }
  const rows = await db
    .select({
      id: channels.id,
      title: channels.title,
      description: channels.description,
      url: channels.url,
      vanityUrl: channels.vanityUrl,
      isFamilySafe: channels.isFamilySafe,
      keywords: channels.keywords,
      avatars: channels.avatars,
      thumbnails: channels.thumbnails,
      tags: channels.tags,
      isUnlisted: channels.isUnlisted,
      subscriberCount: channels.subscriberCount,
      viewCount: channels.viewCount,
      joinedDate: channels.joinedDate,
      videoCount: channels.videoCount,
      country: channels.country,
      updatedAt: channels.updatedAt,
    })
    .from(channels)
    .where(eq(channels.id, id))
    .limit(1);
  const row = rows[0] as any;
  if (!row) return null;
  const parsed = mapRowToParsed(row as ChannelRow);
  return { channel: parsed, updatedAt: row.updatedAt };
}
