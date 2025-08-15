import type { MiddlewareHandler, Next } from "hono";
import { createLogger } from "@/lib/logger.lib";
import { AppSchema } from "@/app";
import { Context } from "hono";

const logger = createLogger('request');

export function requestLogger(): MiddlewareHandler<AppSchema> {
  return async (c: Context<AppSchema>, next: Next) => {
    const headerId = c.req.header('x-requestid') || c.req.header('x-request-id') || undefined;
    const id = headerId && headerId.trim().length > 0 ? headerId.trim() : crypto.randomUUID();
    c.set('requestId', id as unknown as string);
    const start = Date.now();
    const method = c.req.method;
    const url = c.req.url;
    const userAgent = c.req.header('user-agent');

    logger.info('BEGIN', { id, method, url, userAgent });
    try {
      await next();
    } catch (err) {
      logger.error('ERROR', { id, method, url, error: err instanceof Error ? err.message : String(err) });
      throw err;
    } finally {
      const durationMs = Date.now() - start;
      const status = c.res.status;
      const contentLength = c.res.headers.get('content-length') || undefined;
      logger.info('END', { id, method, url, status, durationMs, contentLength });
    }
  };
}