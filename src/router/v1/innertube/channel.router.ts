import { Hono } from "hono";
import { YTNodes } from "youtubei.js"
import { AppSchema } from "@/app";
import { createLogger } from "@/lib/logger.lib";
import type { Context } from "hono";
import { ERROR_CODES, mapErrorToHttp, isClientAbort, STATUS_CLIENT_CLOSED_REQUEST } from "@/lib/hono.util";
import { redisGetJson, redisSetJson } from '@/lib/redis.lib';
import { jitterTtl, singleflight, fetchWithRedisLock, isNegativeCache, makeNegativeCache } from '@/lib/cache.util';
import { upsertChannel, getChannelById } from '@/service/channel.service';
import { z } from 'zod';
import { throttleMap, readBatchThrottle } from '@/lib/throttle.util';
import type { ChannelBatchResponse } from '@/types/navigation.types';
import { navigationBatchMiddleware } from "@/middleware/navigation-batch.middleware";
import { navigationMiddleware } from "@/middleware/navigation.middleware";

export const v1InnertubeChannelRouter = new Hono<AppSchema>();
const logger = createLogger('router:v1:innertube:channel');
logger.debug('Initializing /v1/innertube/channel router');

function buildCacheKey(channelId: string) {
  return `yt:channel:${channelId}`;
}

// Shared fetcher: cache -> DB (optionally serve-stale) -> fetch/persist/cache
async function fetchChannel(
  c: Context<AppSchema>,
  channelId: string,
  opts?: { serveStale?: boolean }
) {
  const requestId = c.get('requestId');
  const ttlSeconds = c.get('config').CHANNEL_CACHE_TTL_SECONDS;
  const cacheKey = buildCacheKey(channelId);

  // 1) Cache first
  const cached = await redisGetJson<any>(cacheKey).catch(() => undefined);
  if (cached) {
    logger.info('Cache hit for channel', { channelId, requestId });
    if (isNegativeCache(cached)) {
      return { __error: true, error: cached.error, code: cached.code, __status: (cached as any).__status ?? 400 };
    }
    return { data: cached };
  }

  // 2) DB next
  try {
    const dbRes = await getChannelById(channelId);
    if (dbRes) {
      const now = Date.now();
      const updatedAtMs = new Date(dbRes.updatedAt).getTime();
      const ageSeconds = Math.max(0, Math.floor((now - updatedAtMs) / 1000));
      if (ageSeconds < ttlSeconds) {
        const remaining = Math.max(1, ttlSeconds - ageSeconds);
        try { await redisSetJson(cacheKey, dbRes.channel, jitterTtl(remaining)); } catch { /* noop */ }
        logger.info('DB hit within TTL for channel', { channelId, ageSeconds, remaining, requestId });
        return { data: dbRes.channel };
      }
      // Serve stale and refresh in background if allowed
      if (opts?.serveStale) {
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
        return { data: stale };
      }
    }
  } catch {
    // Non-fatal
  }

  // 3) Fetch -> persist -> cache with singleflight + distributed lock
  try {
    const info = await singleflight(cacheKey, async () => {
      return await fetchWithRedisLock(cacheKey, ttlSeconds, async () => {
        const r = await c.get('innertubeSvc').getChannel(channelId);
        try { await upsertChannel(r); } catch { /* noop */ }
        try { await redisSetJson(cacheKey, r, jitterTtl(ttlSeconds)); } catch { /* noop */ }
        return r;
      });
    });
    return { data: info };
  } catch (e) {
    const mapped = mapErrorToHttp(e);
    if (
      (mapped.status >= 400 && mapped.status < 500 && mapped.code === ERROR_CODES.BAD_REQUEST) ||
      mapped.status === 404
    ) {
      const neg = makeNegativeCache(mapped.message || 'Bad Request', mapped.code, mapped.status);
      try { await redisSetJson(cacheKey, neg, jitterTtl(60)); } catch { /* noop */ }
    }
    return { __error: true, error: mapped.message || 'Internal Server Error', code: mapped.code, __status: mapped.status };
  }
}

// Local helpers for this router only
function sleep(ms: number) { return new Promise((res) => setTimeout(res, ms)); }
function rand(min: number, max: number) { return Math.floor(Math.random() * (max - min + 1)) + min; }

function mapGridVideos(videos: YTNodes.GridVideo[]) {
  return videos.map((video) => ({
    id: video.video_id,
    title: video.title?.text ?? '',
  }));
}

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
    const cacheKey = channelId ? `yt:channel:${channelId}` : undefined;
    const isAbort = isClientAbort(err);
    if (isAbort) {
      logger.info('Request aborted by client', { channelId, requestId });
      return c.json({ error: 'Client Closed Request', code: ERROR_CODES.CLIENT_CLOSED_REQUEST }, STATUS_CLIENT_CLOSED_REQUEST as any);
    }
    const mapped = mapErrorToHttp(err);
    if (cacheKey && mapped.status >= 400 && mapped.status < 500 && mapped.code === ERROR_CODES.BAD_REQUEST) {
      const neg = makeNegativeCache(mapped.message || 'Bad Request', mapped.code, mapped.status);
      try { await redisSetJson(cacheKey, neg, jitterTtl(60)); } catch { /* noop */ }
    }
    logger.error('Error in /v1/innertube/channel', { err, mapped, channelId, requestId });
    return c.json({ error: mapped.message || 'Internal Server Error', code: mapped.code }, mapped.status as any);
  }
});

v1InnertubeChannelRouter.get('/videos', navigationMiddleware(), async (c: Context<AppSchema>) => {
  const requestId = c.get('requestId');
  const navigationEndpoint = c.get('navigationEndpoint');
  const channelId = navigationEndpoint?.payload?.browseId;
  if (!channelId) return c.json({ error: 'Channel ID not found', code: ERROR_CODES.BAD_REQUEST }, 400);

  try {
    const cfg: any = c.get('config');
    const signal = c.get('signal') as AbortSignal | undefined;
    const { minDelayMs, maxDelayMs } = readBatchThrottle(cfg, { maxConcurrency: 2, minDelayFloorMs: 50 });

    const channel = await c.get('innertubeSvc').getInnertube().getChannel(channelId);
    let page: any = await channel.getVideos();

    const videos: { id: string; title: string; }[] = mapGridVideos(page.videos as YTNodes.GridVideo[]);
    const seen = new Set<string>(videos.map(v => v.id));

    // Track how many pages we loaded (for diagnostics)
    let pageCount = 1;

    // Loop through continuations until exhausted with retry/backoff for transient errors.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (signal?.aborted) {
        const abortErr: any = new Error('AbortError');
        abortErr.name = 'AbortError';
        throw abortErr;
      }
      // Stop if no continuation is available (avoid calling getContinuation() needlessly)
      const hasNext = Boolean((page as any)?.has_continuation ?? (page as any)?.continuation ?? (page as any)?.continuation_command);
      if (!hasNext) {
        logger.debug('No continuation available; stop paging', { channelId, pageCount, requestId });
        break;
      }
      const delay = rand(minDelayMs, maxDelayMs);
      logger.debug('Delaying before fetching channel videos continuation', { channelId, delay, page: pageCount + 1, requestId });
      await sleep(delay);
      if (signal?.aborted) {
        const abortErr: any = new Error('AbortError');
        abortErr.name = 'AbortError';
        throw abortErr;
      }

      // Per-page retry with backoff
      let attempt = 0;
      const maxAttempts = 3;
      let stopPaging = false;
      while (true) {
        try {
          const nextPage: any = await page.getContinuation();
          const contVideos = mapGridVideos(nextPage.videos as YTNodes.GridVideo[]);
          let added = 0;
          for (const v of contVideos) {
            if (!seen.has(v.id)) {
              seen.add(v.id);
              videos.push(v);
              added++;
            }
          }
          page = nextPage;
          pageCount++;
          logger.debug('Continuation page loaded', { channelId, pageCount, added, attempt, requestId });
          if (added === 0 || contVideos.length === 0) {
            // No new items; likely exhausted -> stop outer loop
            stopPaging = true;
          }
          // Try to continue outer loop
          break;
        } catch (e) {
          const mapped = mapErrorToHttp(e);
          const retriable = mapped.status === 429 || mapped.status === 408 || mapped.status >= 500;
          if (retriable && attempt < maxAttempts - 1 && !signal?.aborted) {
            attempt++;
            const backoff = Math.min(maxDelayMs * 2 ** attempt, maxDelayMs * 8);
            const jitter = rand(minDelayMs, backoff);
            logger.warn('Retrying continuation fetch with backoff', { channelId, attempt, jitter, status: mapped.status, requestId });
            await sleep(jitter);
            continue;
          }
          logger.warn('Failed fetching channel videos continuation; stop paging', { channelId, attempt, mapped, pageCount, requestId });
          // Non-retriable failure -> stop outer loop
          stopPaging = true;
          break;
        }
      }

      if (stopPaging) {
        break;
      }
    }

    return c.json({
      videos,
      total: videos.length,
    });
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
    const results: ChannelBatchResponse = {};
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
          results[id] = { error: 'Channel ID not found', code: ERROR_CODES.BAD_REQUEST };
          return;
        }
        if ((ep as any)?.__error) {
          results[id] = { error: (ep as any).message, code: (ep as any).code };
          return;
        }
        const channelId = (ep as any)?.payload?.browseId as string | undefined;
        if (!channelId) {
          results[id] = { error: 'Channel ID not found', code: ERROR_CODES.BAD_REQUEST };
          return;
        }

        const r = await fetchChannel(c, channelId, { serveStale: false });
        if ((r as any).__error) {
          results[id] = { error: (r as any).error, code: (r as any).code };
        } else {
          results[id] = (r as any).data;
        }
      },
      { concurrency, minDelayMs, maxDelayMs, signal: c.get('signal') as any }
    );

    logger.info('Channel batch processed', { count: ids.length, requestId });
    return c.json(results);
  } catch (err) {
    const mapped = mapErrorToHttp(err);
    logger.error('Error in /v1/innertube/channel/batch', { err, mapped, requestId });
    return c.json({ error: mapped.message || 'Internal Server Error', code: mapped.code }, mapped.status as any);
  }
});