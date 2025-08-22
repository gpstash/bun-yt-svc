import { createLogger } from '@/lib/logger.lib';
import { HttpError } from '@/lib/http.lib';
import { Context, Hono } from 'hono';
import type { AppSchema } from '@/app';
import { isClientAbort, STATUS_CLIENT_CLOSED_REQUEST, mapErrorToHttp, ERROR_CODES } from '@/lib/hono.util';
import type { ErrorCode } from '@/lib/hono.util';
import { z } from 'zod';
import { redisGetJson, redisSetJson, redisMGetJson } from '@/lib/redis.lib';
import { swrResolve } from '@/lib/cache.util';
import { getTranscriptByVideoAndLanguage, upsertTranscript, getPreferredTranscriptLanguage, hasTranscriptLanguage } from '@/service/transcript.service';
import { processBatchIds, extractFromNavigation } from '@/lib/batch.util';
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


// Shared single-fetch used by GET route (mirrors batchFetchOne behavior but returns same shape)
async function fetchOne(
  c: Context<AppSchema>,
  videoId: string,
  requestedLang: string | undefined | null,
) {
  const requestId = c.get('requestId');
  const { effectiveLang } = await resolveEffectiveLanguage(videoId, requestedLang, requestId);
  const ttlSeconds = c.get('config').TRANSCRIPT_CACHE_TTL_SECONDS as number;
  const cacheKey = buildCacheKey(videoId, effectiveLang);

  const result = await swrResolve<any, { language: string; segments: Array<{ text: string }>; updatedAt: Date }>(
    {
      cacheKey,
      ttlSeconds,
      serveStale: true,
      getFromDb: async () => await getTranscriptByVideoAndLanguage(videoId, effectiveLang || ''),
      dbUpdatedAt: (db) => db.updatedAt,
      assembleFromDb: async (dbRes, remainingTtl) => {
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
        if (!requestedLang) {
          try { await setAlias(videoId, dbRes.language, Math.max(1, remainingTtl)); } catch { /* noop */ }
        }
        return assembled;
      },
      fetchPersist: async () => {
        logger.info('Cache miss for transcript, fetching from YouTube', { videoId, language: effectiveLang, requestId });
        const info = await c.get('innertubeSvc').getTranscript(videoId, effectiveLang ?? undefined, { signal: c.get('signal'), requestId });
        const resolvedLang = (info as any)?.transcript?.language ?? effectiveLang ?? 'default';

        try {
          const vres = await upsertVideo(info as any);
          logger.debug('Video upsert completed prior to transcript', { videoId, upserted: (vres as any)?.upserted, requestId });
        } catch (videoPersistErr) {
          logger.error('Video upsert failed prior to transcript', { videoId, requestId, error: videoPersistErr });
        }

        try {
          await upsertTranscript(videoId, resolvedLang, { segments: (info as any).transcript?.segments });
          logger.info('Transcript upsert completed', { videoId, language: resolvedLang, requestId });
        } catch (persistErr) {
          logger.error('Transcript upsert failed', { videoId, language: resolvedLang, requestId, error: persistErr });
        }

        if (!requestedLang) {
          try { await setAlias(videoId, resolvedLang, ttlSeconds); } catch { /* noop */ }
        }
        return info as any;
      },
      shouldNegativeCache: (status, code) => (status >= 400 && status < 500 && LANG_RELATED_CODES.has(code as ErrorCode)),
    }
  );

  return result as any;
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
    const results = await processBatchIds(c, ids, {
      extractEntityId: extractFromNavigation('videoId'),
      fetchOne: (entityId: string) => fetchOne(c, entityId, l),
      getCachedManyByEntityId: async (entityIds) => {
        if (!l) return new Map();
        const keys = entityIds.map((eid) => buildCacheKey(eid, l));
        const m = await redisMGetJson<any>(keys);
        const out = new Map<string, any>();
        for (let i = 0; i < entityIds.length; i++) {
          const eid = entityIds[i];
          const val = m.get(keys[i]);
          if (val) out.set(eid, val);
        }
        logger.debug('Transcript batch cache pre-check', {
          requested: entityIds.length,
          hits: out.size,
          language: l ?? null,
          requestId: c.get('requestId'),
        });
        return out;
      },
    });
    logger.info('Transcript batch processed', { count: ids.length, requestId });
    return c.json(results);
  } catch (err) {
    const mapped = mapErrorToHttp(err);
    logger.error('Error in /v1/innertube/transcript/batch', { err, mapped, requestId });
    return c.json({ error: mapped.message || 'Internal Server Error', code: mapped.code }, mapped.status as any);
  }
});
