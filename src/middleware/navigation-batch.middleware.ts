import type { MiddlewareHandler } from "hono";
import type { AppSchema } from "@/app";
import type { Context, Next } from "hono";
import { createLogger } from "@/lib/logger.lib";
import { BatchIdsSchema } from '@/schema/navigation.schema';
import { ERROR_CODES, mapErrorToHttp } from "@/lib/hono.util";
import { buildYoutubeUrlFromId, resolveNavigationWithCache, buildNavigationCacheKey } from "@/helper/navigation.helper";
import { throttleMap, readBatchThrottle, dedupeOrdered } from "@/lib/throttle.util";
import type { NavigationMapValue } from '@/types/navigation.types';
import { redisGetJson } from "@/lib/redis.lib";

const logger = createLogger('middleware:navigation-batch');

export function navigationBatchMiddleware(): MiddlewareHandler<AppSchema> {
  return async (c: Context<AppSchema>, next: Next) => {
    // Read ids from JSON body; we will place parsed values into context
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      // Defer invalid JSON handling to the route if needed
      rawBody = undefined;
    }
    const requestId = c.get('requestId');

    const maybeIds = (rawBody as any)?.ids as unknown;
    if (Array.isArray(maybeIds)) {
      const innertubeSvc = c.get('innertubeSvc');
      if (!innertubeSvc) return c.json({ error: 'InnertubeService not found' }, 500);

      const parsed = BatchIdsSchema.safeParse({ ids: maybeIds });
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        const msg = first.message || 'Bad Request';
        return c.json({ error: msg, code: ERROR_CODES.BAD_REQUEST }, 400);
      }

      const { ids } = parsed.data;
      const uniqueIds = dedupeOrdered(ids);
      c.set('batchIds', uniqueIds);

      // Map each input id to its canonical URL (or null if unsupported)
      const urlById = new Map<string, string | null>();
      for (const id of uniqueIds) {
        const url = buildYoutubeUrlFromId(id) ?? null;
        urlById.set(id, url);
      }
      c.set('batchUrlById', urlById);

      // Build unique list of resolvable URLs only
      const urls = uniqueIds
        .map((id) => urlById.get(id))
        .filter((url): url is string => typeof url === 'string' && url.length > 0);
      const uniqueUrls: string[] = dedupeOrdered(urls);

      if (uniqueUrls.length === 0) {
        return c.json({ error: 'Only YouTube channel/video URL, channelId, handle, or videoId are allowed', code: ERROR_CODES.BAD_REQUEST }, 400);
      }

      try {
        const cfg: any = c.get('config');
        const endpointMap = new Map<string, NavigationMapValue | any>();

        // Fast path: pre-check cache to avoid throttling when fully cached
        const misses: string[] = [];
        await Promise.all(
          uniqueUrls.map(async (url) => {
            const key = buildNavigationCacheKey(url);
            const cached = await redisGetJson<any>(key).catch(() => null);
            if (cached) {
              endpointMap.set(url, cached);
            } else {
              misses.push(url);
            }
          })
        );

        if (misses.length === 0) {
          logger.debug('Resolved URLs entirely from cache (no throttle)', { count: uniqueUrls.length, requestId });
          c.set('navigationEndpointMap', endpointMap);
        } else {
          logger.debug('Resolve URLs (throttled for cache misses)', { urlsCount: uniqueUrls.length, misses: misses.length, requestId });
          const { concurrency, minDelayMs, maxDelayMs } = readBatchThrottle(cfg, { maxConcurrency: 5, minDelayFloorMs: 50 });
          const results = await throttleMap<string, NavigationMapValue | any>(
            misses,
            async (url: string) => {
              try {
                return await resolveNavigationWithCache(innertubeSvc.getInnertube(), url, cfg);
              } catch (e) {
                const mapped = mapErrorToHttp(e);
                // Return an error object to be handled per-id downstream
                return { __error: true, message: mapped.message || 'Internal Server Error', code: mapped.code, status: mapped.status };
              }
            },
            { concurrency, minDelayMs, maxDelayMs, signal: c.get('signal') as any }
          );
          for (let i = 0; i < misses.length; i++) {
            endpointMap.set(misses[i], results[i]);
          }
          logger.debug('Resolved URLs (cache hits + fetched misses)', { total: uniqueUrls.length, hits: uniqueUrls.length - misses.length, misses: misses.length, requestId });
          c.set('navigationEndpointMap', endpointMap);
        }
      } catch (err) {
        const mapped = mapErrorToHttp(err);
        // Log and continue; downstream will resolve per-id as needed
        logger.error('Batch resolve aborted/failure at throttle level; downstream may fallback per-id', { err, mapped, requestId });
      }
    }

    return await next();
  };
}