# Innertube Video API (v1)

Base path: `/v1/innertube/video`

Fetch normalized video info with SWR caching and batch support.

References:
- Router: `src/router/v1/innertube/video.router.ts`
- Video service: `src/service/video.service.ts`
- Navigation middleware: `src/middleware/navigation.middleware.ts`, `src/middleware/navigation-batch.middleware.ts`
- Error mapping: `src/lib/hono.util.ts`

---

## GET /

Return normalized video info for a single video.

- Uses `navigationMiddleware()` to resolve `videoId`.
- Uses SWR with `serveStale: true`.

### Validation

- If navigation cannot yield a `videoId` → 400 `{ error: "Missing video id", code: "BAD_REQUEST" }`.

### Success response (200)

Returns a single JSON object (no wrapper). Representative fields include:

```json
{
  "id": "VIDEO_ID",
  "title": "...",
  "description": "...",
  "thumbnails": [{ "url": "...", "width": 120, "height": 90 }],
  "category": "...",
  "tags": ["..."],
  "duration": 0,
  "channel": { "id": "UC...", "name": "...", "url": "..." },
  "viewCount": 0,
  "likeCount": 0,
  "isPrivate": false,
  "isUnlisted": false,
  "isFamilySafe": true,
  "publishDate": { "raw": "...", "formatted": "..." }
}
```

Exact shape is determined by `innertubeSvc.getVideoInfo()` normalization and persisted by `upsertVideo()`.

### Caching

- Cache key: `yt:video:{videoId}`
- TTL: `VIDEO_CACHE_TTL_SECONDS`
- SWR: `serveStale: true` for GET `/`
- Negative caching: only for 4xx with `code: BAD_REQUEST`

### Error responses

Mapped via `mapErrorToHttp()`:
- 400: `BAD_REQUEST`
- 404: `UPSTREAM_NOT_FOUND`
- 429: `UPSTREAM_RATE_LIMITED`
- 499: `CLIENT_CLOSED_REQUEST` on abort
- 5xx: `INTERNAL_ERROR` or `UPSTREAM_*`

---

## POST /batch

Batch fetch video info for multiple inputs.

- Uses `navigationBatchMiddleware()` to resolve `videoId` per input.
- Uses shared batching helper `processBatchIds()` with cache pre-checks.

### Request body

```json
{ "ids": ["VIDEO_OR_URL", "..."] }
```

Validation:
- If middleware didn’t populate ids, JSON body required with `ids` array (min 1, max 50).
- Invalid JSON → 400 `{ error: "Invalid JSON body", code: "BAD_REQUEST" }`.
- Invalid items → 400 with first issue message.

### Response (200)

Returns an object keyed by original input ids. Each value is either:
- Success: same payload as GET `/`, or
- Error: `{ error, code }` mapped via `mapErrorToHttp()`.

### Batch caching behavior

- Pre-check Redis with `yt:video:{videoId}` keys via `redisMGetJson` to avoid unnecessary upstream calls.
- For batch fetches, `resolveVideo(..., { swrOnStale: false })` is used (no serve-stale) to return fresh or error.

---

## Error code glossary (selected)

- `BAD_REQUEST`
- `UPSTREAM_NOT_FOUND`, `UPSTREAM_RATE_LIMITED`
- `CLIENT_CLOSED_REQUEST`
- `INTERNAL_ERROR`

---

## Examples

- Single video info by URL:
  ```http
  GET /v1/innertube/video?id=https://www.youtube.com/watch?v=VIDEO_ID
  ```

- Single video info by id:
  ```http
  GET /v1/innertube/video?id=VIDEO_ID
  ```

- Batch video info:
  ```http
  POST /v1/innertube/video/batch
  Content-Type: application/json

  { "ids": ["https://www.youtube.com/watch?v=VIDEO_ID", "VIDEO_ID2"] }
  ```
