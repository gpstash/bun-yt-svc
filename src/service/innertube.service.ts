import { createLogger, getLogLevel, LogLevel } from "@/lib/logger.lib";
import { ClientType, Innertube, Log, UniversalCache, YT } from "youtubei.js";
import { parseVideoInfo, ParsedVideoInfo, hasCaptions, parseTranscript, ParsedTranscript } from "@/helper/video.helper";
import { http, HttpOptions } from "@/lib/http.lib";
import { AsyncLocalStorage } from 'node:async_hooks';

const logger = createLogger('service:InnertubeService');


export interface CreateInnertubeOptions {
  withPlayer?: boolean;
  location?: string;
  safetyMode?: boolean;
  clientType?: ClientType;
  generateSessionLocally?: boolean;
}

export interface RequestOptions {
  signal?: AbortSignal;
  requestId?: string;
}

export class InnertubeService {
  public static instance: InnertubeService;
  constructor(private readonly innertube: Innertube) { }
  // Per-request context to carry AbortSignal from router -> service -> innertube fetches
  private static readonly requestContext = new AsyncLocalStorage<{ signal?: AbortSignal; requestId?: string }>();
  private static readonly DEFAULT_HTTP_OPTIONS: Readonly<HttpOptions> = {
    timeoutMs: 12000,
    maxAttempts: 3,
    retryOnStatus: [408, 429, 500, 502, 503, 504],
    backoffBaseMs: 100,
    maxBackoffMs: 3_000,
    retryMethods: ['GET', 'HEAD', 'OPTIONS', 'POST'], // Innertube frequently uses POST
    respectRetryAfter: true,
  } as const;

  /**
   * Fetch and parse video information with a normalized shape safe for clients.
   */
  public async getVideoInfo(id: string, opts?: RequestOptions): Promise<ParsedVideoInfo> {
    const started = performance.now();
    const info = await InnertubeService.requestContext.run({ signal: opts?.signal, requestId: opts?.requestId }, async () => {
      const ctx = InnertubeService.requestContext.getStore();
      logger.debug('getVideoInfo:start', { id, requestId: ctx?.requestId });
      const res = await this.innertube.getInfo(id);
      logger.debug('getVideoInfo:fetched', { id, requestId: ctx?.requestId });
      return res;
    });
    const parsedVideoInfo = parseVideoInfo(info);

    // Remove baseUrl from captionLanguages
    parsedVideoInfo.captionLanguages = parsedVideoInfo.captionLanguages.map((caption) => {
      // avoid mutating original object reference
      const { baseUrl: _omit, ...rest } = caption as { baseUrl?: string } & typeof caption;
      return rest;
    });

    const durationMs = Math.round(performance.now() - started);
    const ctx2 = InnertubeService.requestContext.getStore();
    logger.info('getVideoInfo:done', { id, durationMs, requestId: ctx2?.requestId });
    return parsedVideoInfo;
  }

  /**
   * Retrieve transcript, optionally selecting a specific language.
   */
  public async getTranscript(id: string, language?: string, opts?: RequestOptions): Promise<ParsedTranscript> {
    try {
      const started = performance.now();
      const info = await InnertubeService.requestContext.run({ signal: opts?.signal, requestId: opts?.requestId }, async () => {
        const ctx = InnertubeService.requestContext.getStore();
        logger.debug('getTranscript:start', { id, language, requestId: ctx?.requestId });
        const res = await this.innertube.getInfo(id);
        logger.debug('getTranscript:fetched', { id, language, requestId: ctx?.requestId });
        return res;
      });
      if (!hasCaptions(info)) {
        return {
          language: "",
          transcriptLanguages: [],
          hasTranscript: false,
          segments: [],
          text: "",
        };
      }

      let selectedTranscript: YT.TranscriptInfo = await info.getTranscript();
      if (language && Array.isArray(selectedTranscript?.languages) && selectedTranscript.languages.includes(language)) {
        try {
          selectedTranscript = await selectedTranscript.selectLanguage(language);
        } catch (error) {
          logger.warn('Language selection failed, fallback to default language', error);
        }
      }

      const parsed = parseTranscript(selectedTranscript);
      const durationMs = Math.round(performance.now() - started);
      const ctx2 = InnertubeService.requestContext.getStore();
      logger.info('getTranscript:done', { id, language, durationMs, requestId: ctx2?.requestId, hasTranscript: parsed.hasTranscript });
      return parsed;
    } catch (error) {
      const ctx = InnertubeService.requestContext.getStore();
      logger.error('Error getting transcript', { id, language, requestId: ctx?.requestId, error });
      return {
        language: "",
        transcriptLanguages: [],
        hasTranscript: false,
        segments: [],
        text: "",
      };
    }
  }

  public async getVideoInfoWithPoToken(id: string, parse: true): Promise<ParsedVideoInfo>;
  public async getVideoInfoWithPoToken(id: string, parse: false): Promise<YT.VideoInfo>;
  public async getVideoInfoWithPoToken(id: string, parse: boolean): Promise<YT.VideoInfo | ParsedVideoInfo> {
    // Lazy import to avoid loading heavy deps (e.g., jsdom) during cold start
    const { generatePoToken } = await import("@/lib/pot.lib");
    let contentPoToken: string, sessionPoToken: string;
    const webInnertube = await InnertubeService.createInnertube({ withPlayer: true });
    let clientName = webInnertube.session.context.client.clientName;

    const visitorData = webInnertube.session.context.client.visitorData;
    if (!visitorData) {
      throw new Error('Missing visitorData in Innertube session context');
    }

    ({ contentPoToken, sessionPoToken } = await generatePoToken(id, visitorData))
    const info: YT.VideoInfo = await webInnertube.getInfo(id, { po_token: contentPoToken });

    // temporary workaround for SABR-only responses
    const mwebInfo = await webInnertube.getBasicInfo(id, { client: 'MWEB', po_token: contentPoToken })

    if (mwebInfo?.playability_status?.status === 'OK' && mwebInfo?.streaming_data) {
      info.playability_status = mwebInfo.playability_status
      info.streaming_data = mwebInfo.streaming_data

      clientName = 'MWEB'
    }

    let hasTrailer = info.has_trailer
    let trailerIsAgeRestricted = info.getTrailerInfo() === null

    if (
      ((info?.playability_status?.status === 'UNPLAYABLE' || info?.playability_status?.status === 'LOGIN_REQUIRED') &&
        info?.playability_status?.reason === 'Sign in to confirm your age') ||
      (hasTrailer && trailerIsAgeRestricted)
    ) {
      const webEmbeddedInnertube = await InnertubeService.createInnertube({ clientType: ClientType.WEB_EMBEDDED })
      webEmbeddedInnertube.session.context.client.visitorData = webInnertube.session.context.client.visitorData

      const errorScreen = info?.playability_status?.error_screen as { video_id?: string } | undefined;
      const videoId = hasTrailer && trailerIsAgeRestricted ? (errorScreen?.video_id ?? id) : id

      // getBasicInfo needs the signature timestamp (sts) from inside the player
      webEmbeddedInnertube.session.player = webInnertube.session.player

      const bypassedInfo = await webEmbeddedInnertube.getBasicInfo(videoId, { client: 'WEB_EMBEDDED', po_token: contentPoToken })

      if (bypassedInfo?.playability_status?.status === 'OK' && bypassedInfo?.streaming_data) {
        info.playability_status = bypassedInfo.playability_status
        info.streaming_data = bypassedInfo.streaming_data
        info.basic_info.start_timestamp = bypassedInfo.basic_info.start_timestamp
        info.basic_info.duration = bypassedInfo.basic_info.duration
        info.captions = bypassedInfo.captions
        info.storyboards = bypassedInfo.storyboards

        hasTrailer = false
        trailerIsAgeRestricted = false

        clientName = webEmbeddedInnertube.session.context.client.clientName
      }
    }

    if ((info?.playability_status?.status === 'UNPLAYABLE' && (!hasTrailer || trailerIsAgeRestricted)) ||
      info?.playability_status?.status === 'LOGIN_REQUIRED') {
      return parse ? parseVideoInfo(info) : info
    }

    if (hasTrailer && info?.playability_status?.status !== 'OK') {
      const trailerInfo = info.getTrailerInfo()

      // don't override the timestamp of when the video will premiere for upcoming videos
      if (info.basic_info.start_timestamp && info?.playability_status?.status !== 'LIVE_STREAM_OFFLINE') {
        // trailerInfo?.basic_info.start_timestamp can be undefined; coalesce to null to match type Date | null
        info.basic_info.start_timestamp = trailerInfo?.basic_info.start_timestamp ?? null
      }

      info.playability_status = trailerInfo?.playability_status
      info.streaming_data = trailerInfo?.streaming_data
      info.basic_info.duration = trailerInfo?.basic_info.duration
      info.captions = trailerInfo?.captions
      info.storyboards = trailerInfo?.storyboards
    }

    if (info.streaming_data) {
      if (info.streaming_data.dash_manifest_url) {
        let url = info.streaming_data.dash_manifest_url

        if (url.includes('?')) {
          url += `&pot=${encodeURIComponent(sessionPoToken)}&mpd_version=7`
        } else {
          url += `${url.endsWith('/') ? '' : '/'}pot/${encodeURIComponent(sessionPoToken)}/mpd_version/7`
        }

        info.streaming_data.dash_manifest_url = url
      }
    }

    if (info.captions?.caption_tracks) {
      for (const captionTrack of info.captions.caption_tracks) {
        const url = new URL(captionTrack.base_url)

        url.searchParams.set('potc', '1')
        url.searchParams.set('pot', contentPoToken)
        url.searchParams.set('c', clientName)
        url.searchParams.set('fmt', 'json3');

        // Remove &xosf=1 as it adds `position:63% line:0%` to the subtitle lines
        // placing them in the top right corner
        url.searchParams.delete('xosf');

        captionTrack.base_url = url.toString()
      }
    }

    return parse ? parseVideoInfo(info) : info
  }

  public static async getInstance(): Promise<InnertubeService> {
    if (this.instance) {
      logger.info('[getInstance] Use existing InnertubeService instance')
      return this.instance;
    }

    logger.info('[getInstance] Create new InnertubeService instance');
    const innertube = await InnertubeService.createInnertube({ withPlayer: false });
    return this.instance = new InnertubeService(innertube);
  }

  private static asUrlString(input: RequestInfo | URL): string {
    if (input instanceof URL) return input.toString();
    if (typeof input === 'string') return input;
    // Fall back to Request-like shape
    const maybeUrl = (input as { url?: string }).url;
    if (typeof maybeUrl === 'string') return maybeUrl;
    throw new TypeError('Unsupported RequestInfo input: missing URL');
  }

  private static isPlayerEndpoint(url: string): boolean {
    // YouTube v1 player endpoint is the usual throttling target
    return url.includes('/v1/player');
  }

  private static toFetchArgs(input: RequestInfo | URL, init?: RequestInit): { url: string | URL; init?: RequestInit } {
    if (typeof input === 'string' || input instanceof URL) {
      return { url: input, init };
    }
    // Request-like object. Extract properties to plain init.
    const req = input as Request;
    const nextInit: RequestInit = {
      method: req.method,
      headers: req.headers as unknown as HeadersInit,
      body: req.body as unknown as BodyInit | null,
      // Preserve credentials/referrer/etc if provided in init, but do not override extracted core fields.
      ...init,
    };
    return { url: req.url, init: nextInit };
  }

  // Link multiple AbortSignals into a single composite signal.
  private static linkAbortSignals(signals: (AbortSignal | undefined)[]) {
    const controller = new AbortController();
    if (signals.some(s => s?.aborted)) {
      controller.abort();
      return { signal: controller.signal, cleanup: () => { } };
    }
    const handlers: Array<() => void> = [];
    for (const s of signals) {
      if (!s) continue;
      const onAbort = () => controller.abort((s as any).reason);
      s.addEventListener('abort', onAbort, { once: true });
      handlers.push(() => s.removeEventListener('abort', onAbort));
    }
    return {
      signal: controller.signal,
      cleanup: () => handlers.forEach(h => h()),
    };
  }

  public static async fetch(input: string | URL | globalThis.Request, init?: RequestInit): Promise<Response> {
    const start = performance.now();
    const targetUrl = InnertubeService.asUrlString(input);
    const isPlayerEndpoint = InnertubeService.isPlayerEndpoint(targetUrl);
    const isProxyEnabled = process.env.PROXY_STATUS === 'active';
    // Only proxy the player endpoint when proxy is active
    const isProxyNeeded = isProxyEnabled && isPlayerEndpoint;
    const { url, init: mergedInit } = InnertubeService.toFetchArgs(input, init);

    // Pull per-request signal (from router) if present
    const ctx = InnertubeService.requestContext.getStore();

    let writableInit: RequestInit | undefined = mergedInit ? { ...mergedInit } : undefined;
    if (isPlayerEndpoint && writableInit?.body && typeof writableInit.body === 'string') {
      writableInit.body = (writableInit.body as string).replace('"videoId":', '"params":"8AEB","videoId":')
    }

    // Fast-path: use native fetch directly for non-player endpoints without proxy needs
    if (!isPlayerEndpoint && !isProxyEnabled) {
      // Combine context signal and any init.signal
      const { signal, cleanup } = InnertubeService.linkAbortSignals([ctx?.signal, (writableInit?.signal as AbortSignal | undefined)]);
      const res = await fetch(url as any, { ...(writableInit || {}), signal } as RequestInit);
      logger.verbose('innertubeFetch native', {
        url: String(url),
        status: res.status,
        durationMs: Math.round(performance.now() - start),
        requestId: ctx?.requestId,
      });
      cleanup();
      return res;
    }

    // Combine context and init signals for http(); stop retries on abort
    const { signal: compositeSignal, cleanup: cleanupLinked } = InnertubeService.linkAbortSignals([
      ctx?.signal,
      (writableInit?.signal as AbortSignal | undefined),
    ]);

    const requestOptions: HttpOptions = {
      ...InnertubeService.DEFAULT_HTTP_OPTIONS,
      ...(isProxyNeeded ? { useProxy: true } : {}),
      signal: compositeSignal,
    }

    logger.verbose('innertubeFetch start', {
      url: String(url),
      method: (writableInit?.method || 'GET').toUpperCase(),
      via: isProxyNeeded ? 'PROXY' : 'DIRECT',
      requestId: ctx?.requestId,
    });

    try {
      const response = await http(url, writableInit, requestOptions);
      logger.info('innertubeFetch done', {
        url: String(url),
        status: response.status,
        via: isProxyNeeded ? 'PROXY' : 'DIRECT',
        durationMs: Math.round(performance.now() - start),
        requestId: ctx?.requestId,
      });
      return response;
    } catch (err) {
      logger.error('innertubeFetch error', {
        url: String(url),
        via: isProxyNeeded ? 'PROXY' : 'DIRECT',
        durationMs: Math.round(performance.now() - start),
        error: err,
        requestId: ctx?.requestId,
      });
      // Failover: if DIRECT failed for player endpoint and proxy is enabled, retry once via proxy
      if (!isProxyNeeded && isProxyEnabled && isPlayerEndpoint) {
        logger.warn('innertubeFetch failover -> retrying via PROXY', { url: String(url), requestId: ctx?.requestId });
        try {
          const proxied = await http(url, writableInit, { ...requestOptions, useProxy: true });
          logger.info('innertubeFetch done (failover)', {
            url: String(url),
            status: proxied.status,
            via: 'PROXY',
            durationMs: Math.round(performance.now() - start),
            requestId: ctx?.requestId,
          });
          return proxied;
        } catch (err2) {
          logger.error('innertubeFetch failover error', {
            url: String(url),
            via: 'PROXY',
            durationMs: Math.round(performance.now() - start),
            error: err2,
            requestId: ctx?.requestId,
          });
        }
      }
      throw err;
    } finally {
      // Remove abort listeners
      cleanupLinked();
    }
  }

  public static async createInnertube(opts?: CreateInnertubeOptions): Promise<Innertube> {
    // Map our app log level to youtubei.js log level
    const lvl = getLogLevel();
    const map: Record<LogLevel, number> = {
      silent: Log.Level.NONE,
      error: Log.Level.ERROR,
      warn: Log.Level.WARNING,
      info: Log.Level.INFO,
      debug: Log.Level.DEBUG,
      verbose: Log.Level.DEBUG,
    } as const;
    Log.setLevel(map[lvl] ?? Log.Level.INFO);
    const { withPlayer, location, safetyMode, clientType, generateSessionLocally } = {
      withPlayer: false,
      safetyMode: false,
      // Generate session locally to avoid sw.js_data and similar bootstrap calls
      generateSessionLocally: true,
      ...opts,
    };

    let cache: UniversalCache | undefined;
    if (withPlayer) cache = new UniversalCache(false);

    // youtubei.js expects a fetch with optional `preconnect`. Provide a compatible wrapper.
    type FetchWithPreconnect = typeof fetch & { preconnect?: (url: string) => Promise<void> | void };
    const fetchWithPreconnect = Object.assign(
      ((input: string | URL | globalThis.Request, init?: RequestInit) => InnertubeService.fetch(input, init)) as typeof fetch,
      {
        // No-op to avoid extra network calls
        preconnect: () => { }
      }
    ) as FetchWithPreconnect as unknown as typeof fetch;

    const innertubeConfig = {
      // Reuse session data across Innertube instances to reduce bootstrap traffic and flakiness
      enable_session_cache: true,
      // If we generate session locally, do not hit network to retrieve config
      retrieve_innertube_config: !generateSessionLocally,

      retrieve_player: !!withPlayer,
      location: location,
      enable_safety_mode: !!safetyMode,
      client_type: clientType,
      cache,
      generate_session_locally: !!generateSessionLocally,
      // Ensure all network requests go through our resilient HTTP client
      fetch: fetchWithPreconnect
    }

    logger.debug('[createInnertube] Creating Innertube instance with config:', innertubeConfig);
    return await Innertube.create(innertubeConfig);
  }
}
