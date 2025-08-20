import type { MiddlewareHandler } from "hono";
import type { AppSchema } from "@/app";
import type { Context, Next } from "hono";
import { createLogger } from "@/lib/logger.lib";
import z from 'zod';
import { ERROR_CODES, mapErrorToHttp } from "@/lib/hono.util";

const logger = createLogger('middleware:navigation');

export function navigationMiddleware(): MiddlewareHandler<AppSchema> {
  return async (c: Context<AppSchema>, next: Next) => {
    const rawUrl = c.req.query('url');
    const requestId = c.get('requestId');

    if (rawUrl) {
      const innertubeSvc = c.get('innertubeSvc');
      if (!innertubeSvc) return c.json({ error: 'InnertubeService not found' }, 500);

      const QuerySchema = z.object({
        url: z
          .string()
          .trim()
          .url('Invalid url')
          .refine((u) => {
            try {
              const protocol = new URL(u).protocol;
              return protocol === 'http:' || protocol === 'https:';
            } catch {
              return false;
            }
          }, 'Only http(s) URLs are allowed')
          .refine((u) => {
            try {
              const host = new URL(u).hostname.toLowerCase();
              return (
                host === 'youtube.com' ||
                host.endsWith('.youtube.com') ||
                host === 'youtu.be'
              );
            } catch {
              return false;
            }
          }, 'Only YouTube URLs are allowed'),
      });

      const parsed = QuerySchema.safeParse({ url: rawUrl });
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        const msg = first.message || 'Bad Request';
        logger.warn('Invalid query parameters for /v1/innertube/resolve-url', { issues: parsed.error.issues, requestId });
        return c.json({ error: msg, code: ERROR_CODES.BAD_REQUEST }, 400);
      }

      const { url } = parsed.data;

      try {
        logger.debug('Resolve URL', { url });
        const navigationEndpoint = await innertubeSvc.getInnertube().resolveURL(url);
        logger.debug('Resolved URL', { navigationEndpoint });
        c.set('navigationEndpoint', navigationEndpoint);
      } catch (err) {
        const { status, ...body } = mapErrorToHttp(err);
        return c.json(body, status as any);
      }
    }

    return await next();
  };
}