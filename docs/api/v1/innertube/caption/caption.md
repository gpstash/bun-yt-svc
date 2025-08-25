# Innertube Caption API (v1)

Base path: `/v1/innertube/caption`

Provides captions (subtitles) for YouTube videos, with optional language selection and translation. Successful responses include normalized video info plus caption data.

References:
- Router: `src/router/v1/innertube/caption.router.ts`
- Batch helper: `src/lib/batch.util.ts`
- Error mapping: `src/lib/hono.util.ts`
- Innertube service: `src/service/innertube.service.ts`

---

## GET /

Fetch caption for a single video.

- Input video is resolved by `navigationMiddleware()` from `id` (YouTube URL, handle, channelId, or videoId) provided in the query string.
- If `l` is omitted, the service selects an effective language via alias or DB preference.
- If `tl` (translate language) is provided, `l` must also be provided and must be translatable for the video.

### Query parameters

- id (string, required)
  - YouTube video URL, channel/video URL, handle, channelId, or videoId. Must resolve to a video `videoId`.
- l (string, optional)
  - Language code pattern: `^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$` (e.g., `en`, `en-US`, `es-419`).
- tl (string, optional)
  - Translate language; same pattern as `l`. Requires `l`. Must be available in the video’s translation languages and must differ from `l`.

### Validation rules

- If `tl` is present but `l` is missing → 400 with `code: INVALID_LANGUAGE` and message "Language is required when translateLanguage is provided".
- If `l` doesn’t match pattern → 400 with `code: INVALID_LANGUAGE`.
- If `tl` doesn’t match pattern → 400 with `code: INVALID_TRANSLATE_LANGUAGE`.
- If navigation cannot yield a `videoId` → 400 with `code: BAD_REQUEST` and `error: "Missing video id"`.
- Early translate checks (when possible from DB):
  - `tl` must exist in `captionTranslationLanguages`.
  - Source `l` must be translatable (`isTranslatable !== false`).
  - Otherwise → 400 with `code: INVALID_TRANSLATE_LANGUAGE`.

### Success response (200)

Returns a single JSON object (no wrapper) containing video info and caption:

```json
{
  "id": "VIDEO_ID",
  "title": "...",
  "author": "...",
  "description": "...",
  "thumbnails": [{ "url": "...", "width": 120, "height": 90 }],
  "category": "...",
  "tags": ["..."],
  "duration": 0,
  "channel": { "id": "CHANNEL_ID", "name": "CHANNEL_NAME", "url": "..." },
  "viewCount": 0,
  "likeCount": 0,
  "isPrivate": false,
  "isUnlisted": false,
  "isFamilySafe": true,
  "publishDate": { "raw": "...", "formatted": "YYYY-MM-DDT00:00:00.000Z" },
  "transcriptLanguages": ["..."],
  "hasTranscripts": true,
  "captionLanguages": [
    { "name": "...", "languageCode": "en", "rtl": false, "isTranslatable": true }
  ],
  "hasCaptions": true,
  "captionTranslationLanguages": [
    { "languageCode": "es", "name": "Spanish" }
  ],
  "caption": {
    "hascaption": true,
    "language": "en",
    "segments": [{ "text": "...", "start": 0, "end": 1234 }],
    "words": [{ "text": "...", "start": 0, "end": 350 }],
    "text": "full caption text ..."
  }
}
```

Notes:
- `segments` and `words` items have shape `{ text: string, start: number, end: number }`.
- `words` may be empty depending on the upstream track.

### Error responses

Errors are mapped via `mapErrorToHttp()` in `src/lib/hono.util.ts`.

- 400: `BAD_REQUEST`, `INVALID_LANGUAGE`, `INVALID_TRANSLATE_LANGUAGE`
- 401: `YT_LOGIN_REQUIRED`
- 403: `YT_AGE_RESTRICTED`, `YT_PRIVATE`
- 404: `YT_UNAVAILABLE`, `UPSTREAM_NOT_FOUND`, `YT_TRANSCRIPT_UNAVAILABLE`
- 409: `YT_PLAYABILITY_ERROR`, `YT_LIVE_STREAM_OFFLINE`, `YT_CONTINUATION_FAILED`
- 429: `UPSTREAM_RATE_LIMITED`
- 451: `YT_GEO_BLOCKED`, `YT_EMBED_BLOCKED`
- 499: `CLIENT_CLOSED_REQUEST` (client aborted)
- 502/503/504: `UPSTREAM_*` or `INTERNAL_ERROR`

Example:

```
GET /v1/innertube/caption?id=https://www.youtube.com/watch?v=VIDEO_ID&l=en
```

With translation:

```
GET /v1/innertube/caption?id=VIDEO_ID&l=en&tl=es
```

---

## POST /batch

Fetch captions for multiple videos in one call.

- Uses `navigationBatchMiddleware()` to resolve inputs to `videoId`s.
- Duplicates are deduped internally; order of keys in response follows input order.
- Some items may succeed while others fail; response is per input id.

### Query parameters

- l (string, optional) — same rules as GET.
- tl (string, optional) — same rules as GET (requires `l`).

### Request body

```json
{
  "ids": ["VIDEO_OR_URL_OR_HANDLE", "..."]
}
```

- `ids`: non-empty array of strings.
- Allowed forms: video URL, channel/video URL, handle, channelId, raw videoId.

### Response (200)

Returns an object keyed by the original input ids. Each value is either a success payload (same shape as GET response) or an error object.

- Success: same JSON object as GET success.
- Error shape:

```json
{ "error": "message", "code": "ERROR_CODE", "__status": 400 }
```

Example:

```json
{
  "https://www.youtube.com/watch?v=VIDEO_A": {
    "id": "VIDEO_A",
    "title": "...",
    "caption": { "hascaption": true, "language": "en", "segments": [...], "words": [...], "text": "..." }
  },
  "VIDEO_B": { "error": "Invalid translate language", "code": "INVALID_TRANSLATE_LANGUAGE", "__status": 400 }
}
```

### Request-level errors

- 400 `BAD_REQUEST` when body is invalid/empty or if all `ids` are invalid/unresolvable.

---

## Caching, aliasing, SWR, and throttling

- Cache key: `yt:caption:{videoId}:{language}[:{translateLanguage}]`
- Alias key: `yt:caption:{videoId}:_alias`
- TTL: `CAPTION_CACHE_TTL_SECONDS` from config; `jitterTtl()` is used when persisting cache.
- Aliasing behavior:
  - When `l` and `tl` are omitted and a caption is served, the resolved language is stored under the alias key.
  - Subsequent requests without language use the alias for cache lookup.
- Negative caching:
  - Only language-related 4xx codes are negative-cached: `INVALID_LANGUAGE`, `INVALID_TRANSLATE_LANGUAGE`, `YT_TRANSLATION_UNSUPPORTED`, `YT_TRANSLATION_SAME_LANGUAGE`.
- SWR:
  - GET serves stale while revalidating (`swrOnStale: true`).
  - Batch disables SWR (`swrOnStale: false`).
- Batch cache pre-checks:
  - If `l`/`tl` are not provided, batch pre-checks the alias keys for each entity and hydrates any found caption cache entries to avoid unnecessary fetches.
  - If `l`/`tl` are provided, batch checks the exact caption keys.
- Throttling and warm-up:
  - Batch limits concurrency to 1 and warms the Innertube player once with `InnertubeService.ensurePlayerReady()` to avoid redundant initializations.

---

## Error code glossary (selected)

- CLIENT_CLOSED_REQUEST
- BAD_REQUEST
- INVALID_LANGUAGE
- INVALID_TRANSLATE_LANGUAGE
- UPSTREAM_TIMEOUT, UPSTREAM_ABORTED, UPSTREAM_RATE_LIMITED, UPSTREAM_UNAVAILABLE, UPSTREAM_BAD_GATEWAY, UPSTREAM_NOT_FOUND
- YT_LOGIN_REQUIRED, YT_AGE_RESTRICTED, YT_GEO_BLOCKED, YT_PRIVATE, YT_UNAVAILABLE, YT_TRANSCRIPT_UNAVAILABLE, YT_PLAYABILITY_ERROR, YT_LIVE_STREAM_OFFLINE
- YT_TRANSLATION_UNSUPPORTED, YT_TRANSLATION_SAME_LANGUAGE
- INTERNAL_ERROR
