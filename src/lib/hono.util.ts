import { HttpError } from '@/lib/http.lib';
import { createLogger } from '@/lib/logger.lib';

const logger = createLogger('lib:hono.util');

/**
 * Return true when the error represents a client-aborted request.
 * - HttpError with code 'EABORT'
 * - DOMException/AbortError by name
 */
export function isClientAbort(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof HttpError && err.code === 'EABORT') return true;
  const name = (err as any)?.name as string | undefined;
  return name === 'AbortError' || name === 'DOMException';
}

export const STATUS_CLIENT_CLOSED_REQUEST = 499; // Nginx non-standard

/**
 * Canonical error codes for API responses.
 */
export const ERROR_CODES = {
  // Client side
  CLIENT_CLOSED_REQUEST: 'CLIENT_CLOSED_REQUEST',
  BAD_REQUEST: 'BAD_REQUEST',

  // Validation
  INVALID_LANGUAGE: 'INVALID_LANGUAGE',
  INVALID_TRANSLATE_LANGUAGE: 'INVALID_TRANSLATE_LANGUAGE',

  // Upstream/Network
  UPSTREAM_TIMEOUT: 'UPSTREAM_TIMEOUT',
  UPSTREAM_ABORTED: 'UPSTREAM_ABORTED',
  UPSTREAM_RATE_LIMITED: 'UPSTREAM_RATE_LIMITED',
  UPSTREAM_UNAVAILABLE: 'UPSTREAM_UNAVAILABLE',
  UPSTREAM_BAD_GATEWAY: 'UPSTREAM_BAD_GATEWAY',
  UPSTREAM_NOT_FOUND: 'UPSTREAM_NOT_FOUND',

  // YouTube/Innertube specific (best-effort based on error messages)
  YT_LOGIN_REQUIRED: 'YT_LOGIN_REQUIRED',
  YT_AGE_RESTRICTED: 'YT_AGE_RESTRICTED',
  YT_GEO_BLOCKED: 'YT_GEO_BLOCKED',
  YT_PRIVATE: 'YT_PRIVATE',
  YT_UNAVAILABLE: 'YT_UNAVAILABLE',
  YT_TRANSCRIPT_UNAVAILABLE: 'YT_TRANSCRIPT_UNAVAILABLE',
  YT_CONTENT_CHECK_REQUIRED: 'YT_CONTENT_CHECK_REQUIRED',
  YT_LIVE_STREAM_OFFLINE: 'YT_LIVE_STREAM_OFFLINE',
  YT_EMBED_BLOCKED: 'YT_EMBED_BLOCKED',
  YT_INVALID_ID: 'YT_INVALID_ID',
  YT_PLAYABILITY_ERROR: 'YT_PLAYABILITY_ERROR',
  YT_TRANSLATION_UNSUPPORTED: 'YT_TRANSLATION_UNSUPPORTED',
  YT_TRANSLATION_SAME_LANGUAGE: 'YT_TRANSLATION_SAME_LANGUAGE',
  // Continuation specific
  YT_CONTINUATION_FAILED: 'YT_CONTINUATION_FAILED',
  YT_CONTINUATION_EXHAUSTED: 'YT_CONTINUATION_EXHAUSTED',

  // Generic
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = typeof ERROR_CODES[keyof typeof ERROR_CODES];

// Centralized BAD_REQUEST messages for uniform phrasing
export function msgNavInputInvalid(): string {
  return 'Only YouTube channel/video URL, channelId, handle, or videoId are allowed';
}
export function msgChannelIdNotFound(): string {
  return 'Channel ID not found';
}
export function msgVideoIdNotFound(): string {
  return 'Video ID not found';
}
export function msgPayloadFieldsNotFound(fields: string[]): string {
  return `${fields.join('/')} not found`;
}

function detectYouTubeError(err: unknown): { status: number; code: ErrorCode; message: string } | undefined {
  if (!err) return undefined;
  const name = (err as any)?.name as string | undefined;
  const message = String((err as any)?.message || '');
  const info = (err as any)?.info as unknown;
  const infoText = typeof info === 'string' ? info : JSON.stringify(info ?? '');

  const text = `${name || ''} ${message} ${infoText}`.toLowerCase();
  // Heuristics based on common Innertube/YouTube error messages and playability reasons
  // These strings may come from playability_status.reason or InnertubeError messages
  const has = (s: string) => text.includes(s.toLowerCase());

  // Invalid ID
  if (has('invalid video id') || has('invalid videoid') || has('invalid parameters')) {
    return { status: 400, code: ERROR_CODES.YT_INVALID_ID, message: 'Invalid video id' };
  }
  // Login required / Sign in
  if (has('login required') || has('sign in to confirm your age') || has('signin required') || has('sign in')) {
    return { status: 401, code: ERROR_CODES.YT_LOGIN_REQUIRED, message: 'Login required' };
  }
  // Age restricted
  if (has('age') && (has('restricted') || has('confirm your age'))) {
    return { status: 403, code: ERROR_CODES.YT_AGE_RESTRICTED, message: 'Age restricted content' };
  }
  // Private video
  if (has('video is private') || has('private video')) {
    return { status: 403, code: ERROR_CODES.YT_PRIVATE, message: 'Private video' };
  }
  // Geo blocked
  if (has('not available in your country') || has('blocked in your country') || has('geo')) {
    return { status: 451, code: ERROR_CODES.YT_GEO_BLOCKED, message: 'Geo-blocked' };
  }
  // Embed disabled
  if (has('playback on other websites has been disabled') || has('embedding disabled')) {
    return { status: 451, code: ERROR_CODES.YT_EMBED_BLOCKED, message: 'Embedding disabled by owner' };
  }
  // Content check required / controversial content
  if (has('content check required') || has('sensitive content')) {
    return { status: 423, code: ERROR_CODES.YT_CONTENT_CHECK_REQUIRED, message: 'Content check required' };
  }
  // Live stream offline
  if (has('live stream offline') || has('live_stream_offline')) {
    return { status: 409, code: ERROR_CODES.YT_LIVE_STREAM_OFFLINE, message: 'Live stream offline' };
  }
  // General unavailability
  if (has('video unavailable') || has('this video is unavailable') || has('unplayable') || has('unavailable')) {
    return { status: 404, code: ERROR_CODES.YT_UNAVAILABLE, message: 'Video unavailable' };
  }

  // Resolve URL / generic upstream 404 phrasing seen from youtubei navigation
  if (has('requested entity was not found')) {
    return { status: 404, code: ERROR_CODES.UPSTREAM_NOT_FOUND, message: 'Resource not found upstream' };
  }

  // Transcript unavailable / disabled / not found
  if ((has('transcript') || has('caption')) && (has('not available') || has('unavailable') || has('disabled') || has('not found'))) {
    return { status: 404, code: ERROR_CODES.YT_TRANSCRIPT_UNAVAILABLE, message: 'Transcript unavailable' };
  }
  // Continuation-specific failures
  if (has('continuation')) {
    if (has('invalid') || has('expired') || has('not found') || has('missing') || has('failed')) {
      return { status: 409, code: ERROR_CODES.YT_CONTINUATION_FAILED, message: 'Continuation failed' };
    }
    if (has('no more') || has('exhausted') || has('end of') || has('finished')) {
      return { status: 200, code: ERROR_CODES.YT_CONTINUATION_EXHAUSTED, message: 'Continuation exhausted' };
    }
  }
  // Our app-level validation & translation errors
  if (has('invalid language')) {
    return { status: 400, code: ERROR_CODES.INVALID_LANGUAGE, message: 'Invalid language' };
  }
  if (has('invalid translate language')) {
    return { status: 400, code: ERROR_CODES.INVALID_TRANSLATE_LANGUAGE, message: 'Invalid translate language' };
  }
  if (has('translation unsupported') || has('not translatable')) {
    return { status: 400, code: ERROR_CODES.YT_TRANSLATION_UNSUPPORTED, message: 'Translation unsupported for selected language' };
  }
  if (has('same language') && has('translate')) {
    return { status: 400, code: ERROR_CODES.YT_TRANSLATION_SAME_LANGUAGE, message: 'Translate language must differ from source' };
  }
  // SABRE / App restrictions (web client not allowed)
  if (has('not available on this app') || has('sabr') || has('sabre')) {
    return { status: 409, code: ERROR_CODES.YT_PLAYABILITY_ERROR, message: 'Not available on this client' };
  }

  // If it's an InnertubeError without a better match, surface generic playability issue
  if ((name || '').toLowerCase().includes('innertube')) {
    return { status: 409, code: ERROR_CODES.YT_PLAYABILITY_ERROR, message: 'Playability error' };
  }

  return undefined;
}

/**
 * Map internal HttpError or generic errors to HTTP status and canonical code.
 */
export function mapErrorToHttp(err: unknown): { status: number; code: ErrorCode; message?: string } {
  // HttpError from our http.lib carries rich info
  if (err instanceof HttpError) {
    // Timeout -> 504
    if (err.code === 'ETIMEDOUT') {
      return { status: 504, code: ERROR_CODES.UPSTREAM_TIMEOUT, message: 'Upstream request timed out' };
    }
    // Explicit abort from upstream fetch (not client abort which is handled separately)
    if (err.code === 'EABORT') {
      return { status: 502, code: ERROR_CODES.UPSTREAM_ABORTED, message: 'Upstream request aborted' };
    }

    // If upstream HTTP status is known, map common cases
    const s = err.status;
    if (typeof s === 'number') {
      if (s === 404) return { status: 404, code: ERROR_CODES.UPSTREAM_NOT_FOUND, message: 'Resource not found upstream' };
      if (s === 429) return { status: 429, code: ERROR_CODES.UPSTREAM_RATE_LIMITED, message: 'Upstream rate limited' };
      if (s === 503) return { status: 503, code: ERROR_CODES.UPSTREAM_UNAVAILABLE, message: 'Upstream unavailable' };
      if (s >= 500) return { status: 502, code: ERROR_CODES.UPSTREAM_BAD_GATEWAY, message: `Upstream error (${s})` };
      // For other statuses, surface as 502 by default
      return { status: 502, code: ERROR_CODES.UPSTREAM_BAD_GATEWAY, message: `Upstream error (${s})` };
    }

    // Fallback for HttpError without status
    return { status: 502, code: ERROR_CODES.UPSTREAM_BAD_GATEWAY, message: 'Upstream request failed' };
  }

  // youtubei.js / Innertube specific messages
  const yt = detectYouTubeError(err);
  if (yt) {
    logger.debug('Mapped YouTube error', { yt, raw: { name: (err as any)?.name, message: (err as any)?.message } });
    return yt;
  }

  // Generic AbortError (non-HttpError)
  const name = (err as any)?.name as string | undefined;
  if (name === 'AbortError' || name === 'DOMException') {
    return { status: 502, code: ERROR_CODES.UPSTREAM_ABORTED, message: 'Upstream request aborted' };
  }

  // Unknown -> 500
  return { status: 500, code: ERROR_CODES.INTERNAL_ERROR, message: 'Internal Server Error' };
}
