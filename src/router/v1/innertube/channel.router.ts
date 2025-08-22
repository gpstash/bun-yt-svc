import { Hono } from "hono";
import { AppSchema } from "@/app";
import { createLogger } from "@/lib/logger.lib";
import type { Context } from "hono";
import { ERROR_CODES, mapErrorToHttp, isClientAbort, STATUS_CLIENT_CLOSED_REQUEST } from "@/lib/hono.util";
import { redisGetJson, redisSetJson, redisMGetJson } from '@/lib/redis.lib';
import { jitterTtl, singleflight, fetchWithRedisLock, swrResolve } from '@/lib/cache.util';
import type { SwrResult } from '@/lib/cache.util';
import { upsertChannel, getChannelById } from '@/service/channel.service';
import type { ChannelVideo } from '@/service/innertube.service';
import type { ParsedChannelInfo } from '@/helper/channel.helper';
import { z } from 'zod';
import { readBatchThrottle } from '@/lib/throttle.util';
import type { ChannelBatchResponse } from '@/types/navigation.types';
import { navigationBatchMiddleware } from "@/middleware/navigation-batch.middleware";
import { navigationMiddleware } from "@/middleware/navigation.middleware";
import { processBatchIds, extractFromNavigation } from '@/lib/batch.util';

export const v1InnertubeChannelRouter = new Hono<AppSchema>();
const logger = createLogger('router:v1:innertube:channel');
logger.debug('Initializing /v1/innertube/channel router');

function buildCacheKey(channelId: string) {
  return `yt:channel:${channelId}`;
}

function buildVideosCacheKey(channelId: string) {
  return `yt:channel:${channelId}:videos`;
}

// Shared fetcher using swrResolve: cache -> DB (optionally serve-stale) -> fetch/persist/cache
async function fetchChannel(
  c: Context<AppSchema>,
  channelId: string,
  opts?: { serveStale?: boolean }
) : Promise<SwrResult<ParsedChannelInfo>> {
  const ttlSeconds = c.get('config').CHANNEL_CACHE_TTL_SECONDS as number;
  const cacheKey = buildCacheKey(channelId);

  const result = await swrResolve<ParsedChannelInfo, { channel: ParsedChannelInfo; updatedAt: Date }>({
    cacheKey,
    ttlSeconds,
    serveStale: !!opts?.serveStale,
    getFromDb: async () => await getChannelById(channelId),
    dbUpdatedAt: (db) => db.updatedAt,
    assembleFromDb: async (dbRes) => dbRes.channel,
    fetchPersist: async () => {
      const info = await c.get('innertubeSvc').getChannel(channelId);
      try { await upsertChannel(info); } catch { /* noop */ }
      return info;
    },
    shouldNegativeCache: (status, code) => (
      status >= 400 && status < 500 && (code === ERROR_CODES.BAD_REQUEST || status === 404)
    ),
  });

  return result;
}

// No local helpers; pagination lives in InnertubeService

v1InnertubeChannelRouter.get('/', navigationMiddleware(), async (c: Context<AppSchema>) => {
  const requestId = c.get('requestId');
  const navigationEndpoint = c.get('navigationEndpoint');
  const channelId = navigationEndpoint?.payload?.browseId;
  if (!channelId) return c.json({ error: 'Channel ID not found', code: ERROR_CODES.BAD_REQUEST }, 400);

  try {
    const r = await fetchChannel(c, channelId, { serveStale: true });
    if ((r as any).__error) {
      return c.json({ error: (r as any).error, code: (r as any).code }, (r as any).__status as any);
    }
    return c.json((r as any).data);
  } catch (err) {
    const isAbort = isClientAbort(err);
    if (isAbort) {
      logger.info('Request aborted by client', { channelId, requestId });
      return c.json({ error: 'Client Closed Request', code: ERROR_CODES.CLIENT_CLOSED_REQUEST }, STATUS_CLIENT_CLOSED_REQUEST as any);
    }
    const mapped = mapErrorToHttp(err);
    logger.error('Error in /v1/innertube/channel', { err, mapped, channelId, requestId });
    return c.json({ error: mapped.message || 'Internal Server Error', code: mapped.code }, mapped.status as any);
  }
});

v1InnertubeChannelRouter.get('/videos', navigationMiddleware(), async (c: Context<AppSchema>) => {
  const requestId = c.get('requestId');
  const navigationEndpoint = c.get('navigationEndpoint');
  const channelId = navigationEndpoint?.payload?.browseId;
  if (!channelId) return c.json({ error: 'Channel ID not found', code: ERROR_CODES.BAD_REQUEST }, 400);

  type CacheShape = {
    items: ChannelVideo[];
    firstId: string | null;
    updatedAt: number; // ms
    staleAt: number; // ms
    ttlSeconds: number; // policy TTL for staleness check
  };

  try {
    const cfg: any = c.get('config');
    const signal = c.get('signal') as AbortSignal | undefined;
    const { minDelayMs, maxDelayMs } = readBatchThrottle(cfg, { maxConcurrency: 2, minDelayFloorMs: 50 });
    const ttlSeconds = cfg.CHANNEL_CACHE_TTL_SECONDS as number; // reuse channel ttl as staleness policy

    const key = buildVideosCacheKey(channelId);

    const result = await singleflight(key, async () => {
      const now = Date.now();
      const cached = await redisGetJson<CacheShape>(key).catch(() => null);
      if (cached && Array.isArray(cached.items)) {
        // Fresh enough
        if (now < cached.staleAt) {
          logger.info('Channel videos cache hit (fresh)', { channelId, count: cached.items.length, requestId });
          return cached;
        }
        // Stale: quick freshness check via first page
        logger.info('Channel videos cache stale; checking first page', { channelId, count: cached.items.length, requestId });
        const firstPage = await c.get('innertubeSvc').getChannelVideosFirstPage(channelId, { signal, requestId });
        const upstreamFirstId = firstPage[0]?.id ?? null;
        if (upstreamFirstId && upstreamFirstId === cached.firstId) {
          // No change; extend staleness window
          const extended: CacheShape = {
            ...cached,
            updatedAt: now,
            staleAt: now + ttlSeconds * 1000,
            ttlSeconds,
          };
          // keep Redis value long-lived; extend moderately long (policy*30)
          try { await redisSetJson(key, extended, jitterTtl(Math.max(ttlSeconds * 30, ttlSeconds + 1))); } catch { /* noop */ }
          logger.info('Channel videos cache extended (no changes upstream)', { channelId, requestId });
          return extended;
        }
        // Change detected: fetch all and update cache
        const videos = await c.get('innertubeSvc').getChannelVideos(channelId, { signal, requestId, minDelayMs, maxDelayMs });
        const next: CacheShape = {
          items: videos,
          firstId: videos[0]?.id ?? null,
          updatedAt: now,
          staleAt: now + ttlSeconds * 1000,
          ttlSeconds,
        };
        try { await redisSetJson(key, next, jitterTtl(Math.max(ttlSeconds * 30, ttlSeconds + 1))); } catch { /* noop */ }
        logger.info('Channel videos cache updated (new video detected)', { channelId, total: videos.length, requestId });
        return next;
      }

      // No cache yet: fetch all then set
      const videos = await fetchWithRedisLock(key, ttlSeconds, async () => {
        const fetched = await c.get('innertubeSvc').getChannelVideos(channelId, { signal, requestId, minDelayMs, maxDelayMs });
        const payload: CacheShape = {
          items: fetched,
          firstId: fetched[0]?.id ?? null,
          updatedAt: now,
          staleAt: now + ttlSeconds * 1000,
          ttlSeconds,
        };
        try { await redisSetJson(key, payload, jitterTtl(Math.max(ttlSeconds * 30, ttlSeconds + 1))); } catch { /* noop */ }
        logger.info('Channel videos cache populated (miss)', { channelId, total: fetched.length, requestId });
        return payload;
      }, 4000);
      return videos;
    });

    return c.json(result.items);
  } catch (err) {
    const mapped = mapErrorToHttp(err);
    logger.error('Error in /v1/innertube/channel/videos', { err, mapped, channelId, requestId });
    return c.json({ error: mapped.message || 'Internal Server Error', code: mapped.code }, mapped.status as any);
  }
});

v1InnertubeChannelRouter.post('/batch', navigationBatchMiddleware(), async (c: Context<AppSchema>) => {
  const requestId = c.get('requestId');
  const BodySchema = z.object({
    ids: z.array(z.string().trim().min(1, 'Invalid channel id')).min(1, 'ids must not be empty').max(50, 'Max 50 ids per request'),
  });

  const ctxIds = c.get('batchIds');
  let ids: string[];
  if (Array.isArray(ctxIds) && ctxIds.length > 0) {
    ids = ctxIds;
  } else {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      logger.warn('Invalid JSON body for /v1/innertube/channel/batch', { requestId });
      return c.json({ error: 'Invalid JSON body', code: ERROR_CODES.BAD_REQUEST }, 400);
    }

    const parsed = BodySchema.safeParse(body);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const msg = first?.message || 'Bad Request';
      logger.warn('Invalid body for /v1/innertube/channel/batch', { issues: parsed.error.issues, requestId });
      return c.json({ error: msg, code: ERROR_CODES.BAD_REQUEST }, 400);
    }
    ids = parsed.data.ids;
  }

  try {
    const results = await processBatchIds(c, ids, {
      extractEntityId: extractFromNavigation('browseId'),
      fetchOne: (entityId: string) => fetchChannel(c, entityId, { serveStale: false }) as any,
      getCachedManyByEntityId: async (entityIds) => {
        const keys = entityIds.map((eid) => buildCacheKey(eid));
        const m = await redisMGetJson<any>(keys);
        const out = new Map<string, any>();
        for (const eid of entityIds) {
          const val = m.get(buildCacheKey(eid));
          if (val) out.set(eid, val);
        }
        logger.debug('Channel batch cache pre-check', {
          requested: entityIds.length,
          hits: out.size,
          requestId: c.get('requestId'),
        });
        return out;
      },
    });
    logger.info('Channel batch processed', { count: ids.length, requestId });
    return c.json(results as ChannelBatchResponse);
  } catch (err) {
    const mapped = mapErrorToHttp(err);
    logger.error('Error in /v1/innertube/channel/batch', { err, mapped, requestId });
    return c.json({ error: mapped.message || 'Internal Server Error', code: mapped.code }, mapped.status as any);
  }
});