import { createLogger } from "@/lib/logger.lib";
import type { MiddlewareHandler } from "hono";
import type { AppConfig } from "@/config";
import type { Context, Next } from "hono";
import type { AppSchema } from "@/app";

const logger = createLogger('middleware:config');

export function configMiddleware(config: AppConfig): MiddlewareHandler<AppSchema> {
  return (c: Context<AppSchema>, next: Next) => {
    logger.debug('Attach config', {
      method: c.req.method,
      url: c.req.url,
      appPort: config.APP_PORT,
      proxy: { status: config.PROXY_STATUS, host: config.PROXY_HOST, port: config.PROXY_PORT },
      logLevel: config.APP_LOG_LEVEL,
    });
    c.set('config', config);
    return next();
  };
}
