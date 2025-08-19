import { db } from '@/db/client';
import { captions, videos } from '@/db/schema';
import { createLogger } from '@/lib/logger.lib';
import { and, eq, asc, isNull } from 'drizzle-orm';

const logger = createLogger('service:caption');

type CaptionRow = typeof captions.$inferSelect;

export interface CaptionRecord {
  videoId: string;
  language: string;
  targetLanguage: string | null;
  segments: Array<{ text: string; start: number; end: number }>;
  words: Array<{ text: string; start: number; end: number }>;
  updatedAt: Date;
}

export async function hasCaptionLanguage(videoId: string, language: string): Promise<boolean> {
  if (!db) {
    logger.warn('DB is not initialized. Skipping hasCaptionLanguage', { videoId, language });
    return false;
  }
  try {
    const vrows = await db
      .select({ captionLanguages: videos.captionLanguages })
      .from(videos)
      .where(eq(videos.id, videoId))
      .limit(1);
    const langs = (vrows[0]?.captionLanguages ?? []) as unknown;
    const list = Array.isArray(langs) ? (langs as Array<{ languageCode: string }>).map(l => l.languageCode) : [];
    return list.includes(language);
  } catch (e) {
    logger.warn('Failed reading captionLanguages from videos in hasCaptionLanguage', { videoId, language, error: e });
    return false;
  }
}

export async function getOldestCaptionLanguage(videoId: string): Promise<string | null> {
  if (!db) {
    logger.warn('DB is not initialized. Skipping getOldestCaptionLanguage', { videoId });
    return null;
  }
  const rows = await db
    .select({ language: captions.language })
    .from(captions)
    .where(eq(captions.videoId, videoId))
    .orderBy(asc(captions.createdAt))
    .limit(1);
  const row = rows[0] as { language: string } | undefined;
  return row?.language ?? null;
}

export async function getPreferredCaptionLanguage(videoId: string): Promise<string | null> {
  if (!db) {
    logger.warn('DB is not initialized. Skipping getPreferredCaptionLanguage', { videoId });
    return null;
  }
  try {
    const vrows = await db
      .select({ captionLanguages: videos.captionLanguages })
      .from(videos)
      .where(eq(videos.id, videoId))
      .limit(1);
    const langs = (vrows[0]?.captionLanguages ?? []) as unknown as Array<{ languageCode?: string; name?: string }>;
    const list = Array.isArray(langs) ? langs : [];
    const byCode = (code: string) => list.find(l => (l.languageCode || '').toLowerCase() === code.toLowerCase());
    if (byCode('en')) return byCode('en')!.languageCode!;
    if (byCode('en-US')) return byCode('en-US')!.languageCode!;
    if (byCode('en-GB')) return byCode('en-GB')!.languageCode!;
  } catch (e) {
    logger.warn('Failed reading captionLanguages from videos; will fallback to oldest', { videoId, error: e });
  }
  return await getOldestCaptionLanguage(videoId);
}

export async function upsertCaption(
  videoId: string,
  language: string,
  data: { segments: Array<{ text: string; start: number; end: number }>; words: Array<{ text: string; start: number; end: number }>; targetLanguage?: string | null; }
) {
  if (!db) {
    logger.warn('DB is not initialized. Skipping upsert for caption', { videoId, language });
    return { upserted: false } as const;
  }
  const now = new Date();
  await db
    .insert(captions)
    .values({ videoId, language, targetLanguage: data.targetLanguage ?? null, segments: data.segments, words: data.words, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: [captions.videoId, captions.language, captions.targetLanguage],
      set: { segments: data.segments, words: data.words, updatedAt: now },
    });
  return { upserted: true } as const;
}

export async function getCaptionByVideoAndLanguage(videoId: string, language: string, targetLanguage?: string | null): Promise<CaptionRecord | null> {
  if (!db) {
    logger.warn('DB is not initialized. Skipping getCaptionByVideoAndLanguage', { videoId, language });
    return null;
  }
  const rows = await db
    .select({
      videoId: captions.videoId,
      language: captions.language,
      targetLanguage: captions.targetLanguage,
      segments: captions.segments as any,
      words: captions.words as any,
      updatedAt: captions.updatedAt,
    })
    .from(captions)
    .where(
      and(
        eq(captions.videoId, videoId),
        eq(captions.language, language),
        targetLanguage == null ? isNull(captions.targetLanguage) : eq(captions.targetLanguage, targetLanguage)
      )
    )
    .limit(1);
  const row = rows[0] as any as CaptionRow | undefined;
  if (!row) return null;
  return {
    videoId: row.videoId,
    language: row.language,
    targetLanguage: row.targetLanguage ?? null,
    segments: row.segments as any,
    words: row.words as any,
    updatedAt: row.updatedAt,
  } as CaptionRecord;
}
