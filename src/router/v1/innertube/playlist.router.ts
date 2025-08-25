import { Hono } from "hono";
import type { Context } from "hono";
import type { AppSchema } from "@/app";
import { createLogger } from "@/lib/logger.lib";
import { ERROR_CODES, STATUS_CLIENT_CLOSED_REQUEST, isClientAbort, mapErrorToHttp } from "@/lib/hono.util";
import { swrResolve } from "@/lib/cache.util";
import type { SwrResult } from "@/lib/cache.util";
import { redisMGetJson } from '@/lib/redis.lib';
import { navigationMiddleware } from "@/middleware/navigation.middleware";
import { InnertubeService, type ChannelVideo } from "@/service/innertube.service";
import { readBatchThrottle } from "@/lib/throttle.util";
import { getPlaylistById, upsertPlaylist, type PlaylistInfo } from "@/service/playlist.service";
import { z } from 'zod';
import { navigationBatchMiddleware } from '@/middleware/navigation-batch.middleware';
import { processBatchIds } from '@/lib/batch.util';
import { parseCount } from '@/helper/channel.helper';

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

async function fetchPlaylist(c: Context<AppSchema>, playlistId: string): Promise<SwrResult<PlaylistInfo>> {
  const ttlSeconds = c.get('config').VIDEO_CACHE_TTL_SECONDS as number; // reuse video TTL
  const cacheKey = buildCacheKey(playlistId);

  const result = await swrResolve<PlaylistInfo, { playlist: PlaylistInfo; updatedAt: Date }>({
    cacheKey,
    ttlSeconds,
    serveStale: false,
    getFromDb: async () => await getPlaylistById(playlistId),
    dbUpdatedAt: (db) => db.updatedAt,
    assembleFromDb: async (dbRes) => dbRes.playlist,
    fetchPersist: async () => {
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
        videoCount: parseCount(playlist?.info?.total_items ?? ''),
        viewCount: parseCount(playlist?.info?.views ?? ''),
        lastUpdated: playlist?.info?.last_updated,
      };
      try { await upsertPlaylist(basic); } catch { /* noop */ }
      return basic;
    },
    shouldNegativeCache: (status, code) => (status >= 400 && status < 500 && code === ERROR_CODES.BAD_REQUEST),
  });

  return result;
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

  try {
    const cfg: any = c.get('config');
    const signal = c.get('signal') as AbortSignal | undefined;
    const { minDelayMs, maxDelayMs } = readBatchThrottle(cfg, { maxConcurrency: 2, minDelayFloorMs: 50 });
    const ttlSeconds = cfg.CHANNEL_CACHE_TTL_SECONDS as number; // reuse channel ttl policy

    const innSvc = c.get('innertubeSvc') as InnertubeService;
    const items = await innSvc.getPlaylistVideos(playlistId, { signal, requestId, minDelayMs, maxDelayMs, limit: 5000, ttlSeconds });
    return c.json(items);
  } catch (err) {
    const mapped = mapErrorToHttp(err);
    logger.error('Error in /v1/innertube/playlist/videos', { err, mapped, playlistId, requestId });
    return c.json({ error: mapped.message || 'Internal Server Error', code: mapped.code }, mapped.status as any);
  }
});

// POST /v1/innertube/playlist/batch
v1InnertubePlaylistRouter.post('/batch', navigationBatchMiddleware(), async (c: Context<AppSchema>) => {
  const requestId = c.get('requestId');
  const BodySchema = z.object({
    ids: z.array(z.string().trim().min(1, 'Invalid playlist id')).min(1, 'ids must not be empty').max(50, 'Max 50 ids per request'),
  });

  const ctxIds = c.get('batchIds') as string[] | undefined;
  let ids: string[];
  if (Array.isArray(ctxIds) && ctxIds.length > 0) {
    ids = ctxIds;
  } else {
    let body: unknown;
    try { body = await c.req.json(); } catch {
      logger.warn('Invalid JSON body for /v1/innertube/playlist/batch', { requestId });
      return c.json({ error: 'Invalid JSON body', code: ERROR_CODES.BAD_REQUEST }, 400);
    }
    const parsed = BodySchema.safeParse(body);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const msg = first?.message || 'Bad Request';
      logger.warn('Invalid body for /v1/innertube/playlist/batch', { issues: parsed.error.issues, requestId });
      return c.json({ error: msg, code: ERROR_CODES.BAD_REQUEST }, 400);
    }
    ids = parsed.data.ids;
  }

  try {
    const results = await processBatchIds(c, ids, {
      extractEntityId: (c0, id) => {
        const urlById = c0.get('batchUrlById') as Map<string, string | null> | undefined;
        const endpointMap = c0.get('navigationEndpointMap') as Map<string, any> | undefined;
        const url = urlById?.get(id) ?? null;
        if (endpointMap && url !== null) {
          if (!url) return { ok: false, error: 'Only YouTube channel/video URL, channelId, handle, or videoId are allowed', code: ERROR_CODES.BAD_REQUEST } as const;
          const ep = endpointMap.get(url);
          if (!ep) return { ok: false, error: 'Playlist ID not found', code: ERROR_CODES.BAD_REQUEST } as const;
          if ((ep as any).__error) return { ok: false, error: (ep as any).message, code: (ep as any).code } as const;
          const payload = (ep as any)?.payload || {};
          const pid = (payload.playlistId as string | undefined) ?? (payload.listId as string | undefined) ?? null;
          if (pid && typeof pid === 'string') return { ok: true, entityId: pid } as const;
          const uploads = channelIdToUploads(payload.browseId as string | undefined);
          if (uploads) return { ok: true, entityId: uploads } as const;
          return { ok: false, error: 'Playlist ID not found', code: ERROR_CODES.BAD_REQUEST } as const;
        }
        const pid = extractPlaylistId(id);
        if (pid) return { ok: true, entityId: pid } as const;
        return { ok: false, error: 'Invalid playlist id or URL', code: ERROR_CODES.BAD_REQUEST } as const;
      },
      fetchOne: (entityId: string) => fetchPlaylist(c, entityId) as any,
      getCachedManyByEntityId: async (entityIds) => {
        const keys = entityIds.map((eid) => buildCacheKey(eid));
        const m = await redisMGetJson<any>(keys);
        const out = new Map<string, any>();
        for (const eid of entityIds) {
          const val = m.get(buildCacheKey(eid));
          if (val) out.set(eid, val);
        }
        logger.debug('Playlist batch cache pre-check', {
          requested: entityIds.length,
          hits: out.size,
          requestId: c.get('requestId'),
        });
        return out;
      },
    });
    logger.info('Playlist batch processed', { count: ids.length, requestId });
    return c.json(results);
  } catch (err) {
    const mapped = mapErrorToHttp(err);
    logger.error('Error in /v1/innertube/playlist/batch', { err, mapped, requestId });
    return c.json({ error: mapped.message || 'Internal Server Error', code: mapped.code }, mapped.status as any);
  }
});
