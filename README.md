# bun-yt-svc

Tiny Bun/Hono service that exposes selected YouTube Innertube capabilities via a clean HTTP API.

It uses `youtubei.js` under the hood and adds:

- Robust fetch with retries/backoff and optional HTTP proxy for the throttled player endpoint.
- Request-scoped cancellation (propagates client aborts to upstream calls).
- Normalized responses for video info and transcripts.
- Optional WebPO integrity token generation for restricted scenarios (internal).


## Tech stack

- Bun runtime
- TypeScript
- Hono web framework
- youtubei.js
- zod (env/config validation)
- date-fns (publish date parsing)


## Project layout

- `src/index.ts` — entry, loads config, sets log level, creates app, exports `{ fetch, port }` for Bun
- `src/app.ts` — Hono app factory, mounts middleware and routes
- `src/config.ts` — zod schema for env, `parseConfig()`
- `src/middleware/` — `requestLogger`, `configMiddleware`, `innertubeMiddleware`
- `src/router/v1/` — versioned API root
  - `innertube/` — `video.router.ts`, `transcript.router.ts` (+ placeholder `caption.router.ts`)
- `src/service/innertube.service.ts` — `InnertubeService` wrapper with smart fetch/proxy/retry
- `src/lib/` — `http.lib.ts`, `logger.lib.ts`, `pot.lib.ts`
- `src/helper/` — helpers for video/transcript parsing and proxy URL build


## Configuration

Environment variables are validated by `src/config.ts`.

- `APP_PORT` (default: `1331`) — server port
- `APP_LOG_LEVEL` one of `silent|error|warn|info|debug|verbose` (default: `info`)
- `PROXY_STATUS` `active|inactive` (default: `inactive`)
- `PROXY_HOST` (default: `127.0.0.1`)
- `PROXY_PORT` (default: `10800`)
- `PROXY_USERNAME`, `PROXY_PASSWORD` (optional)

Proxy is only used for the Innertube player endpoint when `PROXY_STATUS=active`.


## Database

This project includes an optional PostgreSQL persistence layer via Drizzle ORM to cache normalized video, transcript, caption, and channel payloads.

- Drizzle config: `drizzle.config.ts` (schema: `src/db/schema.ts`, migrations out: `db/migrations/`)
- Schema tables (PostgreSQL schema `yt-svc`):
  - `videos` — normalized video info and metadata.
  - `transcripts` — transcript segments per `(videoId, language)` with unique index.
  - `captions` — caption segments/words per `(videoId, language, targetLanguage)` with unique index.
  - `channels` — normalized channel info.

Environment:

- `DATABASE_URL` — Postgres connection string (if unset, DB client stays uninitialized; API still works with Redis caching).

Migrations:

```sh
# Generate from schema (optional if only using provided SQL migrations)
bun run drizzle:generate

# Apply migrations to DATABASE_URL
bun run drizzle:migrate
```


## Caching & Redis

High-throughput responses are cached in Redis with SWR (stale-while-revalidate) patterns and short-lived negative caches for certain client errors.

- `REDIS_URL` (default: `redis://localhost:6379`)
- TTLs (validated in `src/config.ts`):
  - `VIDEO_CACHE_TTL_SECONDS` (default 14400)
  - `CHANNEL_CACHE_TTL_SECONDS` (default 86400)
  - `TRANSCRIPT_CACHE_TTL_SECONDS` (default 86400)
  - `CAPTION_CACHE_TTL_SECONDS` (default 86400)
- Batch throttling envs:
  - `INNERTUBE_BATCH_CONCURRENCY` (default 3, max 10)
  - `INNERTUBE_BATCH_MIN_DELAY_MS` (default 150)
  - `INNERTUBE_BATCH_MAX_DELAY_MS` (default 400)

Cache keys (examples):

- Video: `yt:video:${videoId}`
- Transcript: `yt:transcript:${videoId}:${language|'default'}` (+ alias key)
- Caption: `yt:caption:${videoId}:${language|'default'}[:${translateLanguage}]` (+ alias key)
- Channel: `yt:channel:${channelId}`

Negative caching is applied only for specific 4xx cases (e.g., language validation or bad request) to reduce repeat load.


## API

Base path: `/v1/innertube`

All endpoints support request aborts (client cancel -> 499).

ID resolution is centralized via `navigationMiddleware()` and `navigationBatchMiddleware()`. Provide `id=` which can be any of:

- YouTube video URL, video ID
- YouTube channel URL, channel ID, or handle (e.g., `@handle`)

### GET /v1/innertube/video?id=...

Params:

- `id` — required (video URL or videoId)

Returns normalized video info.

Example:

```sh
curl "http://localhost:1331/v1/innertube/video?id=dQw4w9WgXcQ"
curl "http://localhost:1331/v1/innertube/video?id=https://www.youtube.com/watch?v=dQw4w9WgXcQ"
```

Batch (POST): `/v1/innertube/video/batch`

- Body: `{ "ids": ["<videoId|url>", ...] }`
- Returns object keyed by input id.

```sh
curl -X POST "http://localhost:1331/v1/innertube/video/batch" \
  -H 'content-type: application/json' \
  -d '{ "ids": ["dQw4w9WgXcQ", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"] }'
```

### GET /v1/innertube/transcript?id=...&l=...

Params:

- `id` — required (video URL or videoId)
- `l` — optional language code (e.g., `en`, `id`)

Notes:

- If a video has no captions/tracks, the service returns `hasTranscript: false` and empty arrays/strings.
- Language resolution uses requested language when available; else falls back to preferred language (e.g., English) or an alias derived from prior successful fetches.

Example:

```sh
curl "http://localhost:1331/v1/innertube/transcript?id=dQw4w9WgXcQ&l=en"
```

Batch (POST): `/v1/innertube/transcript/batch?l=en`

- Body: `{ "ids": ["<videoId|url>", ...] }`
- Query: `l` optional

```sh
curl -X POST "http://localhost:1331/v1/innertube/transcript/batch?l=en" \
  -H 'content-type: application/json' \
  -d '{ "ids": ["dQw4w9WgXcQ", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"] }'
```

### GET /v1/innertube/caption?id=...&l=...&tl=...

Params:

- `id` — required (video URL or videoId)
- `l` — optional source caption language
- `tl` — optional translate-to language (requires `l`)

Validation follows BCP-47-like pattern. If invalid language codes are supplied, a 400 is returned and a short negative cache may be set.

Example:

```sh
curl "http://localhost:1331/v1/innertube/caption?id=dQw4w9WgXcQ&l=en"
curl "http://localhost:1331/v1/innertube/caption?id=dQw4w9WgXcQ&l=en&tl=id"
```

Batch (POST): `/v1/innertube/caption/batch?l=en[&tl=id]`

- Body: `{ "ids": ["<videoId|url>", ...] }`

```sh
curl -X POST "http://localhost:1331/v1/innertube/caption/batch?l=en&tl=id" \
  -H 'content-type: application/json' \
  -d '{ "ids": ["dQw4w9WgXcQ", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"] }'
```

### GET /v1/innertube/channel?id=...

Params:

- `id` — required (channel URL, channelId, or @handle)

Example:

```sh
curl "http://localhost:1331/v1/innertube/channel?id=@YouTube"
```

Batch (POST): `/v1/innertube/channel/batch`

- Body: `{ "ids": ["<channelId|url|@handle>", ...] }`

```sh
curl -X POST "http://localhost:1331/v1/innertube/channel/batch" \
  -H 'content-type: application/json' \
  -d '{ "ids": ["UC_x5XG1OV2P6uZZ5FSM9Ttw", "https://www.youtube.com/@YouTube"] }'
```


## Logging

Simple leveled logger in `src/lib/logger.lib.ts`.

- Set with `APP_LOG_LEVEL` or at boot via `setLogLevel()` in `src/index.ts`.
- `requestLogger` middleware logs BEGIN/END with timing per request.


## Local development

Prerequisite: Bun 1.1+ installed.

Install deps:

```sh
bun install
```

Run dev (hot reload):

```sh
bun run dev
```

The server listens on `http://localhost:1331` (configurable via `APP_PORT`).


## Build and run

Build to `dist/` and start:

```sh
bun run build
bun run start
```


## Docker

Multi-stage Dockerfile builds and runs the bundled server for faster cold start.

```sh
docker build -t bun-yt-svc .
docker run -p 1331:1331 --env APP_PORT=1331 bun-yt-svc
```


## Deploy (Fly.io Machines)

This repo includes `fly.toml` targeting Machines with:

- `auto_stop_machines = "stop"` and `auto_start_machines = true`
- `min_machines_running = 0` for low cost; expect cold starts.

Cold start tips:

- The build step emits a single JS bundle (`dist/index.js`) and runtime image starts that directly.
- Heavy modules like `jsdom` are lazily imported only when needed (`pot.lib.ts`).
- `src/index.ts` pre-warms the Innertube player (`InnertubeService.ensurePlayerReady()`) to reduce first-hit latency.

Deploy (typical):

```sh
fly launch  # or edit existing fly.toml
fly deploy
```

Secrets (recommended): do not commit proxy credentials. Use:

```sh
fly secrets set PROXY_USERNAME=... PROXY_PASSWORD=...
```


## Proxy behavior

When `PROXY_STATUS=active`, only the Innertube player endpoint requests are proxied.

- Proxy URL is built from `PROXY_*` vars in `src/helper/proxy.helper.ts`.
- Non-player requests go direct to minimize latency.
- Automatic failover: if a direct player request fails and proxy is enabled, one retry via proxy is attempted.


## Error handling and timeouts

`src/lib/http.lib.ts` implements:

- Per-attempt timeouts (default 8s), retries with exponential jitter, respect `Retry-After` for 429/503.
- Maps client aborts to 499 in routers.

### Error codes

Routers map errors via `mapErrorToHttp()` in `src/lib/hono.util.ts` to canonical codes:

- Client: `CLIENT_CLOSED_REQUEST` (499), `BAD_REQUEST` (400)
- Upstream/network: `UPSTREAM_TIMEOUT` (504), `UPSTREAM_ABORTED` (502), `UPSTREAM_RATE_LIMITED` (429), `UPSTREAM_UNAVAILABLE` (503), `UPSTREAM_BAD_GATEWAY` (502), `UPSTREAM_NOT_FOUND` (404)
- YouTube-specific: `YT_INVALID_ID` (400), `YT_LOGIN_REQUIRED` (401), `YT_AGE_RESTRICTED` (403), `YT_PRIVATE` (403), `YT_GEO_BLOCKED` (451), `YT_EMBED_BLOCKED` (451), `YT_CONTENT_CHECK_REQUIRED` (423), `YT_LIVE_STREAM_OFFLINE` (409), `YT_UNAVAILABLE` (404), `YT_PLAYABILITY_ERROR` (409), `YT_TRANSCRIPT_UNAVAILABLE` (404)
- Fallback: `INTERNAL_ERROR` (500)

Behavioral changes:

- `getTranscript()` no longer returns an empty payload on errors. It throws and the router responds with a mapped error code. When a video simply has no captions, it returns `hasTranscript: false`.
- `getVideoInfo()` and `getVideoInfoWithPoToken()` have more granular try/catch for precise logging and error propagation.


## Internal: WebPO token support

`InnertubeService.getVideoInfoWithPoToken()` integrates a WebPO token flow via `src/lib/pot.lib.ts` to help with restricted scenarios, adjusting DASH manifest/caption URLs accordingly. This method is not exposed via HTTP yet; wire it into routers if needed.


## License

MIT
