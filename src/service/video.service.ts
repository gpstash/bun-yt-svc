import { db } from '@/db/client';
import { videos } from '@/db/schema';
import type { ParsedVideoInfo } from '@/helper/video.helper';
import { createLogger } from '@/lib/logger.lib';

const logger = createLogger('service:video');

function mapParsedToRow(parsed: ParsedVideoInfo) {
  return {
    id: parsed.id,
    title: parsed.title,
    author: parsed.author,
    description: parsed.description,
    thumbnails: parsed.thumbnails,
    category: parsed.category,
    tags: parsed.tags,
    duration: parsed.duration,
    channel: parsed.channel,
    viewCount: parsed.viewCount,
    likeCount: parsed.likeCount,
    isPrivate: parsed.isPrivate,
    isUnlisted: parsed.isUnlisted,
    isFamilySafe: parsed.isFamilySafe,
    publishDateRaw: parsed.publishDate.raw,
    publishDateFormatted: parsed.publishDate.formatted,
    transcriptLanguages: parsed.transcriptLanguages,
    hasTranscripts: parsed.hasTranscripts,
    captionLanguages: parsed.captionLanguages,
    hasCaptions: parsed.hasCaptions,
    captionTranslationLanguages: parsed.captionTranslationLanguages,
    // createdAt handled by default
    updatedAt: new Date(),
  };
}

export async function upsertVideo(parsed: ParsedVideoInfo) {
  if (!db) {
    logger.warn('DB is not initialized. Skipping upsert for video', { id: parsed.id });
    return { upserted: false } as const;
  }

  const row = mapParsedToRow(parsed);
  logger.debug('Upserting video', { id: row.id });

  await db
    .insert(videos)
    .values(row)
    .onConflictDoUpdate({
      target: videos.id,
      // Only update mutable fields
      set: {
        title: row.title,
        author: row.author,
        description: row.description,
        thumbnails: row.thumbnails,
        category: row.category,
        tags: row.tags,
        duration: row.duration,
        channel: row.channel,
        viewCount: row.viewCount,
        likeCount: row.likeCount,
        isPrivate: row.isPrivate,
        isUnlisted: row.isUnlisted,
        isFamilySafe: row.isFamilySafe,
        publishDateRaw: row.publishDateRaw,
        publishDateFormatted: row.publishDateFormatted,
        transcriptLanguages: row.transcriptLanguages,
        hasTranscripts: row.hasTranscripts,
        captionLanguages: row.captionLanguages,
        hasCaptions: row.hasCaptions,
        captionTranslationLanguages: row.captionTranslationLanguages,
        updatedAt: new Date(),
      },
    });

  return { upserted: true } as const;
}
