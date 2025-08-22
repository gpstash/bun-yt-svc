import { Hono } from "hono";
import type { Context } from "hono";
import type { AppSchema } from "@/app";
import { createLogger } from "@/lib/logger.lib";
import { ERROR_CODES, STATUS_CLIENT_CLOSED_REQUEST, isClientAbort, mapErrorToHttp } from "@/lib/hono.util";
import { redisGetJson, redisSetJson } from "@/lib/redis.lib";
import { jitterTtl, singleflight, fetchWithRedisLock, isNegativeCache, makeNegativeCache } from "@/lib/cache.util";
import { navigationMiddleware } from "@/middleware/navigation.middleware";
import type { ChannelVideo } from "@/service/innertube.service";
import { readBatchThrottle } from "@/lib/throttle.util";
import { getPlaylistById, upsertPlaylist, type PlaylistInfo } from "@/service/playlist.service";

export const v1InnertubePlaylistRouter = new Hono<AppSchema>();
const logger = createLogger('router:v1:innertube:playlist');
logger.debug('Initializing /v1/innertube/playlist router');

function buildCacheKey(playlistId: string) {
  return `yt:playlist:${playlistId}`;
}

function buildVideosCacheKey(playlistId: string) {
  return `yt:playlist:${playlistId}:videos`;
}

// Very permissive playlist id detector; accepts raw ID or playlist URL
function extractPlaylistId(input: string): string | null {
  if (!input || typeof input !== 'string') return null;
  const s = input.trim();
  // If it's a URL, try standard patterns
  try {
    const u = new URL(s);
    const listParam = u.searchParams.get('list');
    if (listParam && /^[A-Za-z0-9-_]{10,100}$/.test(listParam)) return listParam;
    // Also support /playlist?list=... or /watch?list=...
    // Already covered by searchParams
    // Shorts/live/embed rarely carry list ids, ignore
  } catch {
    // Not a URL, fall through
  }
  // Bare ID heuristics: common prefixes PL, UU, LL, OL; but be permissive on length/charset
  if (/^[A-Za-z0-9-_]{10,100}$/.test(s)) return s;
  return null;
}

// Convert a channel UC... id to its uploads playlist UU... id
function channelIdToUploads(channelId: string | undefined | null): string | null {
  if (!channelId) return null;
  const uc = channelId.trim();
  if (!/^UC[0-9A-Za-z_-]{22}$/i.test(uc)) return null;
  const rest = uc.slice(2);
  return `UU${rest}`;
}

async function fetchPlaylist(c: Context<AppSchema>, playlistId: string) {
  const requestId = c.get('requestId');
  const ttlSeconds = c.get('config').VIDEO_CACHE_TTL_SECONDS as number; // reuse video TTL
  const cacheKey = buildCacheKey(playlistId);

  // 1) Cache first
  const cached = await redisGetJson<any>(cacheKey).catch(() => undefined);
  if (cached) {
    logger.info('Cache hit for playlist', { playlistId, requestId });
    if (isNegativeCache(cached)) {
      return { __error: true, error: cached.error, code: cached.code, __status: (cached as any).__status ?? 400 };
    }
    return { data: cached };
  }

  // 2) DB next
  try {
    const dbRes = await getPlaylistById(playlistId);
    if (dbRes) {
      const now = Date.now();
      const updatedAtMs = new Date(dbRes.updatedAt).getTime();
      const ageSeconds = Math.max(0, Math.floor((now - updatedAtMs) / 1000));
      if (ageSeconds < ttlSeconds) {
        const remaining = Math.max(1, ttlSeconds - ageSeconds);
        try { await redisSetJson(cacheKey, dbRes.playlist, jitterTtl(remaining)); } catch { /* noop */ }
        logger.info('DB hit within TTL for playlist', { playlistId, ageSeconds, remaining, requestId });
        return { data: dbRes.playlist };
      }
    }
  } catch {
    // Non-fatal
  }

  // 3) Fetch -> upsert -> cache with singleflight + distributed lock
  try {
    const info = await singleflight(cacheKey, async () => {
      return await fetchWithRedisLock(cacheKey, ttlSeconds, async () => {
        const inn = c.get('innertubeSvc').getInnertube();
        const playlist = await inn.getPlaylist(playlistId);
        const basic: PlaylistInfo = {
          id: playlistId,
          title: String(playlist?.info?.title ?? ''),
          description: String(playlist?.info?.description ?? ''),
          subtitle: playlist?.info?.subtitle != null ? String(playlist.info.subtitle) : null,
          author: {
            id: playlist?.info?.author?.id,
            name: playlist?.info?.author?.name,
            url: playlist?.info?.author?.url,
          },
          videoCount: String(playlist?.info?.total_items ?? ''),
          viewCount: String(playlist?.info?.views ?? ''),
          lastUpdated: playlist?.info?.last_updated,
        };
        try { await upsertPlaylist(basic); } catch { /* noop */ }
        try { await redisSetJson(cacheKey, basic, jitterTtl(ttlSeconds)); } catch { /* noop */ }
        return basic;
      });
    });
    return { data: info };
  } catch (e) {
    const mapped = mapErrorToHttp(e);
    if (mapped.status >= 400 && mapped.status < 500 && mapped.code === ERROR_CODES.BAD_REQUEST) {
      const neg = makeNegativeCache(mapped.message || 'Bad Request', mapped.code, mapped.status);
      try { await redisSetJson(cacheKey, neg, jitterTtl(60)); } catch { /* noop */ }
    }
    return { __error: true, error: mapped.message || 'Internal Server Error', code: mapped.code, __status: mapped.status };
  }
}

// GET /v1/innertube/playlist?id=<playlistId|url>
v1InnertubePlaylistRouter.get('/', navigationMiddleware(), async (c: Context<AppSchema>) => {
  const requestId = c.get('requestId');
  const rawId = c.req.query('id');
  if (!rawId) return c.json({ error: 'Missing playlist id', code: ERROR_CODES.BAD_REQUEST }, 400);

  // Prefer resolved navigation endpoint when available
  const navigationEndpoint = c.get('navigationEndpoint') as any | undefined;
  // If the provided id represents a channel, derive uploads playlist id
  const maybeChannelId = navigationEndpoint?.payload?.browseId as string | undefined;
  const uploadsFromChannel = channelIdToUploads(maybeChannelId);

  // Otherwise, try playlist ids from navigation endpoint
  const resolvedPlaylistId = navigationEndpoint?.payload?.playlistId
    ?? navigationEndpoint?.payload?.listId
    ?? null;

  const playlistId = uploadsFromChannel ?? resolvedPlaylistId ?? extractPlaylistId(rawId);
  if (!playlistId) return c.json({ error: 'Invalid playlist id or URL', code: ERROR_CODES.BAD_REQUEST }, 400);

  try {
    const r = await fetchPlaylist(c, playlistId);
    if ((r as any).__error) {
      return c.json({ error: (r as any).error, code: (r as any).code }, (r as any).__status as any);
    }
    return c.json((r as any).data);
  } catch (err) {
    const isAbort = isClientAbort(err);
    if (isAbort) {
      logger.info('Request aborted by client', { playlistId, requestId });
      return c.json({ error: 'Client Closed Request', code: ERROR_CODES.CLIENT_CLOSED_REQUEST }, STATUS_CLIENT_CLOSED_REQUEST as any);
    }
    const mapped = mapErrorToHttp(err);
    logger.error('Error in /v1/innertube/playlist', { err, mapped, playlistId, requestId });
    return c.json({ error: mapped.message || 'Internal Server Error', code: mapped.code }, mapped.status as any);
  }
});

// GET /v1/innertube/playlist/videos?id=<playlistId|url|channelId>
v1InnertubePlaylistRouter.get('/videos', navigationMiddleware(), async (c: Context<AppSchema>) => {
  const requestId = c.get('requestId');
  const navigationEndpoint = c.get('navigationEndpoint') as any | undefined;
  // Accept channel browseId -> convert to uploads UU...
  const maybeChannelId = navigationEndpoint?.payload?.browseId as string | undefined;
  const uploadsFromChannel = channelIdToUploads(maybeChannelId);
  const resolvedPlaylistId = navigationEndpoint?.payload?.playlistId
    ?? navigationEndpoint?.payload?.listId
    ?? null;

  const rawId = c.req.query('id');
  const playlistId = uploadsFromChannel ?? resolvedPlaylistId ?? extractPlaylistId(rawId ?? '');
  if (!playlistId) return c.json({ error: 'Playlist ID not found', code: ERROR_CODES.BAD_REQUEST }, 400);

  type CacheShape = {
    items: ChannelVideo[];
    firstId: string | null;
    updatedAt: number;
    staleAt: number;
    ttlSeconds: number;
  };

  try {
    const cfg: any = c.get('config');
    const signal = c.get('signal') as AbortSignal | undefined;
    const { minDelayMs, maxDelayMs } = readBatchThrottle(cfg, { maxConcurrency: 2, minDelayFloorMs: 50 });
    const ttlSeconds = cfg.CHANNEL_CACHE_TTL_SECONDS as number; // reuse channel ttl policy

    const key = buildVideosCacheKey(playlistId);

    const result = await singleflight(key, async () => {
      const now = Date.now();
      const cached = await redisGetJson<CacheShape>(key).catch(() => null);
      if (cached && Array.isArray(cached.items)) {
        if (now < cached.staleAt) {
          logger.info('Playlist videos cache hit (fresh)', { playlistId, count: cached.items.length, requestId });
          return cached;
        }
        // Freshness check: re-fetch first page and compare first video id
        logger.info('Playlist videos cache stale; checking first page', { playlistId, count: cached.items.length, requestId });
        const inn = c.get('innertubeSvc').getInnertube();
        const first = await inn.getPlaylist(playlistId);
        const firstId = (first as any)?.videos?.[0]?.id || (first as any)?.videos?.[0]?.video_id || null;
        if (firstId && firstId === cached.firstId) {
          const extended: CacheShape = {
            ...cached,
            updatedAt: now,
            staleAt: now + ttlSeconds * 1000,
            ttlSeconds,
          };
          try { await redisSetJson(key, extended, jitterTtl(Math.max(ttlSeconds * 30, ttlSeconds + 1))); } catch { /* noop */ }
          logger.info('Playlist videos cache extended (no changes upstream)', { playlistId, requestId });
          return extended;
        }
        // Change detected -> fetch all pages
        const videos = await fetchAllPlaylistVideos(c, playlistId, { signal, requestId, minDelayMs, maxDelayMs });
        const next: CacheShape = {
          items: videos,
          firstId: videos[0]?.id ?? null,
          updatedAt: now,
          staleAt: now + ttlSeconds * 1000,
          ttlSeconds,
        };
        try { await redisSetJson(key, next, jitterTtl(Math.max(ttlSeconds * 30, ttlSeconds + 1))); } catch { /* noop */ }
        logger.info('Playlist videos cache updated (new video detected)', { playlistId, total: videos.length, requestId });
        return next;
      }

      // Miss -> fetch all pages and set
      const videos = await fetchWithRedisLock(key, ttlSeconds, async () => {
        const fetched = await fetchAllPlaylistVideos(c, playlistId, { signal, requestId, minDelayMs, maxDelayMs });
        const payload: CacheShape = {
          items: fetched,
          firstId: fetched[0]?.id ?? null,
          updatedAt: now,
          staleAt: now + ttlSeconds * 1000,
          ttlSeconds,
        };
        try { await redisSetJson(key, payload, jitterTtl(Math.max(ttlSeconds * 30, ttlSeconds + 1))); } catch { /* noop */ }
        logger.info('Playlist videos cache populated (miss)', { playlistId, total: fetched.length, requestId });
        return payload;
      }, 4000);
      return videos;
    });

    return c.json(result.items);
  } catch (err) {
    const mapped = mapErrorToHttp(err);
    logger.error('Error in /v1/innertube/playlist/videos', { err, mapped, playlistId, requestId });
    return c.json({ error: mapped.message || 'Internal Server Error', code: mapped.code }, mapped.status as any);
  }
});

// Helper to map raw youtubei.js Playlist video nodes to ChannelVideo shape
async function fetchAllPlaylistVideos(
  c: Context<AppSchema>,
  playlistId: string,
  opts?: { signal?: AbortSignal; requestId?: string; minDelayMs?: number; maxDelayMs?: number; limit?: number }
): Promise<ChannelVideo[]> {
  const inn = c.get('innertubeSvc').getInnertube();
  const minDelayMs = Math.max(0, opts?.minDelayMs ?? 50);
  const maxDelayMs = Math.max(minDelayMs, opts?.maxDelayMs ?? 150);
  const limit = Math.max(30, Math.min(5000, Math.floor(opts?.limit ?? 5000)));

  const pl: any = await inn.getPlaylist(playlistId);
  let page: any = pl;

  const mapVideo = (v: any): ChannelVideo => ({
    id: v?.id || v?.video_id || '',
    type: v?.type || 'Video',
    title: v?.title?.toString?.() ?? v?.title ?? '',
    duration: v?.duration?.toString?.() ?? v?.length_text?.text ?? '0:00',
    published: v?.published?.text ?? v?.published ?? '',
    viewCount: v?.short_view_count?.text ?? v?.view_count ?? '',
  });

  const items: ChannelVideo[] = Array.isArray(page?.videos) ? page.videos.map(mapVideo) : [];
  const seen = new Set<string>(items.map(v => v.id).filter(Boolean));
  if (items.length >= limit) return items.slice(0, limit);

  // Iterate continuations
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (opts?.signal?.aborted) {
      const e: any = new Error('AbortError'); e.name = 'AbortError'; throw e;
    }
    if (!page?.has_continuation) break;

    const delay = Math.floor(Math.random() * (maxDelayMs - minDelayMs + 1)) + minDelayMs;
    await new Promise((res) => setTimeout(res, delay));
    if (opts?.signal?.aborted) { const e: any = new Error('AbortError'); e.name = 'AbortError'; throw e; }

    try {
      const next = await page.getContinuation();
      const nextVideos: any[] = Array.isArray(next?.videos) ? next.videos : [];
      let added = 0;
      for (const v of nextVideos.map(mapVideo)) {
        if (v.id && !seen.has(v.id)) {
          seen.add(v.id);
          items.push(v);
          added++;
          if (items.length >= limit) break;
        }
      }
      page = next;
      if (items.length >= limit || added === 0 || nextVideos.length === 0) break;
    } catch (e) {
      // Log and stop on continuation failure
      const mapped = mapErrorToHttp(e);
      logger.warn('fetchAllPlaylistVideos:failed-continuation', { playlistId, mapped, requestId: opts?.requestId });
      break;
    }
  }

  return items.slice(0, limit);
}
