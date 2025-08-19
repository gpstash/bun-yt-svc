import { createLogger } from '@/lib/logger.lib';
import { Context, Hono } from 'hono';
import type { AppSchema } from '@/app';
import { isClientAbort, STATUS_CLIENT_CLOSED_REQUEST, mapErrorToHttp, ERROR_CODES } from '@/lib/hono.util';
import { HttpError } from '@/lib/http.lib';
import { z } from 'zod';
import { redisGetJson, redisSetJson } from '@/lib/redis.lib';
import { getCaptionByVideoAndLanguage, hasCaptionLanguage, getPreferredCaptionLanguage, upsertCaption } from '@/service/caption.service';
import { getVideoById, upsertVideo } from '@/service/video.service';

export const v1InnertubeCaptionRouter = new Hono<AppSchema>();
const logger = createLogger('router:v1:innertube:caption');
logger.debug('Initializing /v1/innertube/caption router');

function buildCacheKey(videoId: string, language: string | undefined | null, translateLanguage?: string | null): string {
  const cacheLang = language ?? 'default';
  const tl = translateLanguage ? `:${translateLanguage}` : '';
  return `yt:caption:${videoId}:${cacheLang}${tl}`;
}

async function getAlias(videoId: string): Promise<string | null> {
  const aliasKey = `yt:caption:${videoId}:_alias`;
  const alias = await redisGetJson<string>(aliasKey);
  return typeof alias === 'string' ? alias : null;
}

async function setAlias(videoId: string, language: string, ttlSeconds: number): Promise<void> {
  const aliasKey = `yt:caption:${videoId}:_alias`;
  await redisSetJson(aliasKey, language, ttlSeconds);
}

async function resolveEffectiveLanguage(videoId: string, requestedLang: string | undefined | null, requestId?: string): Promise<{ effectiveLang: string; source: 'request' | 'alias' | 'db' | 'default' | 'fallback' }> {
  if (requestedLang && requestedLang.length > 0) {
    try {
      const available = await hasCaptionLanguage(videoId, requestedLang);
      if (available) {
        return { effectiveLang: requestedLang, source: 'request' };
      }
      const preferred = await getPreferredCaptionLanguage(videoId);
      if (preferred) {
        logger.info('Requested caption language not available, falling back to preferred', { videoId, requestedLang, fallback: preferred, requestId });
        return { effectiveLang: preferred, source: 'fallback' };
      }
    } catch (e) {
      logger.warn('Failed checking requested caption language availability; proceeding with other resolution', { videoId, requestedLang, requestId, error: e });
    }
  }
  try {
    const alias = await getAlias(videoId);
    if (alias) {
      logger.debug('Using caption alias language for cache/DB', { videoId, effectiveLang: alias, requestId });
      return { effectiveLang: alias, source: 'alias' };
    }
  } catch (aliasErr) {
    logger.warn('Failed to read caption alias language; proceeding without alias', { videoId, requestId, error: aliasErr });
  }
  try {
    const preferred = await getPreferredCaptionLanguage(videoId);
    if (preferred) {
      logger.debug('Derived effective caption language from video.caption_languages or oldest', { videoId, effectiveLang: preferred, requestId });
      return { effectiveLang: preferred, source: 'db' };
    }
  } catch (oldestErr) {
    logger.warn('Failed to derive oldest caption language from DB', { videoId, requestId, error: oldestErr });
  }
  return { effectiveLang: '', source: 'default' };
}

async function assembleFromDbAndCache(c: Context<AppSchema>, videoId: string, dbRes: { language: string; segments: Array<{ text: string }>; words: Array<{ text: string }>; updatedAt: Date; }, remainingTtl: number, translateLanguage?: string | null, requestId?: string) {
  const ttlSeconds = Math.max(1, remainingTtl);
  let videoDb = await getVideoById(videoId);
  if (!videoDb) {
    try {
      const videoInfo = await c.get('innertubeSvc').getVideoInfo(videoId, { signal: c.get('signal'), requestId });
      videoDb = { video: videoInfo, updatedAt: new Date() } as any;
    } catch (videoErr) {
      logger.error('Failed to get video info while assembling caption response', { videoId, requestId, error: videoErr });
    }
  }
  const textFromSegments = (dbRes.segments || []).map(s => s.text).join(' ').trim();

  const assembled = videoDb ? {
    ...videoDb.video,
    caption: {
      hascaption: (dbRes.segments?.length ?? 0) > 0 || (dbRes.words?.length ?? 0) > 0 || textFromSegments.length > 0,
      language: dbRes.language,
      segments: dbRes.segments,
      words: dbRes.words,
      text: textFromSegments,
    },
  } : {
    id: videoId,
    caption: {
      hascaption: (dbRes.segments?.length ?? 0) > 0 || (dbRes.words?.length ?? 0) > 0 || textFromSegments.length > 0,
      language: dbRes.language,
      segments: dbRes.segments,
      words: dbRes.words,
      text: textFromSegments,
    }
  } as any;

  const cacheKey = buildCacheKey(videoId, dbRes.language, translateLanguage);
  try {
    await redisSetJson(cacheKey, assembled, ttlSeconds);
    logger.debug('Caption cached from DB', { videoId, language: dbRes.language, remaining: ttlSeconds, requestId });
  } catch (cacheErrDb) {
    logger.error('Caption caching from DB failed', { videoId, language: dbRes.language, requestId, error: cacheErrDb });
  }
  return assembled;
}

async function fetchPersistAndCache(c: Context<AppSchema>, videoId: string, effectiveLang: string | undefined | null, translateLanguage: string | undefined | null, ttlSeconds: number, requestId?: string) {
  logger.info('Cache miss for caption, fetching from YouTube', { videoId, language: effectiveLang, translateLanguage, requestId });
  const info = await c.get('innertubeSvc').getCaption(videoId, effectiveLang ?? undefined, translateLanguage ?? undefined, { signal: c.get('signal'), requestId });
  const resolvedLang = info?.caption?.language || effectiveLang || 'default';

  // Ensure parent video row exists to satisfy FK
  try {
    const vres = await upsertVideo(info as any);
    logger.debug('Video upsert completed prior to caption', { videoId, upserted: vres.upserted, requestId });
  } catch (videoPersistErr) {
    logger.error('Video upsert failed prior to caption', { videoId, requestId, error: videoPersistErr });
  }

  try {
    const segs = info.caption.segments;
    const words = info.caption.words;
    await upsertCaption(videoId, resolvedLang, { segments: segs, words, targetLanguage: translateLanguage ?? null });
    logger.info('Caption upsert completed', { videoId, language: resolvedLang, targetLanguage: translateLanguage ?? null, requestId });
  } catch (persistErr) {
    logger.error('Caption upsert failed', { videoId, language: resolvedLang, requestId, error: persistErr });
  }

  try {
    const cacheKeyResolved = buildCacheKey(videoId, resolvedLang, translateLanguage ?? undefined);
    await redisSetJson(cacheKeyResolved, info, ttlSeconds);
    return { info, resolvedLang } as const;
  } catch (cacheErr) {
    logger.error('Caption caching failed', { videoId, language: resolvedLang, requestId, error: cacheErr });
    return { info, resolvedLang } as const;
  }
}

v1InnertubeCaptionRouter.get('/', async (c: Context<AppSchema>) => {
  const requestId = c.get('requestId');
  const rawId = c.req.query('v');
  const l = c.req.query('l');
  const tl = c.req.query('tl');

  const QuerySchema = z.object({
    v: z.string().trim().min(1, 'Missing video id'),
    l: z.string().trim().optional(),
    tl: z.string().trim().optional(),
  }).superRefine((val, ctx) => {
    const langPattern = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
    if (val.tl) {
      if (!val.l) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['l'], message: 'Language is required when translateLanguage is provided' });
      }
    }
    if (val.l && !langPattern.test(val.l)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['l'], message: 'Invalid language' });
    }
    if (val.tl && !langPattern.test(val.tl)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['tl'], message: 'Invalid translate language' });
    }
  });

  const parsed = QuerySchema.safeParse({ v: rawId, l, tl });
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const key = String(first.path[0] || '');
    const code = key === 'v'
      ? ERROR_CODES.BAD_REQUEST
      : key === 'tl'
        ? ERROR_CODES.INVALID_TRANSLATE_LANGUAGE
        : ERROR_CODES.INVALID_LANGUAGE;
    const msg = first.message || 'Bad Request';
    logger.warn('Invalid query parameters for /v1/innertube/caption', { issues: parsed.error.issues, requestId });
    return c.json({ error: msg, code }, 400);
  }

  const videoId = parsed.data.v;
  const requestedLang = parsed.data.l ?? '';
  const translateLanguage = parsed.data.tl ?? undefined;
  const { effectiveLang } = await resolveEffectiveLanguage(videoId, requestedLang, requestId);
  const cacheKey = buildCacheKey(videoId, effectiveLang, translateLanguage);
  const ttlSeconds = c.get('config').CAPTION_CACHE_TTL_SECONDS;

  try {
    // 1) Cache first
    const cached = await redisGetJson<any>(cacheKey);
    if (cached) {
      logger.info('Cache hit for caption', { videoId, language: effectiveLang, translateLanguage, requestId, cacheKey });
      return c.json(cached);
    }

    // 2) DB next (now includes translated captions by targetLanguage)
    try {
      const dbRes = await getCaptionByVideoAndLanguage(videoId, effectiveLang, translateLanguage ?? null);
      if (dbRes) {
        const now = Date.now();
        const updatedAtMs = new Date(dbRes.updatedAt).getTime();
        const ageSeconds = Math.max(0, Math.floor((now - updatedAtMs) / 1000));
        if (ageSeconds < ttlSeconds) {
          const remaining = Math.max(1, ttlSeconds - ageSeconds);
          const assembled = await assembleFromDbAndCache(c, videoId, dbRes, remaining, translateLanguage, requestId);
          logger.info('DB hit within TTL for caption', { videoId, language: dbRes.language, targetLanguage: translateLanguage ?? null, ageSeconds, remaining, requestId });
          if (!requestedLang && !translateLanguage) {
            try { await setAlias(videoId, dbRes.language, remaining); } catch { /* noop */ }
          }
          return c.json(assembled);
        }
        logger.info('DB hit but stale; will fetch YouTube caption', { videoId, language: effectiveLang, targetLanguage: translateLanguage ?? null, ageSeconds, ttlSeconds, requestId });
      } else {
        logger.debug('DB miss for caption', { videoId, language: effectiveLang, targetLanguage: translateLanguage ?? null, requestId });
      }
    } catch (dbErr) {
      logger.error('DB check for caption failed; continuing to fetch from YouTube', { videoId, language: effectiveLang, targetLanguage: translateLanguage ?? null, requestId, error: dbErr });
    }

    // 3) Fetch -> Persist -> Cache
    const { info, resolvedLang } = await fetchPersistAndCache(c, videoId, effectiveLang, translateLanguage, ttlSeconds, requestId);
    if (!requestedLang && !translateLanguage) {
      try { await setAlias(videoId, resolvedLang, ttlSeconds); } catch { /* noop */ }
    }
    return c.json(info);
  } catch (err) {
    const isAbort = isClientAbort(err) || (err instanceof HttpError && (err as HttpError).code === 'EABORT');
    if (isAbort) {
      logger.info('Request aborted by client', { videoId, language: effectiveLang, requestId });
      return c.json({ error: 'Client Closed Request', code: ERROR_CODES.CLIENT_CLOSED_REQUEST }, STATUS_CLIENT_CLOSED_REQUEST as any);
    }
    const mapped = mapErrorToHttp(err);
    logger.error('Error in /v1/innertube/caption', { err, mapped, videoId, language: effectiveLang, requestId });
    return c.json({ error: mapped.message || 'Internal Server Error', code: mapped.code }, mapped.status as any);
  }
})
;
