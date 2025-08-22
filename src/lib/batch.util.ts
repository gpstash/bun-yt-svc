import type { Context } from 'hono';
import type { AppSchema } from '@/app';
import { readBatchThrottle, throttleMap } from '@/lib/throttle.util';
import { msgChannelIdNotFound, msgNavInputInvalid, msgPayloadFieldsNotFound, msgVideoIdNotFound, type ErrorCode } from '@/lib/hono.util';
import type { SwrResult } from '@/lib/cache.util';
import { createLogger } from '@/lib/logger.lib';

export type BatchError = { error: string; code: ErrorCode | string; __status?: number };

export type ExtractEntityIdResult =
  | { ok: true; entityId: string }
  | { ok: false; error: string; code: ErrorCode };

export type ExtractEntityId = (
  c: Context<AppSchema>,
  id: string
) => Promise<ExtractEntityIdResult> | ExtractEntityIdResult;

export type ProcessBatchOptions<T> = {
  // Transform input id -> target entity id (e.g., videoId, browseId)
  extractEntityId: ExtractEntityId;
  // Fetch single item using swrResolve-backed resolver
  fetchOne: (entityId: string) => Promise<SwrResult<T>>;
  // Whether to include __status in error mapping (caption requires it)
  includeStatusOnError?: boolean;
  // Throttle hints
  maxConcurrency?: number;
  minDelayFloorMs?: number;
  // Optional cache hooks for smart throttling
  // Prefer getCachedManyByEntityId when available for fewer round trips
  getCachedManyByEntityId?: (entityIds: readonly string[]) => Promise<Map<string, T>>;
  getCachedByEntityId?: (entityId: string) => Promise<T | null>;
};

export async function processBatchIds<T>(
  c: Context<AppSchema>,
  ids: string[],
  opts: ProcessBatchOptions<T>
): Promise<Record<string, T | BatchError>> {
  const { includeStatusOnError = false, maxConcurrency = 5, minDelayFloorMs = 50, getCachedManyByEntityId, getCachedByEntityId } = opts;
  const cfg: any = c.get('config');
  const { concurrency, minDelayMs, maxDelayMs } = readBatchThrottle(cfg, { maxConcurrency, minDelayFloorMs });
  const requestId = c.get('requestId');
  const logger = createLogger('lib:batch');
  const startedAt = Date.now();
  logger.info('Batch start', { count: ids.length, concurrency, minDelayMs, maxDelayMs, requestId });

  const results: Record<string, T | BatchError> = {};
  let failures = 0;
  let successes = 0;

  // 1) Extract entity ids up-front (no throttle)
  type Extracted = { id: string; ok: true; entityId: string } | { id: string; ok: false; error: string; code: ErrorCode };
  const extracted: Extracted[] = await Promise.all(
    ids.map(async (id) => {
      try {
        const ex = await opts.extractEntityId(c, id);
        if (ex.ok) return { id, ok: true as const, entityId: ex.entityId };
        return { id, ok: false as const, error: ex.error, code: ex.code };
      } catch (e: any) {
        const message = e?.message || 'Unexpected error';
        return { id, ok: false as const, error: message, code: 'INTERNAL_ERROR' as ErrorCode };
      }
    })
  );

  // Immediately record extraction failures
  for (const ex of extracted) {
    if (!ex.ok) {
      failures++;
      results[ex.id] = { error: ex.error, code: ex.code };
      logger.warn('Batch item failed to extract entity id', { id: ex.id, error: ex.error, code: ex.code, requestId });
    }
  }

  const okExtractions = extracted.filter((e): e is Extracted & { ok: true } => e.ok);
  if (okExtractions.length === 0) {
    const durationMs = Date.now() - startedAt;
    logger.info('Batch end', { count: ids.length, successes, failures, durationMs, requestId });
    return results;
  }

  // Build id -> entityId and dedupe entityIds
  const idToEntity = new Map<string, string>();
  for (const e of okExtractions) idToEntity.set(e.id, e.entityId);
  const uniqueEntityIds: string[] = Array.from(new Set(okExtractions.map((e) => e.entityId)));

  // 2) Cache pre-check (optional)
  const cachedByEntity = new Map<string, T>();
  if (getCachedManyByEntityId) {
    try {
      const map = await getCachedManyByEntityId(uniqueEntityIds);
      for (const [k, v] of map) cachedByEntity.set(k, v);
    } catch (e) {
      logger.warn('getCachedManyByEntityId failed; continuing without bulk cache', { requestId });
    }
  } else if (getCachedByEntityId) {
    // Fallback: parallel single GETs
    const pairs = await Promise.all(
      uniqueEntityIds.map(async (eid) => {
        try {
          const v = await getCachedByEntityId(eid);
          return v ? [eid, v] as const : null;
        } catch { return null; }
      })
    );
    for (const p of pairs) if (p) cachedByEntity.set(p[0], p[1]);
  }

  const missesUnique = uniqueEntityIds.filter((eid) => !cachedByEntity.has(eid));
  const hits = uniqueEntityIds.length - missesUnique.length;
  logger.debug('Batch cache pre-check', { unique: uniqueEntityIds.length, hits, misses: missesUnique.length, requestId });

  // 3) Fetch only misses with throttling; others are immediate
  const fetchedByEntity = new Map<string, SwrResult<T>>();
  if (missesUnique.length > 0) {
    const fetchResults = await throttleMap(
      missesUnique,
      async (entityId) => {
        try {
          return await opts.fetchOne(entityId);
        } catch (e: any) {
          // Normalize thrown error into SwrResult-like shape
          return { __error: true, error: e?.message || 'Unexpected error', code: 'INTERNAL_ERROR' } as any;
        }
      },
      { concurrency, minDelayMs, maxDelayMs, signal: c.get('signal') as any }
    );
    for (let i = 0; i < missesUnique.length; i++) {
      fetchedByEntity.set(missesUnique[i], fetchResults[i]);
    }
  }

  // 4) Assemble per-id results from cache/fetch maps
  for (const id of ids) {
    if (results[id]) continue; // already has extraction failure recorded
    const eid = idToEntity.get(id);
    if (!eid) continue; // safety

    if (cachedByEntity.has(eid)) {
      successes++;
      results[id] = cachedByEntity.get(eid)!;
      continue;
    }

    const r = fetchedByEntity.get(eid);
    if (!r) {
      // Should not happen; treat as internal error
      failures++;
      results[id] = { error: 'Missing fetch result', code: 'INTERNAL_ERROR' };
      logger.error('Batch missing fetch result for entity', { id, entityId: eid, requestId });
      continue;
    }

    if ((r as any)?.__error) {
      failures++;
      const errPayload = includeStatusOnError
        ? { error: (r as any).error, code: (r as any).code, __status: (r as any).__status }
        : { error: (r as any).error, code: (r as any).code };
      results[id] = errPayload as any;
      logger.warn('Batch item fetch failed', { id, entityId: eid, error: (r as any).error, code: (r as any).code, requestId });
    } else {
      successes++;
      results[id] = (r as any).data as T;
    }
  }

  const durationMs = Date.now() - startedAt;
  logger.info('Batch end', { count: ids.length, successes, failures, durationMs, requestId });
  return results;
}

// Convenience extractor using navigationBatchMiddleware's context
export function extractFromNavigation(
  payloadField: 'videoId' | 'browseId' | 'playlistId' | 'listId' | Array<'playlistId' | 'listId'>,
  options?: { allowFallbackRawIdWhenNoMap?: boolean }
): ExtractEntityId {
  const fields = Array.isArray(payloadField) ? payloadField : [payloadField];
  const allowFallback = options?.allowFallbackRawIdWhenNoMap === true;

  return (c: Context<AppSchema>, id: string): ExtractEntityIdResult => {
    const urlById = c.get('batchUrlById') as Map<string, string | null> | undefined;
    const endpointMap = c.get('navigationEndpointMap') as Map<string, any> | undefined;

    // If we have no endpointMap, optionally allow raw id fallback
    if (!endpointMap) {
      if (allowFallback) {
        return { ok: true, entityId: id };
      }
      return { ok: false, error: msgNavInputInvalid(), code: 'BAD_REQUEST' as ErrorCode };
    }

    const url = urlById?.get(id) ?? null;
    if (!url) {
      return { ok: false, error: msgNavInputInvalid(), code: 'BAD_REQUEST' as ErrorCode };
    }

    const ep = endpointMap.get(url);
    if (!ep) return { ok: false, error: (fields[0] === 'browseId' ? msgChannelIdNotFound() : msgVideoIdNotFound()), code: 'BAD_REQUEST' as ErrorCode };
    if ((ep as any)?.__error) return { ok: false, error: (ep as any).message, code: (ep as any).code };

    const payload = (ep as any)?.payload || {};
    for (const f of fields) {
      const val = payload?.[f];
      if (typeof val === 'string' && val.length > 0) {
        return { ok: true, entityId: val };
      }
    }
    return { ok: false, error: msgPayloadFieldsNotFound(fields), code: 'BAD_REQUEST' as ErrorCode };
  };
}
