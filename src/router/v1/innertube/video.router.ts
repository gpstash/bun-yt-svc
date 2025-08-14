import { createLogger } from '@/lib/logger.lib';
import { Context, Hono } from 'hono';
import type { AppSchema } from '@/app';

export const v1InnertubeVideoRouter = new Hono<AppSchema>();
const logger = createLogger('router:v1:innertube:video');
logger.info('Initializing /v1/innertube/video router');

v1InnertubeVideoRouter.get('/', async (c: Context<AppSchema>) => {
  const rawId = c.req.query('v');
  const videoId = rawId?.trim();

  if (!videoId) {
    return c.json({ error: 'Missing video id' }, 400);
  }

  const info = await c.get('innertubeSvc').getVideoInfo(videoId, true);
  return c.json(info);
});