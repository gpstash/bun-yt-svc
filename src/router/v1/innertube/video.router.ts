import { createLogger } from '@/lib/logger.lib';
import { HttpError } from '@/lib/http.lib';
import { Context, Hono } from 'hono';
import type { AppSchema } from '@/app';
import { isClientAbort, STATUS_CLIENT_CLOSED_REQUEST, mapErrorToHttp, ERROR_CODES } from '@/lib/hono.util';
import { z } from 'zod';
import { upsertVideo, getVideoById } from '@/service/video.service';
import { jitterTtl, swrResolve } from '@/lib/cache.util';
import { redisMGetJson } from '@/lib/redis.lib';
import { processBatchIds, extractFromNavigation } from '@/lib/batch.util';
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

type ResolveOptions = { swrOnStale?: boolean };

// Unified resolver via shared SWR helper
async function resolveVideo(c: Context<AppSchema>, videoId: string, opts: ResolveOptions = {}) {
  const requestId = c.get('requestId');
  const ttlSeconds = getTtlSeconds(c);
  const cacheKey = buildCacheKey(videoId);

  const result = await swrResolve<any, { video: any; updatedAt: Date | string }>({
    cacheKey,
    ttlSeconds,
    serveStale: !!opts.swrOnStale,
    getFromDb: async () => {
      try { return await getVideoById(videoId) as any; } catch { return null; }
    },
    dbUpdatedAt: (db) => db.updatedAt,
    assembleFromDb: async (db, remaining) => {
      logger.info('DB hit within TTL for video', { videoId, remaining, requestId });
      return db.video;
    },
    fetchPersist: async () => {
      logger.info('Fetching video from upstream', { videoId, requestId });
      const r = await c.get('innertubeSvc').getVideoInfo(videoId, { signal: c.get('signal'), requestId });
      try { await upsertVideo(r); } catch {/* noop */ }
      return r;
    },
    shouldNegativeCache: (status, code) => status >= 400 && status < 500 && code === ERROR_CODES.BAD_REQUEST,
  });
  return result as any;
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
    const results = await processBatchIds(c, ids, {
      extractEntityId: extractFromNavigation('videoId'),
      fetchOne: (entityId: string) => resolveVideo(c, entityId, { swrOnStale: false }) as any,
      getCachedManyByEntityId: async (entityIds) => {
        const keys = entityIds.map((eid) => buildCacheKey(eid));
        const m = await redisMGetJson<any>(keys);
        const out = new Map<string, any>();
        for (const eid of entityIds) {
          const val = m.get(buildCacheKey(eid));
          if (val) out.set(eid, val);
        }
        logger.debug('Video batch cache pre-check', {
          requested: entityIds.length,
          hits: out.size,
          requestId: c.get('requestId'),
        });
        return out;
      },
    });
    logger.info('Video batch processed', { count: ids.length, requestId });
    return c.json(results);
  } catch (err) {
    const mapped = mapErrorToHttp(err);
    logger.error('Error in /v1/innertube/video/batch', { err, mapped, requestId });
    return c.json({ error: mapped.message || 'Internal Server Error', code: mapped.code }, mapped.status as any);
  }
});
