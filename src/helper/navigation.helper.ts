import { redisGetJson, redisSetJson } from '@/lib/redis.lib';
import { jitterTtl } from '@/lib/cache.util';

export function isValidYoutubeChannelUrl(url: string): boolean {
  try {
    const u = new URL(url);

    if (!isHttpProtocol(u.protocol)) return false;
    if (!isYoutubeHost(u.hostname)) return false;

    const path = u.pathname;
    return (
      isChannelIdPath(path) ||
      isHandlePath(path) ||
      isLegacyUserOrCustomPath(path)
    );
  } catch {
    return false;
  }
}

export function isValidYoutubeWatchUrl(url: string): boolean {
  try {
    const u = new URL(url);

    if (!isHttpProtocol(u.protocol)) return false;
    if (!(isYoutubeHost(u.hostname) || isYoutuBeHost(u.hostname))) return false;

    return (
      hasWatchWithVideoId(u) ||
      isShortsPath(u.pathname) ||
      isEmbedPath(u.pathname) ||
      isLivePath(u.pathname) ||
      isYoutuBePath(u.hostname, u.pathname)
    );
  } catch {
    return false;
  }
}

export function isValidHandle(handle: string): boolean {
  // Accept forms: "@handle", "handle", optional leading '/'
  const trimmed = handle.trim();
  const withoutSlash = trimmed.startsWith('/') ? trimmed.slice(1) : trimmed;
  const withoutAt = withoutSlash.startsWith('@') ? withoutSlash.slice(1) : withoutSlash;
  // 3-30 chars, alnum with . _ -
  return /^[a-z0-9._-]{3,30}$/i.test(withoutAt);
}

export function isValidChannelId(channelId: string): boolean {
  // Accept raw UC id, optionally prefixed with '/channel/' and optional trailing '/'
  let id = channelId.trim();
  // Collapse multiple slashes
  id = id.replace(/\/+/g, '/');
  // Remove leading slashes
  id = id.replace(/^\/+/, '');
  // Remove optional 'channel/' prefix (case-insensitive)
  if (/^channel\//i.test(id)) id = id.slice('channel/'.length);
  // Remove trailing slashes
  id = id.replace(/\/+$/, '');
  return /^[Uu][Cc][0-9A-Za-z_-]{22}$/.test(id);
}

// ===== URL builders =====
export function buildChannelUrlFromId(input: string): string | null {
  if (!isValidChannelId(input)) return null;
  const normalized = input
    .trim()
    .replace(/\/+/g, '/')
    .replace(/^\/+|\/+$/g, '');
  const match = normalized.match(/UC[0-9A-Za-z_-]{22}/i);
  const uc = (match ? match[0] : normalized).replace(/^uc/, 'UC');
  return `https://www.youtube.com/channel/${uc}`;
}

export function buildWatchUrlFromVideoId(input: string): string | null {
  const id = input.trim();
  if (!isValidVideoId(id)) return null;
  return `https://www.youtube.com/watch?v=${id}`;
}

export function buildChannelUrlFromHandle(input: string): string | null {
  if (!isValidHandle(input)) return null;
  let h = input.trim();
  if (h.startsWith('/')) h = h.slice(1);
  if (!h.startsWith('@')) h = `@${h}`;
  return `https://www.youtube.com/${h}`;
}

// Shared function: build a canonical YouTube URL from an arbitrary id or URL
// - Accepts direct YouTube channel/video URLs, channelId (UC...), videoId, or handle
// - Returns canonical URL string or null if unsupported
export function buildYoutubeUrlFromId(id: string): string | null {
  if (!id || typeof id !== 'string') return null;
  const trimmed = id.trim();
  if (!trimmed) return null;

  if (isValidYoutubeChannelUrl(trimmed) || isValidYoutubeWatchUrl(trimmed)) {
    return trimmed;
  }
  if (isValidChannelId(trimmed)) {
    return buildChannelUrlFromId(trimmed) ?? null;
  }
  if (isValidVideoId(trimmed)) {
    return buildWatchUrlFromVideoId(trimmed) ?? null;
  }
  if (isValidHandle(trimmed)) {
    return buildChannelUrlFromHandle(trimmed) ?? null;
  }
  return null;
}

function isHttpProtocol(protocol: string): boolean {
  return protocol === 'http:' || protocol === 'https:';
}

function isYoutubeHost(hostname: string): boolean {
  // Allow youtube.com and any subdomain like www.youtube.com, m.youtube.com, music.youtube.com
  return hostname === 'youtube.com' || hostname.endsWith('.youtube.com');
}

function isYoutuBeHost(hostname: string): boolean {
  return hostname === 'youtu.be';
}

// Accept optional channel tab segments after the main identifier
const tabSegment = '(?:/(videos|shorts|streams|about|community|featured|playlists))?/?$';

function isChannelIdPath(pathname: string): boolean {
  // Channel ID format: /channel/UC[22 chars of [0-9A-Za-z_-]]
  const re = new RegExp(`^/channel/UC[0-9A-Za-z_-]{22}${tabSegment}`);
  return re.test(pathname);
}

export async function resolveNavigationWithCache(innertube: { resolveURL: (url: string) => Promise<any> }, url: string, config: { VIDEO_CACHE_TTL_SECONDS: number; CHANNEL_CACHE_TTL_SECONDS: number; }): Promise<any> {
  const isWatch = isValidYoutubeWatchUrl(url);
  const videoTtl = config.VIDEO_CACHE_TTL_SECONDS;
  const channelTtl = config.CHANNEL_CACHE_TTL_SECONDS;
  const ttl = isWatch ? videoTtl : channelTtl;
  const cacheKey = `yt:navigation:${isWatch ? 'watch' : 'channel'}:${url}`;

  const cached = await redisGetJson<any>(cacheKey).catch(() => null);
  if (cached) return cached;

  const navigationEndpoint = await innertube.resolveURL(url);
  try { await redisSetJson(cacheKey, navigationEndpoint, jitterTtl(ttl)); } catch { /* noop */ }
  return navigationEndpoint;
}

function isHandlePath(pathname: string): boolean {
  // Handle format: /@handle with 3-30 chars [a-z0-9._-]
  const re = new RegExp(`^/@[a-z0-9._-]{3,30}${tabSegment}`, 'i');
  return re.test(pathname);
}

function isLegacyUserOrCustomPath(pathname: string): boolean {
  // Legacy custom URLs: /user/<name> or /c/<name>
  // Name starts with alnum, then alnum/_/-
  const re = new RegExp(`^/(user|c)/[A-Za-z0-9][A-Za-z0-9_-]*${tabSegment}`);
  return re.test(pathname);
}

// ===== Video URL helpers =====
function isVideoId(id: string | null): boolean {
  return !!id && /^[0-9A-Za-z_-]{11}$/.test(id);
}

export function isValidVideoId(id: string): boolean {
  // Public validator for bare YouTube video IDs (11 chars, URL-safe base64-like)
  return /^[0-9A-Za-z_-]{11}$/.test(id.trim());
}

function hasWatchWithVideoId(u: URL): boolean {
  if (u.pathname !== '/watch') return false;
  return isVideoId(u.searchParams.get('v'));
}

function isShortsPath(pathname: string): boolean {
  const re = /^\/shorts\/[0-9A-Za-z_-]{11}(?:[/?].*)?$/;
  return re.test(pathname);
}

function isEmbedPath(pathname: string): boolean {
  const re = /^\/embed\/[0-9A-Za-z_-]{11}(?:[/?].*)?$/;
  return re.test(pathname);
}

function isLivePath(pathname: string): boolean {
  // Some live videos are accessible via /live/VIDEO_ID
  const re = /^\/live\/[0-9A-Za-z_-]{11}(?:[/?].*)?$/;
  return re.test(pathname);
}

function isYoutuBePath(hostname: string, pathname: string): boolean {
  if (!isYoutuBeHost(hostname)) return false;
  // youtu.be/<VIDEO_ID>
  const re = /^\/[0-9A-Za-z_-]{11}(?:[/?].*)?$/;
  return re.test(pathname);
}