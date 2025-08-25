import { db } from '@/db/client';
import { playlists } from '@/db/schema';
import { createLogger } from '@/lib/logger.lib';
import { eq } from 'drizzle-orm';

const logger = createLogger('service:playlist');

export type PlaylistInfo = {
  id: string;
  title: string;
  description: string;
  subtitle?: string | null;
  author: { id?: string; name?: string; url?: string };
  videoCount: number;
  viewCount: number;
  lastUpdated?: string | null;
};

type PlaylistRow = typeof playlists.$inferSelect;

function mapToRow(p: PlaylistInfo) {
  return {
    id: p.id,
    title: p.title,
    description: p.description,
    subtitle: p.subtitle ?? "",
    author: p.author as any,
    videoCount: p.videoCount,
    viewCount: p.viewCount,
    lastUpdated: p.lastUpdated ?? null,
    updatedAt: new Date(),
  };
}

function mapRow(row: PlaylistRow): PlaylistInfo {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    subtitle: row.subtitle ?? "",
    author: row.author as any,
    videoCount: row.videoCount,
    viewCount: row.viewCount,
    lastUpdated: row.lastUpdated ?? undefined,
  };
}

export async function upsertPlaylist(info: PlaylistInfo) {
  if (!db) {
    logger.warn('DB is not initialized. Skipping upsert for playlist', { id: info.id });
    return { upserted: false } as const;
  }
  const row = mapToRow(info);
  logger.debug('Upserting playlist', { id: row.id });
  await db
    .insert(playlists)
    .values(row)
    .onConflictDoUpdate({
      target: playlists.id,
      set: {
        title: row.title,
        description: row.description,
        subtitle: row.subtitle,
        author: row.author,
        videoCount: row.videoCount,
        viewCount: row.viewCount,
        lastUpdated: row.lastUpdated,
        updatedAt: new Date(),
      },
    });
  return { upserted: true } as const;
}

export async function getPlaylistById(id: string): Promise<{ playlist: PlaylistInfo; updatedAt: Date } | null> {
  if (!db) {
    logger.warn('DB is not initialized. Skipping getPlaylistById', { id });
    return null;
  }
  const rows = await db
    .select({
      id: playlists.id,
      title: playlists.title,
      description: playlists.description,
      subtitle: playlists.subtitle,
      author: playlists.author,
      videoCount: playlists.videoCount,
      viewCount: playlists.viewCount,
      lastUpdated: playlists.lastUpdated,
      updatedAt: playlists.updatedAt,
    })
    .from(playlists)
    .where(eq(playlists.id, id))
    .limit(1);
  const row = rows[0] as any;
  if (!row) return null;
  return { playlist: mapRow(row as PlaylistRow), updatedAt: row.updatedAt };
}
