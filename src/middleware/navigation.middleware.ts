import type { MiddlewareHandler } from "hono";
import type { AppSchema } from "@/app";
import type { Context, Next } from "hono";
import { createLogger } from "@/lib/logger.lib";
import { SingleIdSchema } from '@/schema/navigation.schema';
import { ERROR_CODES, mapErrorToHttp } from "@/lib/hono.util";
import { buildYoutubeUrlFromId, resolveNavigationWithCache } from "@/helper/navigation.helper";

const logger = createLogger('middleware:navigation');

export function navigationMiddleware(): MiddlewareHandler<AppSchema> {
  return async (c: Context<AppSchema>, next: Next) => {
    const rawId = c.req.query('id');
    const requestId = c.get('requestId');

    if (rawId) {
      const innertubeSvc = c.get('innertubeSvc');
      if (!innertubeSvc) return c.json({ error: 'InnertubeService not found' }, 500);

      const parsed = SingleIdSchema.safeParse({ id: rawId });
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        const msg = first.message || 'Bad Request';
        return c.json({ error: msg, code: ERROR_CODES.BAD_REQUEST }, 400);
      }

      const { id } = parsed.data;
      const url = buildYoutubeUrlFromId(id);
      if (!url) {
        return c.json({ error: 'Only YouTube channel/video URL, channelId, handle, or videoId are allowed', code: ERROR_CODES.BAD_REQUEST }, 400);
      }

      try {
        logger.debug('Resolve URL', { url, requestId });
        const navigationEndpoint = await resolveNavigationWithCache(
          innertubeSvc.getInnertube(),
          url,
          c.get('config')
        );
        logger.debug('Resolved URL', { navigationEndpoint, requestId });
        c.set('navigationEndpoint', navigationEndpoint as any);
      } catch (err) {
        const mapped = mapErrorToHttp(err);
        logger.error('Error resolving navigation URL', { err, mapped, requestId });
        return c.json({ error: mapped.message || 'Internal Server Error', code: mapped.code }, mapped.status as any);
      }
    }

    return await next();
  };
}