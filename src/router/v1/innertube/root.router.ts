import { createLogger } from '@/lib/logger.lib';
import { Hono } from 'hono';
import type { AppSchema } from '@/app';
import { v1InnertubeVideoRouter } from './video.router';
import { v1InnertubeCaptionRouter } from './caption.router';
import { innertubeMiddleware } from '@/middleware/innertube.middleware';

export const v1InnertubeRootRouter = new Hono<AppSchema>();
const logger = createLogger('router:v1:innertube');
logger.info('Initializing /v1/innertube router');

v1InnertubeRootRouter.use(innertubeMiddleware());

logger.debug('Mount /video router');
v1InnertubeRootRouter.route('/video', v1InnertubeVideoRouter);

logger.debug('Mount /caption router');
v1InnertubeRootRouter.route('/caption', v1InnertubeCaptionRouter);
