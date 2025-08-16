import { createLogger } from '@/lib/logger.lib';
import { HttpError } from '@/lib/http.lib';
import { Context, Hono } from 'hono';
import type { AppSchema } from '@/app';
import { isClientAbort, STATUS_CLIENT_CLOSED_REQUEST, mapErrorToHttp, ERROR_CODES } from '@/lib/hono.util';

export const v1InnertubeVideoRouter = new Hono<AppSchema>();
const logger = createLogger('router:v1:innertube:video');
logger.debug('Initializing /v1/innertube/video router');

v1InnertubeVideoRouter.get('/', async (c: Context<AppSchema>) => {
  const rawId = c.req.query('v');
  const videoId = rawId?.trim();
  const requestId = c.get('requestId');

  if (!videoId) {
    logger.warn('Missing required query parameter', { param: 'v', requestId });
    return c.json({ error: 'Missing video id', code: ERROR_CODES.BAD_REQUEST }, 400);
  }

  try {
    const info = await c.get('innertubeSvc').getVideoInfo(videoId, { signal: c.get('signal'), requestId });
    return c.json(info);
  } catch (err) {
    // Map client aborts to 499 (Client Closed Request). Hono doesn't have 499; use numeric.
    const isAbort = isClientAbort(err) || (err instanceof HttpError && (err as HttpError).code === 'EABORT');
    if (isAbort) {
      logger.info('Request aborted by client', { videoId, requestId });
      return c.json({ error: 'Client Closed Request', code: ERROR_CODES.CLIENT_CLOSED_REQUEST }, STATUS_CLIENT_CLOSED_REQUEST as any);
    }
    const mapped = mapErrorToHttp(err);
    logger.error('Error in /v1/innertube/video', { err, mapped, videoId, requestId });
    return c.json({ error: mapped.message || 'Internal Server Error', code: mapped.code }, mapped.status as any);
  }
});

