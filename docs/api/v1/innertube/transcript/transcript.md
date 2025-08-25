# Innertube Transcript API (v1)

Base path: `/v1/innertube/transcript`

Fetch video transcripts with language resolution, SWR caching, and batch support.

References:
- Router: `src/router/v1/innertube/transcript.router.ts`
- Transcript service: `src/service/transcript.service.ts`
- Video service: `src/service/video.service.ts`
- Navigation middleware: `src/middleware/navigation.middleware.ts`, `src/middleware/navigation-batch.middleware.ts`
- Error mapping: `src/lib/hono.util.ts`

---

## GET /

Return video info merged with transcript for a single video.

- Uses `navigationMiddleware()` to resolve `videoId`.
- Language resolution prefers requested `l`, otherwise uses alias/DB-preferred.
- Uses SWR with `serveStale: true`.

### Query parameters

- l (string, optional)
  - If provided: trimmed length must be 1..100; otherwise 400 `INVALID_LANGUAGE`.

### Validation

- If navigation cannot yield a `videoId` → 400 `{ error: "Missing video id", code: "BAD_REQUEST" }`.

### Success response (200)

Returns a single JSON object with normalized video info plus transcript:

```json
{
  "id": "VIDEO_ID",
  "title": "...",
  "channel": { "id": "UC...", "name": "...", "url": "..." },
  "duration": 0,
  "publishDate": { "raw": "...", "formatted": "..." },
  "viewCount": 0,
  "likeCount": 0,
  "isPrivate": false,
  "isUnlisted": false,
  "isFamilySafe": true,
  "transcript": {
    "language": "en",
    "segments": [{ "text": "..." }],
    "text": "joined transcript text ..."
  }
}
```

Notes:
- `segments` come from DB or upstream and are persisted.
- If video not persisted yet, handler fetches video info and merges minimal fields.

### Caching and language aliasing

- Cache key per language: `yt:transcript:{videoId}:{languageOrDefault}`
- TTL: `TRANSCRIPT_CACHE_TTL_SECONDS`
- SWR behavior: serve-stale true; DB is used if present while freshening.
- Alias key: `yt:transcript:{videoId}:_alias`
  - When no `l` is requested, alias is set to resolved language to speed up future lookups.
- Negative caching: only for 4xx language-related codes: `INVALID_LANGUAGE`, `INVALID_TRANSLATE_LANGUAGE`, `YT_TRANSLATION_UNSUPPORTED`, `YT_TRANSLATION_SAME_LANGUAGE`.

### Error responses

Mapped via `mapErrorToHttp()`:
- 400: `BAD_REQUEST`, `INVALID_LANGUAGE`
- 404: `UPSTREAM_NOT_FOUND`
- 429: `UPSTREAM_RATE_LIMITED`
- 499: `CLIENT_CLOSED_REQUEST` on abort
- 5xx: `INTERNAL_ERROR` or `UPSTREAM_*`

---

## POST /batch

Batch fetch transcripts for multiple inputs.

- Uses `navigationBatchMiddleware()` to resolve `videoId` for each input.
- Shared batching helper `processBatchIds()` is used with smart cache pre-checks.

### Query parameters

- l (string, optional)
  - Same validation as GET. If invalid → 400 `BAD_REQUEST`.

### Request body

```json
{ "ids": ["VIDEO_OR_URL", "..."] }
```

Validation:
- If middleware didn’t populate ids, JSON body required with `ids` array (min 1, max 50).
- Invalid JSON → 400 `{ error: "Invalid JSON body", code: "BAD_REQUEST" }`.
- Invalid items → 400 with first issue’s message.

### Response (200)

Returns an object keyed by original input ids. Each value is either:
- Success: same payload as GET `/` (video info + transcript), or
- Error: `{ error, code }` mapped via `mapErrorToHttp()`.

### Batch caching behavior

- If no `l` provided: alias-based pre-check
  - Read `yt:transcript:{videoId}:_alias` for each id
  - For resolved aliases, pre-check `yt:transcript:{videoId}:{alias}`
- If `l` provided: deterministic pre-check using `yt:transcript:{videoId}:{l}`
- Reduces upstream calls and throttling pressure.

---

## Error code glossary (selected)

- `BAD_REQUEST`, `INVALID_LANGUAGE`, `INVALID_TRANSLATE_LANGUAGE`, `YT_TRANSLATION_UNSUPPORTED`, `YT_TRANSLATION_SAME_LANGUAGE`
- `UPSTREAM_NOT_FOUND`, `UPSTREAM_RATE_LIMITED`
- `CLIENT_CLOSED_REQUEST`
- `INTERNAL_ERROR`

---

## Examples

- Single transcript (auto language resolution):
  ```http
  GET /v1/innertube/transcript?id=https://www.youtube.com/watch?v=VIDEO_ID
  ```

- Single transcript, requested language:
  ```http
  GET /v1/innertube/transcript?id=VIDEO_ID&l=en
  ```

- Batch transcripts:
  ```http
  POST /v1/innertube/transcript/batch
  Content-Type: application/json

  { "ids": ["https://www.youtube.com/watch?v=VIDEO_ID", "VIDEO_ID2"] }
  ```
