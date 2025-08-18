import { createLogger } from '@/lib/logger.lib';
import { HttpError } from '@/lib/http.lib';
import { Context, Hono } from 'hono';
import type { AppSchema } from '@/app';
import { isClientAbort, STATUS_CLIENT_CLOSED_REQUEST, mapErrorToHttp, ERROR_CODES } from '@/lib/hono.util';
import { z } from 'zod';
import { upsertVideo } from '@/service/video.service';
import { redisGetJson, redisSetJson } from '@/lib/redis.lib';

export const v1InnertubeVideoRouter = new Hono<AppSchema>();
const logger = createLogger('router:v1:innertube:video');
logger.debug('Initializing /v1/innertube/video router');

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
  const cacheKey = `yt:video:${videoId}`;
  const ttlSeconds = c.get('config').VIDEO_CACHE_TTL_SECONDS;

  try {
    // Attempt cache read first
    const cached = await redisGetJson<any>(cacheKey);
    if (cached) {
      logger.info('Cache hit for video', { videoId, requestId });
      return c.json(cached);
    }

    logger.info('Cache miss for video, fetching', { videoId, requestId });
    const info = await c.get('innertubeSvc').getVideoInfo(videoId, { signal: c.get('signal'), requestId });

    // Persist video info (non-fatal if it fails)
    try {
      const res = await upsertVideo(info);
      logger.info('Video upsert completed', { videoId, upserted: res.upserted, requestId });
    } catch (persistErr) {
      logger.error('Video upsert failed', { videoId, requestId, error: persistErr });
    }

    // Cache the result (non-fatal)
    try {
      await redisSetJson(cacheKey, info, ttlSeconds);
      logger.debug('Video cached', { videoId, ttlSeconds, requestId });
    } catch (cacheErr) {
      logger.error('Video caching failed', { videoId, requestId, error: cacheErr });
    }

    return c.json(info);
  } catch (err) {
    // Map client aborts to 499 (Client Closed Request). Hono doesn't have 499; use numeric.
    const isAbort = isClientAbort(err) || (err instanceof HttpError && (err as HttpError).code === 'EABORT');
    if (isAbort) {
      logger.info('Request aborted by client', { videoId, requestId });
      return c.json({ error: 'Client Closed Request', code: ERROR_CODES.CLIENT_CLOSED_REQUEST }, STATUS_CLIENT_CLOSED_REQUEST as any);
    }
    const mapped = mapErrorToHttp(err);
    logger.error('Error in /v1/innertube/video', { err, mapped, videoId, requestId });
    return c.json({ error: mapped.message || 'Internal Server Error', code: mapped.code }, mapped.status as any);
  }
});


