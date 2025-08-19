import { db } from '@/db/client';
import { transcripts, videos } from '@/db/schema';
import { createLogger } from '@/lib/logger.lib';
import { and, eq, asc } from 'drizzle-orm';

const logger = createLogger('service:transcript');

type TranscriptRow = typeof transcripts.$inferSelect;

export interface TranscriptRecord {
  videoId: string;
  language: string; // empty string represents default/auto-selected language
  segments: Array<{ text: string; start: number; end: number }>;
  updatedAt: Date;
}

export async function hasTranscriptLanguage(videoId: string, language: string): Promise<boolean> {
  if (!db) {
    logger.warn('DB is not initialized. Skipping hasTranscriptLanguage', { videoId, language });
    return false;
  }
  try {
    const vrows = await db
      .select({ transcriptLanguages: videos.transcriptLanguages })
      .from(videos)
      .where(eq(videos.id, videoId))
      .limit(1);
    const langs = (vrows[0]?.transcriptLanguages ?? []) as unknown;
    const list = Array.isArray(langs) ? (langs as string[]) : [];
    return list.includes(language);
  } catch (e) {
    logger.warn('Failed reading transcriptLanguages from videos in hasTranscriptLanguage', { videoId, language, error: e });
    return false;
  }
}

export async function getOldestTranscriptLanguage(videoId: string): Promise<string | null> {
  if (!db) {
    logger.warn('DB is not initialized. Skipping getOldestTranscriptLanguage', { videoId });
    return null;
  }
  const rows = await db
    .select({ language: transcripts.language })
    .from(transcripts)
    .where(eq(transcripts.videoId, videoId))
    .orderBy(asc(transcripts.createdAt))
    .limit(1);
  const row = rows[0] as { language: string } | undefined;
  return row?.language ?? null;
}

export async function getPreferredTranscriptLanguage(videoId: string): Promise<string | null> {
  if (!db) {
    logger.warn('DB is not initialized. Skipping getPreferredTranscriptLanguage', { videoId });
    return null;
  }
  try {
    const vrows = await db
      .select({ transcriptLanguages: videos.transcriptLanguages })
      .from(videos)
      .where(eq(videos.id, videoId))
      .limit(1);
    const langs = (vrows[0]?.transcriptLanguages ?? []) as unknown;
    const list = Array.isArray(langs) ? (langs as string[]) : [];
    // Prefer English, then English (auto-generated)
    if (list.includes('English')) return 'English';
    if (list.includes('English (auto-generated)')) return 'English (auto-generated)';
  } catch (e) {
    logger.warn('Failed reading transcriptLanguages from videos; will fallback to oldest', { videoId, error: e });
  }
  // Fallback to oldest transcript language if English variants are not available
  return await getOldestTranscriptLanguage(videoId);
}

export async function upsertTranscript(videoId: string, language: string, data: { segments: Array<{ text: string; start: number; end: number }>; }) {
  if (!db) {
    logger.warn('DB is not initialized. Skipping upsert for transcript', { videoId, language });
    return { upserted: false } as const;
  }
  const now = new Date();
  await db
    .insert(transcripts)
    .values({ videoId, language, segments: data.segments, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: [transcripts.videoId, transcripts.language],
      set: { segments: data.segments, updatedAt: now },
    });
  return { upserted: true } as const;
}

export async function getTranscriptByVideoAndLanguage(videoId: string, language: string): Promise<TranscriptRecord | null> {
  if (!db) {
    logger.warn('DB is not initialized. Skipping getTranscriptByVideoAndLanguage', { videoId, language });
    return null;
  }
  const rows = await db
    .select()
    .from(transcripts)
    .where(and(eq(transcripts.videoId, videoId), eq(transcripts.language, language)))
    .limit(1);
  const row = rows[0] as TranscriptRow | undefined;
  if (!row) return null;
  return {
    videoId: row.videoId,
    language: row.language,
    segments: row.segments as any,
    updatedAt: row.updatedAt,
  } as TranscriptRecord;
}
