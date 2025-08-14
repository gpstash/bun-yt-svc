import type { MiddlewareHandler } from "hono";
import { createLogger } from "@/lib/logger.lib";
import type { Context, Next } from "hono";
import type { AppSchema } from "@/app";
import { InnertubeService } from "@/service/innertube.service";

const logger = createLogger('middleware:innertube');

export function innertubeMiddleware(): MiddlewareHandler {
  return async (c: Context<AppSchema>, next: Next) => {
    const innertubeSvc = InnertubeService.getInstance();
    logger.debug('attach innertube service', {
      method: c.req.method,
      url: c.req.url,
    });
    c.set('innertubeSvc', innertubeSvc);
    return next();
  };
}