import type { MiddlewareHandler, Next } from "hono";
import { createLogger } from "@/lib/logger.lib";
import { AppSchema } from "@/app";
import { Context } from "hono";

const logger = createLogger('request');

export function requestLogger(): MiddlewareHandler<AppSchema> {
  return async (c: Context<AppSchema>, next: Next) => {
    const headerId = c.req.header('x-request-id') || undefined;
    const requestId = headerId && headerId.trim().length > 0 ? headerId.trim() : crypto.randomUUID();
    c.set('requestId', requestId as unknown as string);
    const start = Date.now();
    const method = c.req.method;
    const url = c.req.url;
    const userAgent = c.req.header('user-agent');

    try {
      logger.info('--- BEGIN REQUEST ---', { method, url, userAgent, requestId });
      await next();
    } catch (err) {
      logger.error('--- END REQUEST::ERROR ---', { method, url, error: err instanceof Error ? err.message : String(err), requestId });
      throw err;
    } finally {
      const durationMs = Date.now() - start;
      const status = c.res.status;
      const contentLength = c.res.headers.get('content-length') || undefined;
      logger.info('--- END REQUEST ---', { method, url, status, durationMs, contentLength, requestId });
    }
  };
}