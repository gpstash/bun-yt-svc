# Innertube Playlist API (v1)

Base path: `/v1/innertube/playlist`

Fetch playlist metadata and videos via YouTube Innertube. Supports channel uploads playlists, robust caching/SWR, and batch lookups.

References:
- Router: `src/router/v1/innertube/playlist.router.ts`
- Playlist persistence/types: `src/service/playlist.service.ts`
- Innertube service (videos + caching): `src/service/innertube.service.ts`
- Navigation middleware: `src/middleware/navigation.middleware.ts`, `src/middleware/navigation-batch.middleware.ts`
- Error mapping: `src/lib/hono.util.ts`

---

## GET /

Return normalized playlist info. Accepts a playlist id, playlist URL, or channel id/URL (converted to uploads playlist `UU...`).

- Uses `navigationMiddleware()` to resolve incoming `id` into `payload.playlistId`/`payload.listId` or `payload.browseId` (then converted to uploads).
- Fetches with SWR and persists to DB.

### Query parameters

- id (string, required)
  - Accepts: playlist URL (`...list=PL...`), bare playlist id (`PL.../UU.../OL.../LL...` etc.), channel URL/handle/channelId (`UC...` -> converted to `UU...`).

### Validation and resolution

- If `id` missing → 400 `{ error: "Missing playlist id", code: "BAD_REQUEST" }`.
- Resolution order:
  - From navigation endpoint: `payload.browseId` → convert to uploads `UU...` if channel id.
  - Or `payload.playlistId`/`payload.listId`.
  - Else `extractPlaylistId(id)` accepts URLs with `?list=...` or bare id matching `/^[A-Za-z0-9-_]{10,100}$/`.
- If none resolves → 400 `{ error: "Invalid playlist id or URL", code: "BAD_REQUEST" }`.

### Success response (200)

Returns a `PlaylistInfo` object (no wrapper):

```json
{
  "id": "PL... or UU...",
  "title": "...",
  "description": "...",
  "subtitle": "... or null",
  "author": { "id": "UC...", "name": "...", "url": "..." },
  "videoCount": "123",
  "viewCount": "4567",
  "lastUpdated": "2024-01-01T00:00:00.000Z"
}
```

Shape source: `PlaylistInfo` in `src/service/playlist.service.ts`.

### Error responses

Mapped via `mapErrorToHttp()`:
- 400: `BAD_REQUEST` (missing/invalid id)
- 404: `UPSTREAM_NOT_FOUND`
- 429: `UPSTREAM_RATE_LIMITED`
- 499: `CLIENT_CLOSED_REQUEST` (client aborted)
- 5xx: `INTERNAL_ERROR` or `UPSTREAM_*`

---

## GET /videos

Return the playlist videos as a flat list. Accepts playlist id/URL or channel id/URL (converted to uploads playlist `UU...`).

- Uses `navigationMiddleware()` to resolve `id` similarly to GET `/`.
- Calls `InnertubeService.getPlaylistVideos()` which implements caching, continuation paging, dedupe, and freshness revalidation.

### Query parameters

- id (string, required)

### Validation

- If no playlist id can be resolved → 400 `{ error: "Playlist ID not found", code: "BAD_REQUEST" }`.

### Success response (200)

Returns an array of `ChannelVideo` items (normalized to the same shape used for channel videos):

```json
[
  {
    "id": "VIDEO_ID",
    "type": "Video",
    "title": "...",
    "duration": "12:34",
    "published": "1 day ago",
    "viewCount": "123,456 views"
  }
]
```

Shape source: `ChannelVideo` in `src/service/innertube.service.ts`.

### Behavior and caching

- Throttling delays for pagination are derived via `readBatchThrottle(config, { maxConcurrency: 2, minDelayFloorMs: 50 })` and passed as `minDelayMs`/`maxDelayMs`.
- TTL used: `CHANNEL_CACHE_TTL_SECONDS` (reused for videos freshness).
- Cache key: `yt:playlist:{playlistId}:videos`.
- Cache shape internally:
  ```json
  {
    "items": [/* ChannelVideo[] */],
    "firstId": "VIDEO_ID or null",
    "updatedAt": 1710000000000,
    "staleAt": 1710003600000,
    "ttlSeconds": 600
  }
  ```
- Fresh vs stale handling:
  - Fresh (`now < staleAt`) → return cached `items`.
  - Stale → fetch first page, compare `firstId` with cached; if unchanged, extend freshness and return; else fetch full list (with continuation, jittered delays, dedupe) and update cache.
- Uses `singleflight` and `fetchWithRedisLock` to avoid thundering herd. Extended Redis TTL ~ `ttlSeconds * 30` with jitter.

### Error responses

Mapped via `mapErrorToHttp()`.

---

## POST /batch

Batch fetch playlist info for multiple inputs.

- Uses `navigationBatchMiddleware()` to resolve each input to either a playlist id (`playlistId`/`listId`) or a channel id (`browseId`), which is converted to uploads `UU...`.
- Uses shared batching helper `processBatchIds()` with a cache pre-check hook.

### Request body

```json
{ "ids": ["PLAYLIST_OR_URL_OR_CHANNEL", "..."] }
```

Validation:
- `ids`: array of strings, min 1, max 50.
- Invalid JSON → 400 `{ error: "Invalid JSON body", code: "BAD_REQUEST" }`.
- Invalid item → 400 with first issue message (e.g., `Invalid playlist id`).

### Response (200)

Returns an object keyed by the original input ids. Each value is either the playlist payload (same as GET `/`) or an error object `{ error, code }`.

Example:

```json
{
  "https://www.youtube.com/playlist?list=PL...": {
    "id": "PL...",
    "title": "...",
    "videoCount": "123"
  },
  "invalid": { "error": "Invalid playlist id or URL", "code": "BAD_REQUEST" }
}
```

Notes:
- Error messages may be `Playlist ID not found` when navigation could not resolve the id, or `Only YouTube channel/video URL, channelId, handle, or videoId are allowed` if the URL was not acceptable to the navigation resolver.

---

## Caching and SWR

- Playlist info cache key: `yt:playlist:{playlistId}`
  - TTL: `VIDEO_CACHE_TTL_SECONDS` (same as video policy).
  - GET `/` uses `swrResolve` with `serveStale: false` (wait for fresh, but DB may serve while fetching).
  - Negative caching: Only client 4xx with `code: BAD_REQUEST`.

- Playlist videos cache key: `yt:playlist:{playlistId}:videos`
  - Freshness window controlled by `ttlSeconds` (defaults ~600s unless overridden via router passing `CHANNEL_CACHE_TTL_SECONDS`).
  - Uses first-page check to extend cache when no upstream changes.

---

## Error code glossary (selected)

- `BAD_REQUEST`
- `UPSTREAM_NOT_FOUND`, `UPSTREAM_RATE_LIMITED`, `UPSTREAM_UNAVAILABLE`, `UPSTREAM_BAD_GATEWAY`
- `CLIENT_CLOSED_REQUEST`
- `INTERNAL_ERROR`

---

## Examples

- Single playlist info by URL:
  ```http
  GET /v1/innertube/playlist?id=https://www.youtube.com/playlist?list=PLxxxxxxxx
  ```

- Single uploads playlist by channel id:
  ```http
  GET /v1/innertube/playlist?id=UCxxxxxxxxxxxxxxxxxxxxxx
  ```

- Playlist videos:
  ```http
  GET /v1/innertube/playlist/videos?id=PLxxxxxxxx
  ```

- Batch playlist info:
  ```http
  POST /v1/innertube/playlist/batch
  Content-Type: application/json

  { "ids": ["https://www.youtube.com/playlist?list=PL...", "UC...", "PL..."] }
  ```
