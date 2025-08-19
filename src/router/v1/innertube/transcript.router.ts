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

export const v1InnertubeTranscriptRouter = new Hono<AppSchema>();
const logger = createLogger('router:v1:innertube:transcript');
logger.debug('Initializing /v1/innertube/transcript router');

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

// Minimal per-id worker for batch transcripts
async function batchFetchOne(
  c: Context<AppSchema>,
  videoId: string,
  requestedLang: string | undefined | null,
) {
  const requestId = c.get('requestId');
  const { effectiveLang } = await resolveEffectiveLanguage(videoId, requestedLang, requestId);
  const cacheKey = buildCacheKey(videoId, effectiveLang);
  const ttlSeconds = c.get('config').TRANSCRIPT_CACHE_TTL_SECONDS;

  const cached = await redisGetJson<any>(cacheKey).catch(() => undefined);
  if (cached) {
    logger.info('Batch cache hit for transcript', { videoId, language: effectiveLang, requestId });
    if (isNegativeCache(cached)) return { __error: true, error: cached.error, code: cached.code, __status: (cached as any).__status ?? 400 };
    return { data: cached };
  }
  logger.debug('Batch cache miss for transcript', { videoId, language: effectiveLang, requestId, cacheKey });

  // DB next: if fresh within TTL, assemble and return
  try {
    const dbRes = await getTranscriptByVideoAndLanguage(videoId, effectiveLang || '');
    if (dbRes) {
      const now = Date.now();
      const updatedAtMs = new Date(dbRes.updatedAt).getTime();
      const ageSeconds = Math.max(0, Math.floor((now - updatedAtMs) / 1000));
      if (ageSeconds < ttlSeconds) {
        const remaining = Math.max(1, ttlSeconds - ageSeconds);
        const assembled = await assembleFromDbAndCache(c, videoId, dbRes, remaining, requestId);
        logger.info('Batch DB hit within TTL for transcript', { videoId, language: dbRes.language, ageSeconds, remaining, requestId });
        if (!requestedLang) { try { await setAlias(videoId, dbRes.language, remaining); logger.debug('Batch alias set from DB (transcript)', { videoId, language: dbRes.language, remaining, requestId }); } catch { /* noop */ } }
        return { data: assembled };
      }
      logger.info('Batch DB hit but stale for transcript; will fetch', { videoId, language: effectiveLang, ageSeconds, ttlSeconds, requestId });
    }
  } catch (dbErr) {
    logger.error('DB check for transcript (batch) failed; continuing to fetch', { videoId, language: effectiveLang, requestId, error: dbErr });
  }

  try {
    logger.info('Batch fetching transcript from upstream', { videoId, language: effectiveLang, requestId });
    const { info, resolvedLang } = await singleflight(cacheKey, async () => {
      return await fetchWithRedisLock(cacheKey, ttlSeconds, async () => {
        return await fetchPersistAndCache(c, videoId, effectiveLang, ttlSeconds, requestId);
      });
    });
    if (!requestedLang) { try { await setAlias(videoId, resolvedLang, ttlSeconds); logger.debug('Batch alias set from fetch (transcript)', { videoId, language: resolvedLang, ttlSeconds, requestId }); } catch { /* noop */ } }
    return { data: info };
  } catch (e) {
    const mapped = mapErrorToHttp(e);
    const LANG_RELATED_CODES: Set<ErrorCode> = new Set<ErrorCode>([
      ERROR_CODES.INVALID_LANGUAGE,
      ERROR_CODES.INVALID_TRANSLATE_LANGUAGE,
      ERROR_CODES.YT_TRANSLATION_UNSUPPORTED,
      ERROR_CODES.YT_TRANSLATION_SAME_LANGUAGE,
    ]);
    if (mapped.status >= 400 && mapped.status < 500 && LANG_RELATED_CODES.has(mapped.code)) {
      const neg = makeNegativeCache(mapped.message || 'Bad Request', mapped.code, mapped.status);
      try { await redisSetJson(cacheKey, neg, jitterTtl(60)); logger.debug('Batch negative-cache set for transcript', { videoId, language: effectiveLang, status: mapped.status, code: mapped.code, requestId }); } catch { /* noop */ }
    }
    return { __error: true, error: mapped.message || 'Internal Server Error', code: mapped.code, __status: mapped.status };
  }
}

v1InnertubeTranscriptRouter.get('/', async (c: Context<AppSchema>) => {
  const rawId = c.req.query('v');
  const l = c.req.query('l');
  const requestId = c.get('requestId');
  // Only negative-cache these language-related 4xx codes
  const LANG_RELATED_CODES: Set<ErrorCode> = new Set<ErrorCode>([
    ERROR_CODES.INVALID_LANGUAGE,
    ERROR_CODES.INVALID_TRANSLATE_LANGUAGE,
    ERROR_CODES.YT_TRANSLATION_UNSUPPORTED,
    ERROR_CODES.YT_TRANSLATION_SAME_LANGUAGE,
  ]);

  const QuerySchema = z
    .object({
      v: z.string().trim().min(1, 'Missing video id'),
      l: z.string().trim().optional(),
    })
    .superRefine((val, ctx) => {
      if (val.l !== undefined) {
        const candidate = val.l.trim();
        if (candidate.length === 0 || candidate.length > 100) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['l'], message: 'Invalid language' });
        }
      }
    });

  const parsed = QuerySchema.safeParse({ v: rawId, l });
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const key = String(first.path[0] ?? '');
    const code = key === 'v' ? ERROR_CODES.BAD_REQUEST : ERROR_CODES.INVALID_LANGUAGE;
    const msg = first.message || 'Bad Request';
    logger.warn('Invalid query parameters for /v1/innertube/transcript', { issues: parsed.error.issues, requestId });
    return c.json({ error: msg, code }, 400);
  }

  const videoId = parsed.data.v;
  const requestedLang = parsed.data.l ?? '';
  const { effectiveLang } = await resolveEffectiveLanguage(videoId, requestedLang, requestId);
  const cacheKey = buildCacheKey(videoId, effectiveLang);
  const ttlSeconds = c.get('config').TRANSCRIPT_CACHE_TTL_SECONDS;

  try {
    // 1) Cache first
    const cached = await redisGetJson<any>(cacheKey);
    if (cached) {
      logger.info('Cache hit for transcript', { videoId, language: effectiveLang, requestId, cacheKey });
      if (isNegativeCache(cached)) return c.json({ error: cached.error, code: cached.code }, (cached.__status as any) ?? 400);
      return c.json(cached);
    }

    // 2) DB next
    try {
      const dbRes = await getTranscriptByVideoAndLanguage(videoId, effectiveLang);
      if (dbRes) {
        const now = Date.now();
        const updatedAtMs = new Date(dbRes.updatedAt).getTime();
        const ageSeconds = Math.max(0, Math.floor((now - updatedAtMs) / 1000));
        if (ageSeconds < ttlSeconds) {
          const remaining = Math.max(1, ttlSeconds - ageSeconds);
          const assembled = await assembleFromDbAndCache(c, videoId, dbRes, remaining, requestId);
          logger.info('DB hit within TTL for transcript', { videoId, language: dbRes.language, ageSeconds, remaining, requestId });
          // For no-language requests, set alias to DB language for future fast path
          if (!requestedLang) {
            try { await setAlias(videoId, dbRes.language, remaining); } catch { /* noop */ }
          }
          return c.json(assembled);
        }
        logger.info('DB hit but stale; will fetch YouTube transcript (SWR)', { videoId, language: effectiveLang, ageSeconds, ttlSeconds, requestId });
        // Serve stale assembled response and refresh in background
        const assembled = await assembleFromDbAndCache(c, videoId, dbRes, Math.max(1, Math.floor(ttlSeconds / 10)), requestId);
        void (async () => {
          const fetchKey = cacheKey;
          try {
            const { resolvedLang } = await fetchWithRedisLock(fetchKey, ttlSeconds, async () => {
              const r = await fetchPersistAndCache(c, videoId, effectiveLang, ttlSeconds, requestId);
              return r;
            });
            if (!requestedLang) { try { await setAlias(videoId, resolvedLang, ttlSeconds); } catch {} }
          } catch (e) {
            const mapped = mapErrorToHttp(e);
            if (mapped.status >= 400 && mapped.status < 500 && LANG_RELATED_CODES.has(mapped.code)) {
              const neg = makeNegativeCache(mapped.message || 'Bad Request', mapped.code, mapped.status);
              try { await redisSetJson(fetchKey, neg, jitterTtl(60)); } catch {}
            }
          }
        })();
        return c.json(assembled);
      } else {
        logger.debug('DB miss for transcript', { videoId, language: effectiveLang, requestId });
      }
    } catch (dbErr) {
      logger.error('DB check for transcript failed; continuing to fetch from YouTube', { videoId, language: effectiveLang, requestId, error: dbErr });
    }

    // 3) Fetch -> Persist -> Cache (singleflight + distributed lock)
    const fetchKey = cacheKey;
    const { info, resolvedLang } = await singleflight(fetchKey, async () => {
      return await fetchWithRedisLock(fetchKey, ttlSeconds, async () => {
        const r = await fetchPersistAndCache(c, videoId, effectiveLang, ttlSeconds, requestId);
        return r;
      });
    });
    // Also set alias so next no-language request can map to resolvedLang
    if (!requestedLang) {
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
    // Negative cache for 4xx to reduce repeated work
    if (mapped.status >= 400 && mapped.status < 500 && LANG_RELATED_CODES.has(mapped.code)) {
      const neg = makeNegativeCache(mapped.message || 'Bad Request', mapped.code, mapped.status);
      try { await redisSetJson(cacheKey, neg, jitterTtl(60)); } catch {}
    }
    logger.error('Error in /v1/innertube/transcript', { err, mapped, videoId, language: effectiveLang, requestId });
    return c.json({ error: mapped.message || 'Internal Server Error', code: mapped.code }, mapped.status as any);
  }
});

// POST /v1/innertube/transcript/batch
v1InnertubeTranscriptRouter.post('/batch', async (c: Context<AppSchema>) => {
  const requestId = c.get('requestId');

  const BodySchema = z
    .object({
      ids: z.array(z.string().trim().min(1, 'Invalid video id')).min(1, 'ids must not be empty').max(50, 'Max 50 ids per request'),
      l: z.string().trim().optional(),
    })
    .superRefine((val, ctx) => {
      if (val.l !== undefined) {
        const candidate = val.l.trim();
        if (candidate.length === 0 || candidate.length > 100) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['l'], message: 'Invalid language' });
        }
      }
    });

  let body: unknown;
  try { body = await c.req.json(); }
  catch { return c.json({ error: 'Invalid JSON body', code: ERROR_CODES.BAD_REQUEST }, 400); }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    logger.warn('Invalid body for /v1/innertube/transcript/batch', { issues: parsed.error.issues, requestId });
    return c.json({ error: first?.message || 'Bad Request', code: ERROR_CODES.BAD_REQUEST }, 400);
  }

  const seen = new Set<string>();
  const ids = parsed.data.ids.filter((id) => !seen.has(id) && (seen.add(id), true));
  const l = parsed.data.l ?? undefined;

  try {
    const results: Record<string, any> = {};
    const cfg = c.get('config');
    const { concurrency, minDelayMs, maxDelayMs } = readBatchThrottle(cfg, { maxConcurrency: 5, minDelayFloorMs: 50 });

    await throttleMap(
      ids,
      async (id) => {
        const r = await batchFetchOne(c, id, l);
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
