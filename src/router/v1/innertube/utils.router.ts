import { Hono } from "hono";
import { AppSchema } from "@/app";
import { createLogger } from "@/lib/logger.lib";
import { Context } from "hono";
import { navigationMiddleware } from "@/middleware/navigation.middleware";

export const v1InnertubeUtilsRouter = new Hono<AppSchema>();
const logger = createLogger('router:v1:innertube:utils');
logger.debug('Initializing /v1/innertube/utils router');

v1InnertubeUtilsRouter.get('/resolve-url', navigationMiddleware(), async (c: Context<AppSchema>) => {
  return c.json(c.get('navigationEndpoint'));
});
