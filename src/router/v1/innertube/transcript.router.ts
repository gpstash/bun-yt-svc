import { createLogger } from '@/lib/logger.lib';
import { HttpError } from '@/lib/http.lib';
import { Context, Hono } from 'hono';
import type { AppSchema } from '@/app';
import { isClientAbort, STATUS_CLIENT_CLOSED_REQUEST, mapErrorToHttp, ERROR_CODES } from '@/lib/hono.util';
import { z } from 'zod';
import { redisGetJson, redisSetJson } from '@/lib/redis.lib';
import { getTranscriptByVideoAndLanguage, upsertTranscript, getPreferredTranscriptLanguage, hasTranscriptLanguage } from '@/service/transcript.service';
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
      // If no preferred, fall through to alias/oldest/default below
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
    await redisSetJson(cacheKey, assembled, ttlSeconds);
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
        logger.info('DB hit but stale; will fetch YouTube transcript', { videoId, language: effectiveLang, ageSeconds, ttlSeconds, requestId });
      } else {
        logger.debug('DB miss for transcript', { videoId, language: effectiveLang, requestId });
      }
    } catch (dbErr) {
      logger.error('DB check for transcript failed; continuing to fetch from YouTube', { videoId, language: effectiveLang, requestId, error: dbErr });
    }

    // 3) Fetch -> Persist -> Cache
    const { info, resolvedLang } = await fetchPersistAndCache(c, videoId, effectiveLang, ttlSeconds, requestId);
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
    logger.error('Error in /v1/innertube/transcript', { err, mapped, videoId, language: effectiveLang, requestId });
    return c.json({ error: mapped.message || 'Internal Server Error', code: mapped.code }, mapped.status as any);
  }
});
