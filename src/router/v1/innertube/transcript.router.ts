import { createLogger } from '@/lib/logger.lib';
import { HttpError } from '@/lib/http.lib';
import { Context, Hono } from 'hono';
import type { AppSchema } from '@/app';
import { isClientAbort, STATUS_CLIENT_CLOSED_REQUEST, mapErrorToHttp, ERROR_CODES } from '@/lib/hono.util';

export const v1InnertubeTranscriptRouter = new Hono<AppSchema>();
const logger = createLogger('router:v1:innertube:transcript');
logger.debug('Initializing /v1/innertube/transcript router');

v1InnertubeTranscriptRouter.get('/', async (c: Context<AppSchema>) => {
  const rawId = c.req.query('v');
  const language = c.req.query('l');
  const videoId = rawId?.trim();
  const requestId = c.get('requestId');

  if (!videoId) {
    logger.warn('Missing required query parameter', { param: 'v', requestId });
    return c.json({ error: 'Missing video id', code: ERROR_CODES.BAD_REQUEST }, 400);
  }

  try {
    const info = await c.get('innertubeSvc').getTranscript(videoId, language, { signal: c.get('signal'), requestId });
    return c.json(info);
  } catch (err) {
    const isAbort = isClientAbort(err) || (err instanceof HttpError && (err as HttpError).code === 'EABORT');
    if (isAbort) {
      logger.info('Request aborted by client', { videoId, language, requestId });
      return c.json({ error: 'Client Closed Request', code: ERROR_CODES.CLIENT_CLOSED_REQUEST }, STATUS_CLIENT_CLOSED_REQUEST as any);
    }
    const mapped = mapErrorToHttp(err);
    logger.error('Error in /v1/innertube/transcript', { err, mapped, videoId, language, requestId });
    return c.json({ error: mapped.message || 'Internal Server Error', code: mapped.code }, mapped.status as any);
  }
});

