import { createLogger } from '@/lib/logger.lib';
import { HttpError } from '@/lib/http.lib';
import { Context, Hono } from 'hono';
import type { AppSchema } from '@/app';
import { isClientAbort, STATUS_CLIENT_CLOSED_REQUEST, mapErrorToHttp, ERROR_CODES } from '@/lib/hono.util';
import type { ErrorCode } from '@/lib/hono.util';
import { z } from 'zod';
import { redisGetJson, redisSetJson } from '@/lib/redis.lib';
import { jitterTtl, singleflight, fetchWithRedisLock, isNegativeCache, makeNegativeCache } from '@/lib/cache.util';
import { getTranscriptByVideoAndLanguage, upsertTranscript, getPreferredTranscriptLanguage, hasTranscriptLanguage } from '@/service/transcript.service';
import { throttleMap, readBatchThrottle } from '@/lib/throttle.util';
import { getVideoById, upsertVideo } from '@/service/video.service';
import { navigationMiddleware } from '@/middleware/navigation.middleware';
import { navigationBatchMiddleware } from '@/middleware/navigation-batch.middleware';

export const v1InnertubeTranscriptRouter = new Hono<AppSchema>();
const logger = createLogger('router:v1:innertube:transcript');
logger.debug('Initializing /v1/innertube/transcript router');

// Shared constants/utilities
const LANG_RELATED_CODES: Set<ErrorCode> = new Set<ErrorCode>([
  ERROR_CODES.INVALID_LANGUAGE,
  ERROR_CODES.INVALID_TRANSLATE_LANGUAGE,
  ERROR_CODES.YT_TRANSLATION_UNSUPPORTED,
  ERROR_CODES.YT_TRANSLATION_SAME_LANGUAGE,
]);

function shouldNegativeCache(status: number, code: ErrorCode): boolean {
  return status >= 400 && status < 500 && LANG_RELATED_CODES.has(code);
}

async function getCachedJson<T>(key: string): Promise<T | undefined> {
  try {
    const val = await redisGetJson<T>(key);
    return (val as any) ?? undefined;
  } catch {
    return undefined;
  }
}

function computeAgeSeconds(updatedAt: Date): number {
  const now = Date.now();
  const updatedAtMs = new Date(updatedAt).getTime();
  return Math.max(0, Math.floor((now - updatedAtMs) / 1000));
}

async function setAliasIfNoRequested(videoId: string, requestedLang: string | undefined | null, languageToSet: string, ttlSeconds: number) {
  if (!requestedLang) {
    try { await setAlias(videoId, languageToSet, ttlSeconds); }
    catch { /* noop */ }
  }
}

async function negativeCacheIfLanguageRelated(cacheKey: string, mapped: { status: number; code: ErrorCode; message?: string }, requestId?: string, logPrefix: string = 'transcript') {
  if (shouldNegativeCache(mapped.status, mapped.code)) {
    const neg = makeNegativeCache(mapped.message || 'Bad Request', mapped.code, mapped.status);
    try {
      await redisSetJson(cacheKey, neg, jitterTtl(60));
      logger.debug(`${logPrefix} negative-cache set`, { cacheKey, status: mapped.status, code: mapped.code, requestId });
    } catch { /* noop */ }
  }
}

function buildCacheKey(videoId: string, language: string | undefined | null): string {
  const cacheLang = language ?? 'default';
  return `yt:transcript:${videoId}:${cacheLang}`;
}

async function getAlias(videoId: string): Promise<string | null> {
  const aliasKey = `yt:transcript:${videoId}:_alias`;
  const alias = await redisGetJson<string>(aliasKey);
  return typeof alias === 'string' ? alias : null;
}

async function setAlias(videoId: string, language: string, ttlSeconds: number): Promise<void> {
  const aliasKey = `yt:transcript:${videoId}:_alias`;
  await redisSetJson(aliasKey, language, ttlSeconds);
}

async function resolveEffectiveLanguage(videoId: string, requestedLang: string | undefined | null, requestId?: string): Promise<{ effectiveLang: string; source: 'request' | 'alias' | 'db' | 'default' | 'fallback' }> {
  if (requestedLang && requestedLang.length > 0) {
    try {
      const available = await hasTranscriptLanguage(videoId, requestedLang);
      if (available) {
        return { effectiveLang: requestedLang, source: 'request' };
      }
      // Not available -> fall back to preferred
      const preferred = await getPreferredTranscriptLanguage(videoId);
      if (preferred) {
        logger.info('Requested language not available, falling back to preferred', { videoId, requestedLang, fallback: preferred, requestId });
        return { effectiveLang: preferred, source: 'fallback' };
      }
    } catch (e) {
      logger.warn('Failed checking requested language availability; proceeding with other resolution', { videoId, requestedLang, requestId, error: e });
    }
  }
  // Try alias first
  try {
    const alias = await getAlias(videoId);
    if (alias) {
      logger.debug('Using alias language for cache/DB', { videoId, effectiveLang: alias, requestId });
      return { effectiveLang: alias, source: 'alias' };
    }
  } catch (aliasErr) {
    logger.warn('Failed to read alias language; proceeding without alias', { videoId, requestId, error: aliasErr });
  }
  // Try DB preferred transcript language (English/English auto-generated), fallback to oldest
  try {
    const preferred = await getPreferredTranscriptLanguage(videoId);
    if (preferred) {
      logger.debug('Derived effective language from video.transcript_languages or oldest', { videoId, effectiveLang: preferred, requestId });
      return { effectiveLang: preferred, source: 'db' };
    }
  } catch (oldestErr) {
    logger.warn('Failed to derive oldest transcript language from DB', { videoId, requestId, error: oldestErr });
  }
  return { effectiveLang: '', source: 'default' };
}

async function assembleFromDbAndCache(c: Context<AppSchema>, videoId: string, dbRes: { language: string; segments: Array<{ text: string }>; updatedAt: Date; }, remainingTtl: number, requestId?: string) {
  const ttlSeconds = Math.max(1, remainingTtl);
  let videoDb = await getVideoById(videoId);
  if (!videoDb) {
    try {
      const videoInfo = await c.get('innertubeSvc').getVideoInfo(videoId, { signal: c.get('signal'), requestId });
      videoDb = { video: videoInfo, updatedAt: new Date() } as any;
    } catch (videoErr) {
      logger.error('Failed to get video info while assembling transcript response', { videoId, requestId, error: videoErr });
    }
  }
  const textFromSegments = (dbRes.segments || []).map(s => s.text).join(' ').trim();

  const assembled = videoDb ? {
    ...videoDb.video,
    transcript: {
      language: dbRes.language,
      segments: dbRes.segments,
      text: textFromSegments,
    },
  } : {
    id: videoId,
    transcript: {
      language: dbRes.language,
      segments: dbRes.segments,
      text: textFromSegments,
    }
  } as any;

  const cacheKey = buildCacheKey(videoId, dbRes.language);
  try {
    await redisSetJson(cacheKey, assembled, jitterTtl(ttlSeconds));
    logger.debug('Transcript cached from DB', { videoId, language: dbRes.language, remaining: ttlSeconds, requestId });
  } catch (cacheErrDb) {
    logger.error('Transcript caching from DB failed', { videoId, language: dbRes.language, requestId, error: cacheErrDb });
  }
  return assembled;
}

async function fetchPersistAndCache(c: Context<AppSchema>, videoId: string, effectiveLang: string | undefined | null, ttlSeconds: number, requestId?: string) {
  logger.info('Cache miss for transcript, fetching from YouTube', { videoId, language: effectiveLang, requestId });
  const info = await c.get('innertubeSvc').getTranscript(videoId, effectiveLang ?? undefined, { signal: c.get('signal'), requestId });
  const resolvedLang = info?.transcript?.language ?? effectiveLang ?? 'default';

  // Ensure parent video row exists to satisfy FK
  try {
    const vres = await upsertVideo(info as any);
    logger.debug('Video upsert completed prior to transcript', { videoId, upserted: vres.upserted, requestId });
  } catch (videoPersistErr) {
    logger.error('Video upsert failed prior to transcript', { videoId, requestId, error: videoPersistErr });
  }

  try {
    const res = await upsertTranscript(videoId, resolvedLang, { segments: info.transcript.segments });
    logger.info('Transcript upsert completed', { videoId, language: resolvedLang, upserted: res.upserted, requestId });
  } catch (persistErr) {
    logger.error('Transcript upsert failed', { videoId, language: resolvedLang, requestId, error: persistErr });
  }

  try {
    const cacheKeyResolved = buildCacheKey(videoId, resolvedLang);
    await redisSetJson(cacheKeyResolved, info, ttlSeconds);
    return { info, resolvedLang } as const;
  } catch (cacheErr) {
    logger.error('Transcript caching failed', { videoId, language: resolvedLang, requestId, error: cacheErr });
    return { info, resolvedLang } as const;
  }
}

// Encapsulate DB read and optional SWR refresh
async function tryServeFromDb(
  c: Context<AppSchema>,
  videoId: string,
  effectiveLang: string | undefined | null,
  requestedLang: string | undefined | null,
  ttlSeconds: number,
  requestId: string | undefined,
  cacheKey: string,
  logContext: 'single' | 'batch' = 'single',
): Promise<{ assembled: any | null }> {
  try {
    const dbRes = await getTranscriptByVideoAndLanguage(videoId, effectiveLang || '');
    if (!dbRes) {
      logger.debug(`${logContext === 'batch' ? 'Batch ' : ''}DB miss for transcript`, { videoId, language: effectiveLang, requestId });
      return { assembled: null };
    }

    const ageSeconds = computeAgeSeconds(dbRes.updatedAt);
    if (ageSeconds < ttlSeconds) {
      const remaining = Math.max(1, ttlSeconds - ageSeconds);
      const assembled = await assembleFromDbAndCache(c, videoId, dbRes, remaining, requestId);
      logger.info(`${logContext === 'batch' ? 'Batch ' : ''}DB hit within TTL for transcript`, { videoId, language: dbRes.language, ageSeconds, remaining, requestId });
      await setAliasIfNoRequested(videoId, requestedLang, dbRes.language, remaining);
      return { assembled };
    }

    // Stale-while-revalidate
    logger.info(`${logContext === 'batch' ? 'Batch ' : ''}DB hit but stale; will fetch`, { videoId, language: effectiveLang, ageSeconds, ttlSeconds, requestId });
    const assembled = await assembleFromDbAndCache(c, videoId, dbRes, Math.max(1, Math.floor(ttlSeconds / 10)), requestId);
    if (logContext === 'single') {
      void (async () => {
        try {
          const { resolvedLang } = await fetchWithRedisLock(cacheKey, ttlSeconds, async () => {
            return await fetchPersistAndCache(c, videoId, effectiveLang, ttlSeconds, requestId);
          });
          await setAliasIfNoRequested(videoId, requestedLang, resolvedLang, ttlSeconds);
        } catch (e) {
          const mapped = mapErrorToHttp(e);
          await negativeCacheIfLanguageRelated(cacheKey, mapped, requestId);
        }
      })();
    }
    return { assembled };
  } catch (dbErr) {
    logger.error(`${logContext === 'batch' ? 'DB check for transcript (batch)' : 'DB check for transcript'} failed; continuing`, { videoId, language: effectiveLang, requestId, error: dbErr });
    return { assembled: null };
  }
}

// Shared single-fetch used by GET route (mirrors batchFetchOne behavior but returns same shape)
async function fetchOne(
  c: Context<AppSchema>,
  videoId: string,
  requestedLang: string | undefined | null,
) {
  const requestId = c.get('requestId');
  const { effectiveLang } = await resolveEffectiveLanguage(videoId, requestedLang, requestId);
  const cacheKey = buildCacheKey(videoId, effectiveLang);
  const ttlSeconds = c.get('config').TRANSCRIPT_CACHE_TTL_SECONDS;

  const cached = await getCachedJson<any>(cacheKey);
  if (cached) {
    logger.info('Cache hit for transcript', { videoId, language: effectiveLang, requestId, cacheKey });
    if (isNegativeCache(cached)) return { __error: true, error: cached.error, code: cached.code, __status: (cached as any).__status ?? 400 };
    return { data: cached };
  }

  const fromDb = await tryServeFromDb(c, videoId, effectiveLang, requestedLang, ttlSeconds, requestId, cacheKey, 'single');
  if (fromDb.assembled) return { data: fromDb.assembled };

  try {
    const { info, resolvedLang } = await singleflight(cacheKey, async () => {
      return await fetchWithRedisLock(cacheKey, ttlSeconds, async () => {
        return await fetchPersistAndCache(c, videoId, effectiveLang, ttlSeconds, requestId);
      });
    });
    await setAliasIfNoRequested(videoId, requestedLang, resolvedLang, ttlSeconds);
    return { data: info };
  } catch (e) {
    const mapped = mapErrorToHttp(e);
    await negativeCacheIfLanguageRelated(cacheKey, mapped, requestId, 'transcript');
    return { __error: true, error: mapped.message || 'Internal Server Error', code: mapped.code, __status: mapped.status };
  }
}

v1InnertubeTranscriptRouter.get('/', navigationMiddleware(), async (c: Context<AppSchema>) => {
  const requestId = c.get('requestId');
  const langParam = c.req.query('l');

  // Validate only language param; videoId comes from navigation middleware
  const LangSchema = z.object({
    l: z.string().trim().optional(),
  }).superRefine((val, ctx) => {
    if (val.l !== undefined) {
      const candidate = val.l.trim();
      if (candidate.length === 0 || candidate.length > 100) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['l'], message: 'Invalid language' });
      }
    }
  });

  const parsed = LangSchema.safeParse({ l: langParam });
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const msg = first.message || 'Bad Request';
    logger.warn('Invalid query parameters for /v1/innertube/transcript', { issues: parsed.error.issues, requestId });
    return c.json({ error: msg, code: ERROR_CODES.INVALID_LANGUAGE }, 400);
  }

  const navigationEndpoint = c.get('navigationEndpoint') as any;
  const videoId = navigationEndpoint?.payload?.videoId as string | undefined;
  if (!videoId) return c.json({ error: 'Missing video id', code: ERROR_CODES.BAD_REQUEST }, 400);

  const requestedLang = parsed.data.l ?? '';

  try {
    const r = await fetchOne(c, videoId, requestedLang);
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
    logger.error('Error in /v1/innertube/transcript', { err, mapped, videoId, requestId });
    return c.json({ error: mapped.message || 'Internal Server Error', code: mapped.code }, mapped.status as any);
  }
});

// POST /v1/innertube/transcript/batch
v1InnertubeTranscriptRouter.post('/batch', navigationBatchMiddleware(), async (c: Context<AppSchema>) => {
  const requestId = c.get('requestId');

  // Language comes from query to avoid re-consuming JSON body
  const langParam = c.req.query('l');
  const LangSchema = z.object({
    l: z.string().trim().optional(),
  }).superRefine((val, ctx) => {
    if (val.l !== undefined) {
      const candidate = val.l.trim();
      if (candidate.length === 0 || candidate.length > 100) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['l'], message: 'Invalid language' });
      }
    }
  });
  const parsedLang = LangSchema.safeParse({ l: langParam });
  if (!parsedLang.success) {
    const first = parsedLang.error.issues[0];
    logger.warn('Invalid language for /v1/innertube/transcript/batch', { issues: parsedLang.error.issues, requestId });
    return c.json({ error: first?.message || 'Bad Request', code: ERROR_CODES.BAD_REQUEST }, 400);
  }
  const l = parsedLang.data.l ?? undefined;

  // Prefer ids prepared by navigationBatchMiddleware
  const ctxIds = c.get('batchIds') as string[] | undefined;
  let ids: string[];
  if (Array.isArray(ctxIds) && ctxIds.length > 0) {
    ids = ctxIds;
  } else {
    // Fallback: accept raw JSON body if middleware did not pre-parse
    const BodySchema = z.object({
      ids: z.array(z.string().trim().min(1, 'Invalid video id')).min(1, 'ids must not be empty').max(50, 'Max 50 ids per request'),
    });
    let body: unknown;
    try { body = await c.req.json(); }
    catch {
      logger.warn('Invalid JSON body for /v1/innertube/transcript/batch', { requestId });
      return c.json({ error: 'Invalid JSON body', code: ERROR_CODES.BAD_REQUEST }, 400);
    }
    const parsedBody = BodySchema.safeParse(body);
    if (!parsedBody.success) {
      const first = parsedBody.error.issues[0];
      logger.warn('Invalid body for /v1/innertube/transcript/batch', { issues: parsedBody.error.issues, requestId });
      return c.json({ error: first?.message || 'Bad Request', code: ERROR_CODES.BAD_REQUEST }, 400);
    }
    ids = parsedBody.data.ids;
  }

  try {
    const results: Record<string, any> = {};
    const cfg = c.get('config');
    const { concurrency, minDelayMs, maxDelayMs } = readBatchThrottle(cfg, { maxConcurrency: 5, minDelayFloorMs: 50 });

    await throttleMap(
      ids,
      async (id) => {
        // If navigationBatchMiddleware provided mappings, use them to extract videoId
        const urlById = c.get('batchUrlById') as Map<string, string | null> | undefined;
        const endpointMap = c.get('navigationEndpointMap') as Map<string, any> | undefined;
        const url = urlById?.get(id) ?? null;
        if (!url) {
          results[id] = { error: 'Only YouTube channel/video URL, channelId, handle, or videoId are allowed', code: ERROR_CODES.BAD_REQUEST };
          return;
        }
        const ep = endpointMap?.get(url);
        if (!ep) {
          results[id] = { error: 'Video ID not found', code: ERROR_CODES.BAD_REQUEST };
          return;
        }
        if ((ep as any)?.__error) {
          results[id] = { error: (ep as any).message, code: (ep as any).code };
          return;
        }
        const videoId = (ep as any)?.payload?.videoId as string | undefined;
        if (!videoId) {
          results[id] = { error: 'Video ID not found', code: ERROR_CODES.BAD_REQUEST };
          return;
        }

        const r = await fetchOne(c, videoId, l);
        results[id] = (r as any).__error ? { error: (r as any).error, code: (r as any).code } : (r as any).data;
      },
      { concurrency, minDelayMs, maxDelayMs, signal: c.get('signal') }
    );

    logger.info('Transcript batch processed', { count: ids.length, requestId });
    return c.json(results);
  } catch (err) {
    const mapped = mapErrorToHttp(err);
    logger.error('Error in /v1/innertube/transcript/batch', { err, mapped, requestId });
    return c.json({ error: mapped.message || 'Internal Server Error', code: mapped.code }, mapped.status as any);
  }
});
