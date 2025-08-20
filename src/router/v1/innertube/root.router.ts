import { createLogger } from '@/lib/logger.lib';
import { Hono } from 'hono';
import type { AppSchema } from '@/app';
import { v1InnertubeVideoRouter } from './video.router';
import { v1InnertubeCaptionRouter } from './caption.router';
import { v1InnertubeTranscriptRouter } from './transcript.router';
import { v1InnertubeUtilsRouter } from './utils.router';
import { innertubeMiddleware } from '@/middleware/innertube.middleware';
import { navigationMiddleware } from '@/middleware/navigation.middleware';

export const v1InnertubeRootRouter = new Hono<AppSchema>();
const logger = createLogger('router:v1:innertube');
logger.debug('Initializing /v1/innertube router');

v1InnertubeRootRouter.use(innertubeMiddleware());
v1InnertubeRootRouter.use(navigationMiddleware());

logger.debug('Mount /utils router');
v1InnertubeRootRouter.route('/utils', v1InnertubeUtilsRouter);

logger.debug('Mount /video router');
v1InnertubeRootRouter.route('/video', v1InnertubeVideoRouter);

logger.debug('Mount /caption router');
v1InnertubeRootRouter.route('/caption', v1InnertubeCaptionRouter);

logger.debug('Mount /transcript router');
v1InnertubeRootRouter.route('/transcript', v1InnertubeTranscriptRouter);
