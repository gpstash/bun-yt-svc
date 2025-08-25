# Innertube Channel API (v1)

Base path: `/v1/innertube/channel`

Fetch channel metadata and videos from YouTube via Innertube with robust caching, SWR behavior, and batch support.

References:
- Router: `src/router/v1/innertube/channel.router.ts`
- Channel parser: `src/helper/channel.helper.ts`
- Innertube service (shapes for videos): `src/service/innertube.service.ts`
- Error mapping: `src/lib/hono.util.ts`

---

## GET /

Return normalized channel info for a single channel.

- Input channel is resolved by `navigationMiddleware()` from `id` (YouTube URL, handle, channel URL, or channelId) provided in the query string.
- Uses SWR flow (serve-stale) with cache and DB persistence.

### Query parameters

- id (string, required)
  - Supported: channel URL, handle (`@handle`), channelId (`UC...`), or any YouTube URL resolvable to a channel.

### Success response (200)

Returns a `ParsedChannelInfo` object:

```json
{
  "id": "UC...",
  "title": "...",
  "description": "...",
  "url": "https://www.youtube.com/channel/UC...",
  "vanityUrl": "https://www.youtube.com/@handle",
  "isFamilySafe": true,
  "keywords": ["..."],
  "avatar": { "url": "...", "width": 88, "height": 88 },
  "thumbnail": { "url": "...", "width": 800, "height": 800 },
  "tags": ["..."],
  "isUnlisted": false,
  "subscriberCount": "1,234,567 subscribers",
  "viewCount": "123,456,789 views",
  "joinedDate": "Jan 1, 2020",
  "videoCount": "123 videos",
  "country": "US"
}
```

Field source: `ParsedChannelInfo` from `src/helper/channel.helper.ts`.

### Error responses

Mapped via `mapErrorToHttp()`:
- 400: `BAD_REQUEST` (e.g., missing resolvable `browseId`, returns `{ error: "Channel ID not found", code: "BAD_REQUEST" }`).
- 404: `UPSTREAM_NOT_FOUND`
- 429: `UPSTREAM_RATE_LIMITED`
- 451: `YT_GEO_BLOCKED` (rare for channels)
- 499: `CLIENT_CLOSED_REQUEST` (client aborted)
- 5xx: `UPSTREAM_*` or `INTERNAL_ERROR`

---

## GET /videos

Return the channel's uploaded videos as a flat list. Uses a specialized cache with quick stale-check and extension.

- Input channel is resolved by `navigationMiddleware()` from query `id`.
- Freshness policy relies on `CHANNEL_CACHE_TTL_SECONDS`.
- Behavior:
  - If cache is fresh (now < `staleAt`) → return cached `items`.
  - If stale → fetch first page and compare `firstId`:
    - If unchanged → extend freshness window and return cached `items`.
    - If changed → fetch full list (with continuation, dedupe, and small jitter delays) and update cache.
  - Initial miss → fetch full list and populate cache.

### Success response (200)

Returns an array of `ChannelVideo` items:

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

`ChannelVideo` shape source: `src/service/innertube.service.ts` (`ChannelVideo`).

### Error responses

Mapped via `mapErrorToHttp()`.
- 400: `BAD_REQUEST` when `browseId` missing (`Channel ID not found`).
- 404/429/5xx: Upstream mapped.

---

## POST /batch

Fetch channel info for multiple inputs in one call.

- Uses `navigationBatchMiddleware()` to resolve inputs to `browseId`.
- Deduplicates internally via `processBatchIds()`.
- Performs cache pre-check with `redisMGetJson` for `yt:channel:{browseId}`.

### Request body

```json
{ "ids": ["CHANNEL_OR_URL_OR_HANDLE", "..."] }
```

Validation:
- `ids`: array of strings, min 1, max 50.
- Invalid JSON body → 400 `{ error: "Invalid JSON body", code: "BAD_REQUEST" }`.
- Invalid items → 400 with first issue message (e.g., `Invalid channel id`).

### Response (200)

Returns an object keyed by original input ids. Each value is either the channel payload (same as GET `/`) or an error object `{ error, code }`.

Example:

```json
{
  "https://www.youtube.com/@handle": {
    "id": "UC...",
    "title": "...",
    "subscriberCount": "..."
  },
  "invalid": { "error": "Invalid channel id", "code": "BAD_REQUEST" }
}
```

Note: Unlike the caption batch endpoint, the channel batch response does not include a per-item `__status` field.

---

## Caching and SWR

- Channel info cache key: `yt:channel:{channelId}`
  - TTL: `CHANNEL_CACHE_TTL_SECONDS`
  - GET `/` uses SWR (`serveStale: true`).
  - Negative caching: 4xx client errors for BAD_REQUEST and 404 are cached.

- Channel videos cache key: `yt:channel:{channelId}:videos`
  - Stored payload shape:
    ```json
    {
      "items": [/* ChannelVideo[] */],
      "firstId": "VIDEO_ID or null",
      "updatedAt": 1710000000000,
      "staleAt": 1710003600000,
      "ttlSeconds": 120
    }
    ```
  - Extended TTL on Redis (policy * 30) to reduce churn.
  - Uses `singleflight` and `fetchWithRedisLock` to avoid thundering herds.
  - Fetch of full list uses small randomized delay between continuations and stops early if limit reached or no new items.

---

## Error code glossary (selected)

- `BAD_REQUEST`
- `UPSTREAM_NOT_FOUND`, `UPSTREAM_RATE_LIMITED`, `UPSTREAM_UNAVAILABLE`, `UPSTREAM_BAD_GATEWAY`
- `CLIENT_CLOSED_REQUEST`
- `INTERNAL_ERROR`

---

## Examples

- Single channel info:
  ```http
  GET /v1/innertube/channel?id=https://www.youtube.com/@handle
  ```

- Channel videos:
  ```http
  GET /v1/innertube/channel/videos?id=UCxxxxxxxxxxxxxxxxxxxxxx
  ```

- Batch channel info:
  ```http
  POST /v1/innertube/channel/batch
  Content-Type: application/json

  { "ids": ["https://www.youtube.com/@handle", "UC...", "https://www.youtube.com/channel/UC..."] }
  ```
