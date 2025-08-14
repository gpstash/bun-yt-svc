import { createLogger } from '@/lib/logger.lib';
import { Hono } from 'hono';
import type { AppSchema } from '@/app';

export const v1InnertubeCaptionRouter = new Hono<AppSchema>();
const logger = createLogger('router:v1:innertube:caption');
logger.debug('Initializing /v1/innertube/caption router');

v1InnertubeCaptionRouter.get('/', (c) => {
  return c.json({
    message: 'OK',
    timestamp: new Date().toISOString(),
  });
});
