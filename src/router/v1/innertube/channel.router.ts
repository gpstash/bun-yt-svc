import { Hono } from "hono";
import { AppSchema } from "@/app";
import { createLogger } from "@/lib/logger.lib";
import type { Context } from "hono";
import { ERROR_CODES, mapErrorToHttp, isClientAbort, STATUS_CLIENT_CLOSED_REQUEST } from "@/lib/hono.util";
import { redisGetJson, redisSetJson } from '@/lib/redis.lib';
import { jitterTtl, singleflight, fetchWithRedisLock, isNegativeCache, makeNegativeCache } from '@/lib/cache.util';
import { upsertChannel, getChannelById } from '@/service/channel.service';

export const v1InnertubeChannelRouter = new Hono<AppSchema>();
const logger = createLogger('router:v1:innertube:channel');
logger.debug('Initializing /v1/innertube/channel router');

v1InnertubeChannelRouter.get('/', async (c: Context<AppSchema>) => {
  try {
    const navigationEndpoint = c.get('navigationEndpoint');
    const channelId = navigationEndpoint?.payload?.browseId;
    if (!channelId) return c.json({ error: 'Channel ID not found', code: ERROR_CODES.BAD_REQUEST }, 400);
    const requestId = c.get('requestId');
    const ttlSeconds = c.get('config').CHANNEL_CACHE_TTL_SECONDS;
    const cacheKey = `yt:channel:${channelId}`;

    // 1) Cache first
    const cached = await redisGetJson<any>(cacheKey).catch(() => null);
    if (cached) {
      logger.info('Cache hit for channel', { channelId, requestId });
      if (isNegativeCache(cached)) return c.json({ error: cached.error, code: cached.code }, (cached as any).__status as any ?? 400);
      return c.json(cached);
    }

    // 2) DB fallback
    try {
      const dbRes = await getChannelById(channelId);
      if (dbRes) {
        const now = Date.now();
        const updatedAtMs = new Date(dbRes.updatedAt).getTime();
        const ageSeconds = Math.max(0, Math.floor((now - updatedAtMs) / 1000));
        if (ageSeconds < ttlSeconds) {
          const remaining = Math.max(1, ttlSeconds - ageSeconds);
          try { await redisSetJson(cacheKey, dbRes.channel, jitterTtl(remaining)); } catch { /* noop */ }
          logger.info('DB hit within TTL for channel', { channelId, ageSeconds, requestId });
          return c.json(dbRes.channel);
        }
        // Serve stale then refresh in background
        const stale = dbRes.channel;
        void (async () => {
          try {
            await fetchWithRedisLock(cacheKey, ttlSeconds, async () => {
              const info = await c.get('innertubeSvc').getChannel(channelId);
              try { await upsertChannel(info); } catch { /* noop */ }
              try { await redisSetJson(cacheKey, info, jitterTtl(ttlSeconds)); } catch { /* noop */ }
              return info;
            });
          } catch (e) {
            const mapped = mapErrorToHttp(e);
            if (mapped.status >= 400 && mapped.status < 500 && mapped.code === ERROR_CODES.BAD_REQUEST) {
              const neg = makeNegativeCache(mapped.message || 'Bad Request', mapped.code, mapped.status);
              try { await redisSetJson(cacheKey, neg, jitterTtl(60)); } catch { /* noop */ }
            }
          }
        })();
        return c.json(stale);
      }
    } catch (dbErr) {
      logger.warn('DB check failed; continuing to fetch from upstream', { channelId, requestId, error: dbErr });
    }

    // 3) Fetch -> persist -> cache (singleflight + distributed lock)
    const info = await singleflight(cacheKey, async () => {
      return await fetchWithRedisLock(cacheKey, ttlSeconds, async () => {
        const r = await c.get('innertubeSvc').getChannel(channelId);
        try { await upsertChannel(r); } catch { /* noop */ }
        try { await redisSetJson(cacheKey, r, jitterTtl(ttlSeconds)); } catch { /* noop */ }
        return r;
      });
    });
    return c.json(info);
  } catch (err) {
    const navigationEndpoint = c.get('navigationEndpoint');
    const channelId = navigationEndpoint?.payload?.browseId;
    const cacheKey = channelId ? `yt:channel:${channelId}` : undefined;
    const isAbort = isClientAbort(err);
    if (isAbort) {
      logger.info('Request aborted by client', { channelId });
      return c.json({ error: 'Client Closed Request', code: ERROR_CODES.CLIENT_CLOSED_REQUEST }, STATUS_CLIENT_CLOSED_REQUEST as any);
    }
    const mapped = mapErrorToHttp(err);
    if (cacheKey && mapped.status >= 400 && mapped.status < 500 && mapped.code === ERROR_CODES.BAD_REQUEST) {
      const neg = makeNegativeCache(mapped.message || 'Bad Request', mapped.code, mapped.status);
      try { await redisSetJson(cacheKey, neg, jitterTtl(60)); } catch { /* noop */ }
    }
    logger.error('Error in /v1/innertube/channel', { err, mapped, channelId });
    return c.json({ error: mapped.message || 'Internal Server Error', code: mapped.code }, mapped.status as any);
  }
});

