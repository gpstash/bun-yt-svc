import type { MiddlewareHandler } from "hono";
import { createLogger } from "@/lib/logger.lib";
import type { Context, Next } from "hono";
import type { AppSchema } from "@/app";
import { InnertubeService } from "@/service/innertube.service";

const logger = createLogger('middleware:innertube');

export function innertubeMiddleware(): MiddlewareHandler {
  return async (c: Context<AppSchema>, next: Next) => {
    const innertubeSvc = await InnertubeService.getInstance();
    logger.debug('[innertubeMiddleware()] Attach InnertubeService instance to context', {
      method: c.req.method,
      url: c.req.url,
    });
    c.set('innertubeSvc', innertubeSvc);
    c.set('signal', c.req.raw.signal)
    return await next();
  };
}