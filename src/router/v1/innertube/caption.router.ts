import { createLogger } from '@/lib/logger.lib';
import { Context, Hono } from 'hono';
import type { AppSchema } from '@/app';
import { isClientAbort, STATUS_CLIENT_CLOSED_REQUEST, mapErrorToHttp, ERROR_CODES } from '@/lib/hono.util';
import type { ErrorCode } from '@/lib/hono.util';
import { HttpError } from '@/lib/http.lib';
import { z } from 'zod';
import { redisGetJson, redisSetJson } from '@/lib/redis.lib';
import { jitterTtl, singleflight, fetchWithRedisLock, isNegativeCache, makeNegativeCache } from '@/lib/cache.util';
import { getCaptionByVideoAndLanguage, hasCaptionLanguage, getPreferredCaptionLanguage, upsertCaption } from '@/service/caption.service';
import { throttleMap, readBatchThrottle } from '@/lib/throttle.util';
import { getVideoById, upsertVideo } from '@/service/video.service';
import { InnertubeService } from '@/service/innertube.service';
import { navigationMiddleware } from '@/middleware/navigation.middleware';
import { navigationBatchMiddleware } from '@/middleware/navigation-batch.middleware';

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
  const ttlSeconds = jitterTtl(Math.max(1, remainingTtl));
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
    await redisSetJson(cacheKeyResolved, info, jitterTtl(ttlSeconds));
    return { info, resolvedLang } as const;
  } catch (cacheErr) {
    logger.error('Caption caching failed', { videoId, language: resolvedLang, requestId, error: cacheErr });
    return { info, resolvedLang } as const;
  }
}

type FetchOptions = { swrOnStale?: boolean };

// Unified single-item resolver used by both GET and batch routes
async function fetchOne(
  c: Context<AppSchema>,
  videoId: string,
  requestedLang: string | undefined | null,
  translateLanguage: string | undefined | null,
  opts: FetchOptions = { swrOnStale: false }
) {
  const requestId = c.get('requestId');
  const { effectiveLang } = await resolveEffectiveLanguage(videoId, requestedLang, requestId);
  const cacheKey = buildCacheKey(videoId, effectiveLang, translateLanguage);
  const ttlSeconds = c.get('config').CAPTION_CACHE_TTL_SECONDS;

  // Early translate-language validation from video metadata when available
  if (translateLanguage) {
    try {
      const videoDb = await getVideoById(videoId);
      const tlList: Array<{ languageCode: string }> = (videoDb?.video?.captionTranslationLanguages ?? []) as any;
      const srcList: Array<{ languageCode: string; isTranslatable?: boolean }> = (videoDb?.video?.captionLanguages ?? []) as any;
      const tlOk = Array.isArray(tlList) && tlList.some(t => (t.languageCode || '').toLowerCase() === translateLanguage.toLowerCase());
      const src = Array.isArray(srcList) ? srcList.find(s => (s.languageCode || '').toLowerCase() === (effectiveLang || '').toLowerCase()) : undefined;
      const srcOk = !src || src.isTranslatable !== false; // assume ok if unknown
      if (!tlOk || !srcOk) {
        return { __error: true, error: 'Invalid translate language', code: ERROR_CODES.INVALID_TRANSLATE_LANGUAGE, __status: 400 } as const;
      }
    } catch {/* ignore and proceed */}
  }

  // 1) Cache first
  const cached = await redisGetJson<any>(cacheKey).catch(() => undefined);
  if (cached) {
    logger.info('Cache hit for caption', { videoId, language: effectiveLang, translateLanguage, requestId, cacheKey });
    if (isNegativeCache(cached)) {
      return { __error: true, error: cached.error, code: cached.code, __status: (cached as any).__status ?? 400 };
    }
    return { data: cached };
  }

  // 2) DB next
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
        if (!requestedLang && !translateLanguage) { try { await setAlias(videoId, dbRes.language, remaining); } catch { /* noop */ } }
        return { data: assembled };
      }
      // SWR mode: return stale and refresh in background
      if (opts.swrOnStale) {
        const remaining = 60;
        const assembled = await assembleFromDbAndCache(c, videoId, dbRes, remaining, translateLanguage, requestId);
        logger.info('DB hit but stale; serving stale and refreshing in background (caption)', { videoId, language: effectiveLang, targetLanguage: translateLanguage ?? null, ageSeconds, ttlSeconds, requestId });
        const bgKey = buildCacheKey(videoId, effectiveLang, translateLanguage);
        void (async () => {
          try {
            const { resolvedLang } = await fetchWithRedisLock(bgKey, ttlSeconds, async () => {
              return await fetchPersistAndCache(c, videoId, effectiveLang, translateLanguage, ttlSeconds, requestId);
            });
            if (!requestedLang && !translateLanguage) {
              try { await setAlias(videoId, resolvedLang, ttlSeconds); } catch { /* noop */ }
            }
          } catch (e) {
            const mapped = mapErrorToHttp(e);
            if (mapped.status >= 400 && mapped.status < 500) {
              const neg = makeNegativeCache(mapped.message || 'Bad Request', mapped.code, mapped.status);
              try { await redisSetJson(bgKey, neg, jitterTtl(60)); } catch { /* noop */ }
            }
          }
        })();
        return { data: assembled };
      }
    }
  } catch (dbErr) {
    logger.error('DB check for caption failed; will fetch', { videoId, language: effectiveLang, targetLanguage: translateLanguage ?? null, requestId, error: dbErr });
  }

  // 3) Fetch -> persist -> cache
  try {
    const res = await singleflight(cacheKey, async () => {
      return await fetchWithRedisLock(cacheKey, ttlSeconds, async () => {
        return await fetchPersistAndCache(c, videoId, effectiveLang, translateLanguage, ttlSeconds, requestId);
      });
    });
    const { info, resolvedLang } = res;
    if (!requestedLang && !translateLanguage) { try { await setAlias(videoId, resolvedLang, ttlSeconds); } catch { /* noop */ } }
    return { data: info };
  } catch (e) {
    const mapped = mapErrorToHttp(e);
    if (mapped.status >= 400 && mapped.status < 500) {
      const neg = makeNegativeCache(mapped.message || 'Bad Request', mapped.code, mapped.status);
      try { await redisSetJson(cacheKey, neg, jitterTtl(60)); } catch { /* noop */ }
    }
    return { __error: true, error: mapped.message || 'Internal Server Error', code: mapped.code, __status: mapped.status };
  }
}

v1InnertubeCaptionRouter.get('/', navigationMiddleware(), async (c: Context<AppSchema>) => {
  const requestId = c.get('requestId');
  const l = c.req.query('l');
  const tl = c.req.query('tl');
  // Only negative-cache these language-related 4xx codes
  const LANG_RELATED_CODES: Set<ErrorCode> = new Set<ErrorCode> ([
    ERROR_CODES.INVALID_LANGUAGE,
    ERROR_CODES.INVALID_TRANSLATE_LANGUAGE,
    ERROR_CODES.YT_TRANSLATION_UNSUPPORTED,
    ERROR_CODES.YT_TRANSLATION_SAME_LANGUAGE,
  ]);

  const QuerySchema = z.object({
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

  const parsed = QuerySchema.safeParse({ l, tl });
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const key = String(first.path[0] || '');
    const code = key === 'tl' ? ERROR_CODES.INVALID_TRANSLATE_LANGUAGE : ERROR_CODES.INVALID_LANGUAGE;
    const msg = first.message || 'Bad Request';
    logger.warn('Invalid query parameters for /v1/innertube/caption', { issues: parsed.error.issues, requestId });
    return c.json({ error: msg, code }, 400);
  }

  const navigationEndpoint = c.get('navigationEndpoint') as any;
  const videoId = navigationEndpoint?.payload?.videoId as string | undefined;
  if (!videoId) return c.json({ error: 'Missing video id', code: ERROR_CODES.BAD_REQUEST }, 400);

  try {
    const r = await fetchOne(c, videoId, l ?? '', tl ?? undefined, { swrOnStale: true });
    if ((r as any).__error) {
      const status = (r as any).__status ?? 400;
      return c.json({ error: (r as any).error, code: (r as any).code }, status as any);
    }
    return c.json((r as any).data);
  } catch (err) {
    const isAbort = isClientAbort(err) || (err instanceof HttpError && (err as HttpError).code === 'EABORT');
    if (isAbort) {
      logger.info('Request aborted by client', { videoId, requestId });
      return c.json({ error: 'Client Closed Request', code: ERROR_CODES.CLIENT_CLOSED_REQUEST }, STATUS_CLIENT_CLOSED_REQUEST as any);
    }
    const mapped = mapErrorToHttp(err);
    logger.error('Error in /v1/innertube/caption', { err, mapped, videoId, requestId });
    return c.json({ error: mapped.message || 'Internal Server Error', code: mapped.code }, mapped.status as any);
  }
});

// POST /v1/innertube/caption/batch
v1InnertubeCaptionRouter.post('/batch', navigationBatchMiddleware(), async (c: Context<AppSchema>) => {
  const requestId = c.get('requestId');
  // l and tl from query (middleware may have consumed body)
  const LangSchema = z.object({
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
  const parsedLang = LangSchema.safeParse({ l: c.req.query('l'), tl: c.req.query('tl') });
  if (!parsedLang.success) {
    const first = parsedLang.error.issues[0];
    logger.warn('Invalid language for caption batch', { issues: parsedLang.error.issues, requestId });
    return c.json({ error: first?.message || 'Bad Request', code: ERROR_CODES.BAD_REQUEST }, 400);
  }
  const l = parsedLang.data.l ?? undefined;
  const tl = parsedLang.data.tl ?? undefined;

  // Prefer ids from middleware; else parse body ids only
  const ctxIds = c.get('batchIds') as string[] | undefined;
  let ids: string[];
  if (Array.isArray(ctxIds) && ctxIds.length > 0) {
    ids = ctxIds;
  } else {
    const BodySchema = z.object({ ids: z.array(z.string().trim().min(1)).min(1, 'ids cannot be empty') });
    const parsedBody = BodySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsedBody.success) {
      const first = parsedBody.error.issues[0];
      logger.warn('Invalid body for caption batch', { issues: parsedBody.error.issues, requestId });
      return c.json({ error: first?.message || 'Bad Request', code: ERROR_CODES.BAD_REQUEST }, 400);
    }
    ids = parsedBody.data.ids;
  }

  // Ensure player is initialized once before batch to avoid concurrent downloads per video
  try {
    await InnertubeService.ensurePlayerReady();
    logger.debug('Player pre-warmed for caption batch', { requestId });
  } catch (e) {
    // Non-fatal: proceed; individual calls will attempt init with singleflight-esque guard
    logger.warn('Player pre-warm failed; proceeding with batch', { requestId, error: e });
  }

  const throttle = readBatchThrottle(c);
  const out: Record<string, any> = {};
  const urlById = c.get('batchUrlById') as Map<string, string | null> | undefined;
  const endpointMap = c.get('navigationEndpointMap') as Map<string, any> | undefined;

  await throttleMap(ids, async (id) => {
    // If middleware provided URL and endpoint, use it to resolve videoId
    let videoId: string | undefined;
    const url = urlById?.get(id) ?? null;
    if (url !== null && endpointMap) {
      if (!url) {
        out[id] = { error: 'Only YouTube channel/video URL, channelId, handle, or videoId are allowed', code: ERROR_CODES.BAD_REQUEST };
        return;
      }
      const ep = endpointMap.get(url);
      if (!ep) {
        out[id] = { error: 'Video ID not found', code: ERROR_CODES.BAD_REQUEST };
        return;
      }
      if ((ep as any)?.__error) {
        out[id] = { error: (ep as any).message, code: (ep as any).code };
        return;
      }
      videoId = (ep as any)?.payload?.videoId as string | undefined;
      if (!videoId) {
        out[id] = { error: 'Video ID not found', code: ERROR_CODES.BAD_REQUEST };
        return;
      }
    } else {
      // Fallback: treat input id as a videoId
      videoId = id;
    }

    const r = await fetchOne(c, videoId, l ?? undefined, tl ?? undefined, { swrOnStale: false });
    out[id] = (r as any)?.__error ? { error: (r as any).error, code: (r as any).code, __status: (r as any).__status } : (r as any)?.data ?? null;
  }, throttle);

  return c.json(out);
});
