import { createLogger } from '@/lib/logger.lib';
import { Context, Hono } from 'hono';
import type { AppSchema } from '@/app';

export const v1InnertubeTranscriptRouter = new Hono<AppSchema>();
const logger = createLogger('router:v1:innertube:transcript');
logger.debug('Initializing /v1/innertube/transcript router');

v1InnertubeTranscriptRouter.get('/', async (c: Context<AppSchema>) => {
  const rawId = c.req.query('v');
  const language = c.req.query('l');
  const videoId = rawId?.trim();

  if (!videoId) {
    return c.json({ error: 'Missing video id' }, 400);
  }

  const info = await c.get('innertubeSvc').getTranscript(videoId, language, { signal: c.get('signal') });
  return c.json(info);
});
