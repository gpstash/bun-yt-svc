import { createLogger } from '@/lib/logger.lib';
import { HttpError } from '@/lib/http.lib';
import { Context, Hono } from 'hono';
import type { AppSchema } from '@/app';
import { isClientAbort, STATUS_CLIENT_CLOSED_REQUEST, mapErrorToHttp, ERROR_CODES } from '@/lib/hono.util';
import { z } from 'zod';
import { upsertVideo, getVideoById } from '@/service/video.service';
import { redisGetJson, redisSetJson } from '@/lib/redis.lib';
import { jitterTtl, singleflight, fetchWithRedisLock, isNegativeCache, makeNegativeCache } from '@/lib/cache.util';
import { throttleMap, readBatchThrottle } from '@/lib/throttle.util';
import { navigationMiddleware } from '@/middleware/navigation.middleware';
import { navigationBatchMiddleware } from '@/middleware/navigation-batch.middleware';

export const v1InnertubeVideoRouter = new Hono<AppSchema>();
const logger = createLogger('router:v1:innertube:video');
logger.debug('Initializing /v1/innertube/video router');

function buildCacheKey(videoId: string) {
  return `yt:video:${videoId}`;
}

// Helpers and unified resolution flow
function getTtlSeconds(c: Context<AppSchema>) {
  return c.get('config').VIDEO_CACHE_TTL_SECONDS as number;
}

function computeFreshness(updatedAt: Date | string, ttlSeconds: number) {
  const updatedAtMs = new Date(updatedAt).getTime();
  const ageSeconds = Math.max(0, Math.floor((Date.now() - updatedAtMs) / 1000));
  const isFresh = ageSeconds < ttlSeconds;
  const remaining = isFresh ? Math.max(1, ttlSeconds - ageSeconds) : 0;
  return { isFresh, remaining, ageSeconds };
}

async function warmCache(cacheKey: string, data: any, ttl: number, logCtx: Record<string, any>) {
  try {
    await redisSetJson(cacheKey, data, jitterTtl(ttl));
    logger.debug('Video cached from DB', logCtx);
  } catch (cacheErr) {
    logger.error('Video caching from DB failed', { ...logCtx, error: cacheErr });
  }
}

async function negativeCacheIfBadRequest(cacheKey: string, mapped: ReturnType<typeof mapErrorToHttp>, logCtx: Record<string, any>) {
  if (mapped.status >= 400 && mapped.status < 500 && mapped.code === ERROR_CODES.BAD_REQUEST) {
    const neg = makeNegativeCache(mapped.message || 'Bad Request', mapped.code, mapped.status);
    try {
      await redisSetJson(cacheKey, neg, jitterTtl(60));
      logger.debug('Negative-cache set for video', { ...logCtx, status: mapped.status, code: mapped.code });
    } catch {/* noop */ }
  }
}

type ResolveOptions = { swrOnStale?: boolean };

// Unified resolver: cache -> DB (fresh? serve, warm) -> if stale: SWR or fetch -> persist -> cache
async function resolveVideo(c: Context<AppSchema>, videoId: string, opts: ResolveOptions = {}) {
  const requestId = c.get('requestId');
  const ttlSeconds = getTtlSeconds(c);
  const cacheKey = buildCacheKey(videoId);

  // 1) Cache
  const cached = await redisGetJson<any>(cacheKey).catch(() => undefined);
  if (cached) {
    logger.info('Cache hit for video', { videoId, requestId });
    if (isNegativeCache(cached)) {
      return { __error: true, error: cached.error, code: cached.code, __status: (cached as any).__status ?? 400 };
    }
    return { data: cached };
  }
  logger.debug('Cache miss for video', { videoId, requestId, cacheKey });

  // 2) DB
  try {
    const dbRes = await getVideoById(videoId);
    if (dbRes) {
      const { isFresh, remaining, ageSeconds } = computeFreshness(dbRes.updatedAt, ttlSeconds);
      if (isFresh) {
        await warmCache(cacheKey, dbRes.video, remaining, { videoId, remaining, requestId });
        logger.info('DB hit within TTL for video', { videoId, ageSeconds, remaining, requestId });
        return { data: dbRes.video };
      }
      logger.info('DB hit but stale for video', { videoId, ageSeconds, ttlSeconds, requestId });

      // SWR: return stale and refresh in background
      if (opts.swrOnStale) {
        const stale = dbRes.video;
        void (async () => {
          try {
            await fetchWithRedisLock(cacheKey, ttlSeconds, async () => {
              const r = await c.get('innertubeSvc').getVideoInfo(videoId, { signal: c.get('signal'), requestId });
              try { await upsertVideo(r); } catch {/* noop */ }
              try { await redisSetJson(cacheKey, r, jitterTtl(ttlSeconds)); } catch {/* noop */ }
              return r;
            });
          } catch (e) {
            const mapped = mapErrorToHttp(e);
            await negativeCacheIfBadRequest(cacheKey, mapped, { videoId, requestId });
          }
        })();
        return { data: stale };
      }
      // Else fallthrough to fetch
    }
  } catch (dbErr) {
    logger.error('DB check failed; will continue to fetch', { videoId, requestId, error: dbErr });
  }

  // 3) Fetch -> persist -> cache (singleflight + distributed lock)
  try {
    logger.info('Fetching video from upstream', { videoId, requestId });
    const info = await singleflight(cacheKey, async () => {
      return await fetchWithRedisLock(cacheKey, ttlSeconds, async () => {
        const r = await c.get('innertubeSvc').getVideoInfo(videoId, { signal: c.get('signal'), requestId });
        try { await upsertVideo(r); } catch {/* noop */ }
        try { await redisSetJson(cacheKey, r, jitterTtl(ttlSeconds)); } catch {/* noop */ }
        return r;
      });
    });
    return { data: info };
  } catch (e) {
    const mapped = mapErrorToHttp(e);
    await negativeCacheIfBadRequest(cacheKey, mapped, { videoId, requestId });
    return { __error: true, error: mapped.message || 'Internal Server Error', code: mapped.code, __status: mapped.status };
  }
}

v1InnertubeVideoRouter.get('/', navigationMiddleware(), async (c: Context<AppSchema>) => {
  const requestId = c.get('requestId');

  // Prefer navigationMiddleware() resolution when id param is used
  const navigationEndpoint = c.get('navigationEndpoint');
  const videoId = navigationEndpoint?.payload?.videoId;

  if (!videoId) return c.json({ error: 'Missing video id', code: ERROR_CODES.BAD_REQUEST }, 400);

  try {
    const result = await resolveVideo(c, videoId, { swrOnStale: true });
    if ((result as any).__error) {
      const status = (result as any).__status ?? 500;
      return c.json({ error: (result as any).error, code: (result as any).code }, status as any);
    }
    return c.json((result as any).data);
  } catch (err) {
    // Map client aborts to 499 (Client Closed Request)
    const isAbort = isClientAbort(err) || (err instanceof HttpError && (err as HttpError).code === 'EABORT');
    if (isAbort) {
      logger.info('Request aborted by client', { videoId, requestId });
      return c.json({ error: 'Client Closed Request', code: ERROR_CODES.CLIENT_CLOSED_REQUEST }, STATUS_CLIENT_CLOSED_REQUEST as any);
    }
    const mapped = mapErrorToHttp(err);
    logger.error('Unhandled error in /v1/innertube/video', { err, mapped, videoId, requestId });
    return c.json({ error: mapped.message || 'Internal Server Error', code: mapped.code }, mapped.status as any);
  }
});

// POST /v1/innertube/video/batch
v1InnertubeVideoRouter.post('/batch', navigationBatchMiddleware(), async (c: Context<AppSchema>) => {
  const requestId = c.get('requestId');

  const BodySchema = z.object({
    ids: z.array(z.string().trim().min(1, 'Invalid video id')).min(1, 'ids must not be empty').max(50, 'Max 50 ids per request'),
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
      logger.warn('Invalid JSON body for /v1/innertube/video/batch', { requestId });
      return c.json({ error: 'Invalid JSON body', code: ERROR_CODES.BAD_REQUEST }, 400);
    }

    const parsed = BodySchema.safeParse(body);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const msg = first?.message || 'Bad Request';
      logger.warn('Invalid body for /v1/innertube/video/batch', { issues: parsed.error.issues, requestId });
      return c.json({ error: msg, code: ERROR_CODES.BAD_REQUEST }, 400);
    }
    ids = parsed.data.ids;
  }

  try {
    const results: Record<string, any> = {};

    // Shared throttling utility
    const cfg: any = c.get('config');
    const { concurrency, minDelayMs, maxDelayMs } = readBatchThrottle(cfg, { maxConcurrency: 5, minDelayFloorMs: 50 });

    await throttleMap(
      ids,
      async (id) => {
        const urlById = c.get('batchUrlById') as Map<string, string | null> | undefined;
        const endpointMap = c.get('navigationEndpointMap') as Map<string, any> | undefined;

        const url = urlById?.get(id) ?? null;
        if (!url) {
          results[id] = { error: 'Only YouTube channel/video URL, channelId, handle, or videoId are allowed', code: ERROR_CODES.BAD_REQUEST };
          return;
        }
        const ep = endpointMap?.get(url);
        if (!ep) {
          results[id] = { error: 'Video ID not found', code: ERROR_CODES.BAD_REQUEST };
          return;
        }
        if ((ep as any)?.__error) {
          results[id] = { error: (ep as any).message, code: (ep as any).code };
          return;
        }
        const videoId = (ep as any)?.payload?.videoId as string | undefined;
        if (!videoId) {
          results[id] = { error: 'Video ID not found', code: ERROR_CODES.BAD_REQUEST };
          return;
        }

        const r = await resolveVideo(c, videoId, { swrOnStale: false });
        if ((r as any).__error) {
          results[id] = { error: (r as any).error, code: (r as any).code };
        } else {
          results[id] = (r as any).data;
        }
      },
      { concurrency, minDelayMs, maxDelayMs, signal: c.get('signal') }
    );

    logger.info('Video batch processed', { count: ids.length, requestId });
    return c.json(results);
  } catch (err) {
    const mapped = mapErrorToHttp(err);
    logger.error('Error in /v1/innertube/video/batch', { err, mapped, requestId });
    return c.json({ error: mapped.message || 'Internal Server Error', code: mapped.code }, mapped.status as any);
  }
});
