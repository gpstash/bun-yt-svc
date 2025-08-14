import { createLogger } from '@/lib/logger.lib';
import { HttpError } from '@/lib/http.lib';
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

  try {
    const info = await c.get('innertubeSvc').getTranscript(videoId, language, { signal: c.get('signal') });
    return c.json(info);
  } catch (err) {
    const isAbort = (err instanceof HttpError && (err as HttpError).code === 'EABORT') ||
      ((err as any)?.name === 'AbortError');
    if (isAbort) {
      logger.info('Request aborted by client', { videoId, language });
      return c.json({ error: 'Client Closed Request' }, 499 as any);
    }
    logger.error('Unexpected error in /v1/innertube/transcript', err);
    return c.json({ error: 'Internal Server Error' }, 500);
  }
});
