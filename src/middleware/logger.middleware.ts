import type { MiddlewareHandler } from "hono";
import { createLogger } from "@/lib/logger.lib";

const logger = createLogger('request');

function generateRequestId() {
  return crypto.randomUUID()
}

export function requestLogger(): MiddlewareHandler {
  return async (c, next) => {
    const id = generateRequestId();
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