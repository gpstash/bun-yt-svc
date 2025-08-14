import { createLogger } from '@/lib/logger.lib';
import { HttpError } from '@/lib/http.lib';
import { Context, Hono } from 'hono';
import type { AppSchema } from '@/app';

export const v1InnertubeVideoRouter = new Hono<AppSchema>();
const logger = createLogger('router:v1:innertube:video');
logger.debug('Initializing /v1/innertube/video router');

v1InnertubeVideoRouter.get('/', async (c: Context<AppSchema>) => {
  const rawId = c.req.query('v');
  const videoId = rawId?.trim();

  if (!videoId) {
    return c.json({ error: 'Missing video id' }, 400);
  }

  try {
    const info = await c.get('innertubeSvc').getVideoInfo(videoId, { signal: c.get('signal') });
    return c.json(info);
  } catch (err) {
    // Map client aborts to 499 (Client Closed Request). Hono doesn't have 499; use 499 numeric.
    const isAbort = (err instanceof HttpError && (err as HttpError).code === 'EABORT') ||
      ((err as any)?.name === 'AbortError');
    if (isAbort) {
      logger.info('Request aborted by client', { videoId });
      // 499 isn't in standard list, but Hono allows numeric. Fallback to 499 semantics.
      return c.json({ error: 'Client Closed Request' }, 499 as any);
    }
    logger.error('Unexpected error in /v1/innertube/video', err);
    return c.json({ error: 'Internal Server Error' }, 500);
  }
});
