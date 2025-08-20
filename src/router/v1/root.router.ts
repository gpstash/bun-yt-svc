import { createLogger } from '@/lib/logger.lib';
import { Hono } from 'hono';
import type { AppSchema } from '@/app';
import { v1InnertubeRootRouter } from '@/router/v1/innertube/root.router';

export const v1RootRouter = new Hono<AppSchema>();
const logger = createLogger('router:v1');
logger.debug('Initializing /v1 router');

logger.debug('Mount /innertube router');
v1RootRouter.route('/innertube', v1InnertubeRootRouter);
