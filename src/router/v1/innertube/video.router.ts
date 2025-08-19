import { createLogger } from '@/lib/logger.lib';
import { HttpError } from '@/lib/http.lib';
import { Context, Hono } from 'hono';
import type { AppSchema } from '@/app';
import { isClientAbort, STATUS_CLIENT_CLOSED_REQUEST, mapErrorToHttp, ERROR_CODES } from '@/lib/hono.util';
import { z } from 'zod';
import { upsertVideo, getVideoById } from '@/service/video.service';
import { redisGetJson, redisSetJson } from '@/lib/redis.lib';
import { jitterTtl, singleflight, fetchWithRedisLock, isNegativeCache, makeNegativeCache } from '@/lib/cache.util';

export const v1InnertubeVideoRouter = new Hono<AppSchema>();
const logger = createLogger('router:v1:innertube:video');
logger.debug('Initializing /v1/innertube/video router');

function buildCacheKey(videoId: string) {
  return `yt:video:${videoId}`;
}

v1InnertubeVideoRouter.get('/', async (c: Context<AppSchema>) => {
  const rawId = c.req.query('v');
  const requestId = c.get('requestId');

  const QuerySchema = z.object({
    v: z.string().trim().min(1, 'Missing video id'),
  });

  const parsed = QuerySchema.safeParse({ v: rawId });
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const msg = first.message || 'Bad Request';
    logger.warn('Invalid query parameters for /v1/innertube/video', { issues: parsed.error.issues, requestId });
    return c.json({ error: msg, code: ERROR_CODES.BAD_REQUEST }, 400);
  }

  const videoId = parsed.data.v;
  const cacheKey = buildCacheKey(videoId);
  const ttlSeconds = c.get('config').VIDEO_CACHE_TTL_SECONDS;

  try {
    // Attempt cache read first
    const cached = await redisGetJson<any>(cacheKey);
    if (cached) {
      logger.info('Cache hit for video', { videoId, requestId });
      if (isNegativeCache(cached)) return c.json({ error: cached.error, code: cached.code }, (cached.__status as any) ?? 400);
      return c.json(cached);
    }

    // Cache miss: consult DB
    try {
      const dbRes = await getVideoById(videoId);
      if (dbRes) {
        const now = Date.now();
        const updatedAtMs = new Date(dbRes.updatedAt).getTime();
        const ageSeconds = Math.max(0, Math.floor((now - updatedAtMs) / 1000));
        if (ageSeconds < ttlSeconds) {
          const remaining = Math.max(1, ttlSeconds - ageSeconds);
          // Warm cache with remaining TTL (non-fatal)
          try {
            await redisSetJson(cacheKey, dbRes.video, jitterTtl(remaining));
            logger.debug('Video cached from DB', { videoId, remaining, requestId });
          } catch (cacheErrDb) {
            logger.error('Video caching from DB failed', { videoId, requestId, error: cacheErrDb });
          }
          logger.info('DB hit within TTL for video', { videoId, ageSeconds, remaining, requestId });
          return c.json(dbRes.video);
        }
        logger.info('DB hit but stale; will fetch YouTube (SWR)', { videoId, ageSeconds, ttlSeconds, requestId });
        // Serve stale then refresh in background
        const stale = dbRes.video;
        // fire-and-forget background refresh
        void (async () => {
          const fetchKey = cacheKey;
          try {
            await fetchWithRedisLock(fetchKey, ttlSeconds, async () => {
              const info = await c.get('innertubeSvc').getVideoInfo(videoId, { signal: c.get('signal'), requestId });
              try { await upsertVideo(info); } catch { }
              try { await redisSetJson(fetchKey, info, jitterTtl(ttlSeconds)); } catch { }
              return info;
            });
          } catch (e) {
            const mapped = mapErrorToHttp(e);
            if (mapped.status >= 400 && mapped.status < 500) {
              const neg = makeNegativeCache(mapped.message || 'Bad Request', ERROR_CODES.BAD_REQUEST, mapped.status);
              try { await redisSetJson(fetchKey, neg, jitterTtl(60)); } catch { }
            }
          }
        })();
        return c.json(stale);
      } else {
        logger.debug('DB miss for video', { videoId, requestId });
      }
    } catch (dbErr) {
      logger.error('DB check failed; continuing to fetch from YouTube', { videoId, requestId, error: dbErr });
    }

    // 3) Fetch -> Persist -> Cache (singleflight + distributed lock)
    const fetchKey = cacheKey;
    const info = await singleflight(fetchKey, async () => {
      return await fetchWithRedisLock(fetchKey, ttlSeconds, async () => {
        const r = await c.get('innertubeSvc').getVideoInfo(videoId, { signal: c.get('signal'), requestId });
        try { await upsertVideo(r); } catch { }
        try { await redisSetJson(fetchKey, r, jitterTtl(ttlSeconds)); } catch { }
        return r;
      });
    });

    return c.json(info);
  } catch (err) {
    // Map client aborts to 499 (Client Closed Request). Hono doesn't have 499; use numeric.
    const isAbort = isClientAbort(err) || (err instanceof HttpError && (err as HttpError).code === 'EABORT');
    if (isAbort) {
      logger.info('Request aborted by client', { videoId, requestId });
      return c.json({ error: 'Client Closed Request', code: ERROR_CODES.CLIENT_CLOSED_REQUEST }, STATUS_CLIENT_CLOSED_REQUEST as any);
    }
    const mapped = mapErrorToHttp(err);
    // Negative cache for 4xx to reduce repeated work
    if (mapped.status >= 400 && mapped.status < 500) {
      const neg = makeNegativeCache(mapped.message || 'Bad Request', ERROR_CODES.BAD_REQUEST, mapped.status);
      try { await redisSetJson(cacheKey, neg, jitterTtl(60)); } catch { }
    }
    logger.error('Error in /v1/innertube/video', { err, mapped, videoId, requestId });
    return c.json({ error: mapped.message || 'Internal Server Error', code: mapped.code }, mapped.status as any);
  }
});


