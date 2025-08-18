import { createLogger } from '@/lib/logger.lib';
import { HttpError } from '@/lib/http.lib';
import { Context, Hono } from 'hono';
import type { AppSchema } from '@/app';
import { isClientAbort, STATUS_CLIENT_CLOSED_REQUEST, mapErrorToHttp, ERROR_CODES } from '@/lib/hono.util';
import { z } from 'zod';

export const v1InnertubeTranscriptRouter = new Hono<AppSchema>();
const logger = createLogger('router:v1:innertube:transcript');
logger.debug('Initializing /v1/innertube/transcript router');

v1InnertubeTranscriptRouter.get('/', async (c: Context<AppSchema>) => {
  const rawId = c.req.query('v');
  const l = c.req.query('l');
  const requestId = c.get('requestId');

  const QuerySchema = z
    .object({
      v: z.string().trim().min(1, 'Missing video id'),
      l: z.string().trim().optional(),
    })
    .superRefine((val, ctx) => {
      const langPattern = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
      if (val.l && !langPattern.test(val.l)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['l'], message: 'Invalid language' });
      }
    });

  const parsed = QuerySchema.safeParse({ v: rawId, l });
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const key = String(first.path[0] || '');
    const code = key === 'v' ? ERROR_CODES.BAD_REQUEST : ERROR_CODES.INVALID_LANGUAGE;
    const msg = first.message || 'Bad Request';
    logger.warn('Invalid query parameters for /v1/innertube/transcript', { issues: parsed.error.issues, requestId });
    return c.json({ error: msg, code }, 400);
  }

  const videoId = parsed.data.v;
  const language = parsed.data.l;

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


