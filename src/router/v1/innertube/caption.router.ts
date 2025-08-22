import { createLogger } from '@/lib/logger.lib';
import { Context, Hono } from 'hono';
import type { AppSchema } from '@/app';
import { isClientAbort, STATUS_CLIENT_CLOSED_REQUEST, mapErrorToHttp, ERROR_CODES } from '@/lib/hono.util';
import type { ErrorCode } from '@/lib/hono.util';
import { HttpError } from '@/lib/http.lib';
import { z } from 'zod';
import { redisGetJson, redisSetJson, redisSetJsonGzip } from '@/lib/redis.lib';
import { swrResolve, jitterTtl } from '@/lib/cache.util';
import { getCaptionByVideoAndLanguage, hasCaptionLanguage, getPreferredCaptionLanguage, upsertCaption } from '@/service/caption.service';
import { processBatchIds, extractFromNavigation } from '@/lib/batch.util';
import { getVideoById, upsertVideo } from '@/service/video.service';
import { InnertubeService } from '@/service/innertube.service';
import { navigationMiddleware } from '@/middleware/navigation.middleware';
import { navigationBatchMiddleware } from '@/middleware/navigation-batch.middleware';

export const v1InnertubeCaptionRouter = new Hono<AppSchema>();
const logger = createLogger('router:v1:innertube:caption');
logger.debug('Initializing /v1/innertube/caption router');

// Only negative-cache language-related 4xx codes
const LANG_RELATED_CODES: Set<ErrorCode> = new Set<ErrorCode> ([
  ERROR_CODES.INVALID_LANGUAGE,
  ERROR_CODES.INVALID_TRANSLATE_LANGUAGE,
  ERROR_CODES.YT_TRANSLATION_UNSUPPORTED,
  ERROR_CODES.YT_TRANSLATION_SAME_LANGUAGE,
]);

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
  const ttlSeconds = c.get('config').CAPTION_CACHE_TTL_SECONDS as number;
  const cacheKey = buildCacheKey(videoId, effectiveLang, translateLanguage);

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

  const result = await swrResolve<any, { language: string; segments: Array<{ text: string }>; words: Array<{ text: string }>; updatedAt: Date }>(
    {
      cacheKey,
      ttlSeconds,
      serveStale: !!opts.swrOnStale,
      getFromDb: async () => await getCaptionByVideoAndLanguage(videoId, effectiveLang, translateLanguage ?? null),
      dbUpdatedAt: (db) => db.updatedAt,
      assembleFromDb: async (dbRes, remainingTtl) => {
        // Build the final response payload from DB data; also set alias if no explicit language/translate requested
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
            words: (dbRes as any).words,
            text: textFromSegments,
          },
        } : {
          id: videoId,
          caption: {
            hascaption: (dbRes.segments?.length ?? 0) > 0 || (dbRes as any).words?.length > 0 || textFromSegments.length > 0,
            language: dbRes.language,
            segments: dbRes.segments,
            words: (dbRes as any).words,
            text: textFromSegments,
          }
        } as any;
        if (!requestedLang && !translateLanguage) {
          try { await setAlias(videoId, dbRes.language, Math.max(1, remainingTtl)); } catch { /* noop */ }
        }
        return assembled;
      },
      fetchPersist: async () => {
        logger.info('Cache miss for caption, fetching from YouTube', { videoId, language: effectiveLang, translateLanguage, requestId });
        const info = await c.get('innertubeSvc').getCaption(videoId, effectiveLang ?? undefined, translateLanguage ?? undefined, { signal: c.get('signal'), requestId });
        const resolvedLang = (info as any)?.caption?.language || effectiveLang || 'default';

        // Ensure parent video row exists to satisfy FK
        try {
          const vres = await upsertVideo(info as any);
          logger.debug('Video upsert completed prior to caption', { videoId, upserted: (vres as any)?.upserted, requestId });
        } catch (videoPersistErr) {
          logger.error('Video upsert failed prior to caption', { videoId, requestId, error: videoPersistErr });
        }

        try {
          const segs = (info as any).caption?.segments;
          const words = (info as any).caption?.words;
          await upsertCaption(videoId, resolvedLang, { segments: segs, words, targetLanguage: translateLanguage ?? null });
          logger.info('Caption upsert completed', { videoId, language: resolvedLang, targetLanguage: translateLanguage ?? null, requestId });
        } catch (persistErr) {
          logger.error('Caption upsert failed', { videoId, language: resolvedLang, requestId, error: persistErr });
        }

        // Maintain alias and also populate cache under the resolved language key for consistency
        if (!requestedLang && !translateLanguage) {
          try { await setAlias(videoId, resolvedLang, ttlSeconds); } catch { /* noop */ }
        }
        try {
          const cacheKeyResolved = buildCacheKey(videoId, resolvedLang, translateLanguage ?? undefined);
          if (cacheKeyResolved !== cacheKey) {
            await redisSetJsonGzip(cacheKeyResolved, info, jitterTtl(ttlSeconds));
          }
        } catch { /* noop */ }

        return info;
      },
      shouldNegativeCache: (status, code) => (status >= 400 && status < 500 && LANG_RELATED_CODES.has(code as ErrorCode)),
    }
  );

  return result as any;
}

v1InnertubeCaptionRouter.get('/', navigationMiddleware(), async (c: Context<AppSchema>) => {
  const requestId = c.get('requestId');
  const l = c.req.query('l');
  const tl = c.req.query('tl');

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

  const results = await processBatchIds(c, ids, {
    extractEntityId: extractFromNavigation('videoId', { allowFallbackRawIdWhenNoMap: true }),
    fetchOne: (entityId: string) => fetchOne(c, entityId, l ?? undefined, tl ?? undefined, { swrOnStale: false }) as any,
    includeStatusOnError: true,
  });
  logger.info('Caption batch processed', { count: ids.length, requestId });
  return c.json(results);
});
