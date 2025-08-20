import type { MiddlewareHandler } from "hono";
import type { AppSchema } from "@/app";
import type { Context, Next } from "hono";
import { createLogger } from "@/lib/logger.lib";
import z from 'zod';
import { ERROR_CODES, mapErrorToHttp } from "@/lib/hono.util";
import {
  isValidYoutubeChannelUrl,
  isValidYoutubeWatchUrl,
  isValidHandle,
  isValidChannelId,
  isValidVideoId,
  buildChannelUrlFromId,
  buildWatchUrlFromVideoId,
  buildChannelUrlFromHandle,
} from "@/helper/navigation.helper";
import { redisGetJson, redisSetJson } from '@/lib/redis.lib';
import { jitterTtl } from '@/lib/cache.util';

const logger = createLogger('middleware:navigation');

export function navigationMiddleware(): MiddlewareHandler<AppSchema> {
  return async (c: Context<AppSchema>, next: Next) => {
    const rawId = c.req.query('id');
    const requestId = c.get('requestId');

    if (rawId) {
      const innertubeSvc = c.get('innertubeSvc');
      if (!innertubeSvc) return c.json({ error: 'InnertubeService not found' }, 500);

      const QuerySchema = z.object({
        id: z.string().trim().min(1, 'Bad Request'),
      });

      const parsed = QuerySchema.safeParse({ id: rawId });
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        const msg = first.message || 'Bad Request';
        return c.json({ error: msg, code: ERROR_CODES.BAD_REQUEST }, 400);
      }

      const { id } = parsed.data;

      // Decide if id is a URL, channelId, videoId, or handle. If not a URL, build a proper URL.
      let url: string | null = null;
      const isIdIsAnUrl = isValidYoutubeChannelUrl(id) || isValidYoutubeWatchUrl(id);

      if (isIdIsAnUrl) {
        url = id;
      } else if (isValidChannelId(id)) {
        url = buildChannelUrlFromId(id)!;
      } else if (isValidVideoId(id)) {
        url = buildWatchUrlFromVideoId(id)!;
      } else if (isValidHandle(id)) {
        url = buildChannelUrlFromHandle(id)!;
      } else {
        return c.json({ error: 'Only YouTube channel/video URL, channelId, handle, or videoId are allowed', code: ERROR_CODES.BAD_REQUEST }, 400);
      }

      try {
        const isWatch = isValidYoutubeWatchUrl(url);
        const ttl = isWatch ? c.get('config').VIDEO_CACHE_TTL_SECONDS : c.get('config').CHANNEL_CACHE_TTL_SECONDS;
        const cacheKey = `yt:navigation:${isWatch ? 'watch' : 'channel'}:${url}`;

        // 1) cache first
        const cached = await redisGetJson<{ payload: any }>(cacheKey).catch(() => null);
        if (cached && cached.payload) {
          logger.debug('Navigation cache hit', { url, requestId });
          c.set('navigationEndpoint', { payload: cached.payload } as any);
          return await next();
        }

        // 2) resolve upstream, store only payload to keep it JSON-serializable
        logger.debug('Resolve URL', { url, requestId });
        const navigationEndpoint = await innertubeSvc.getInnertube().resolveURL(url);
        const payload = (navigationEndpoint as any)?.payload ?? null;
        logger.debug('Resolved URL', { requestId });
        if (payload) {
          try { await redisSetJson(cacheKey, { payload }, jitterTtl(ttl)); } catch { /* noop */ }
        }
        c.set('navigationEndpoint', payload ? ({ payload } as any) : navigationEndpoint);
      } catch (err) {
        const mapped = mapErrorToHttp(err);
        logger.error('Error resolving navigation URL', { err, mapped, requestId });
        return c.json({ error: mapped.message || 'Internal Server Error', code: mapped.code }, mapped.status as any);
      }
    }

    return await next();
  };
}