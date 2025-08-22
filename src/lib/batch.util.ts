import type { Context } from 'hono';
import type { AppSchema } from '@/app';
import { readBatchThrottle, throttleMap } from '@/lib/throttle.util';
import type { ErrorCode } from '@/lib/hono.util';
import type { SwrResult } from '@/lib/cache.util';

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
};

export async function processBatchIds<T>(
  c: Context<AppSchema>,
  ids: string[],
  opts: ProcessBatchOptions<T>
): Promise<Record<string, T | BatchError>> {
  const { includeStatusOnError = false, maxConcurrency = 5, minDelayFloorMs = 50 } = opts;
  const cfg: any = c.get('config');
  const { concurrency, minDelayMs, maxDelayMs } = readBatchThrottle(cfg, { maxConcurrency, minDelayFloorMs });

  const results: Record<string, T | BatchError> = {};
  await throttleMap(
    ids,
    async (id) => {
      const ex = await opts.extractEntityId(c, id);
      if (!ex.ok) {
        results[id] = { error: ex.error, code: ex.code };
        return;
      }
      const r = await opts.fetchOne(ex.entityId);
      if ((r as any)?.__error) {
        results[id] = includeStatusOnError
          ? { error: (r as any).error, code: (r as any).code, __status: (r as any).__status }
          : { error: (r as any).error, code: (r as any).code };
      } else {
        results[id] = (r as any).data as T;
      }
    },
    { concurrency, minDelayMs, maxDelayMs, signal: c.get('signal') as any }
  );

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
      return { ok: false, error: 'Only YouTube channel/video URL, channelId, handle, or videoId are allowed', code: 'BAD_REQUEST' as ErrorCode };
    }

    const url = urlById?.get(id) ?? null;
    if (!url) {
      return { ok: false, error: 'Only YouTube channel/video URL, channelId, handle, or videoId are allowed', code: 'BAD_REQUEST' as ErrorCode };
    }

    const ep = endpointMap.get(url);
    if (!ep) return { ok: false, error: `${fields[0] === 'browseId' ? 'Channel' : 'Video'} ID not found`, code: 'BAD_REQUEST' as ErrorCode };
    if ((ep as any)?.__error) return { ok: false, error: (ep as any).message, code: (ep as any).code };

    const payload = (ep as any)?.payload || {};
    for (const f of fields) {
      const val = payload?.[f];
      if (typeof val === 'string' && val.length > 0) {
        return { ok: true, entityId: val };
      }
    }
    return { ok: false, error: `${fields.join('/') } not found`, code: 'BAD_REQUEST' as ErrorCode };
  };
}
