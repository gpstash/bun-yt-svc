import { createLogger, getLogLevel, LogLevel } from "@/lib/logger.lib";
import { ClientType, Innertube, Log, UniversalCache, YT } from "youtubei.js";
import { parseVideoInfo, ParsedVideoInfo, hasCaptions, parseTranscript, ParsedVideoInfoWithTranscript, finCaptionByLanguageCode, ParsedVideoInfoWithCaption } from "@/helper/video.helper";
import { decodeJson3Caption, buildParsedVideoInfoWithCaption } from "@/helper/caption.helper";
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
  // Shared cache to be reused across ALL Innertube instances in-process (persistent)
  private static sharedCache: UniversalCache | undefined;
  // In-memory cache for player asset responses to avoid repeated downloads within a process
  private static playerAssetCache = new Map<string, { body: string; status: number; headers: [string, string][] }>();
  private static playerAssetInflight = new Map<string, Promise<Response>>();
  // Singleton player-enabled Innertube instance to avoid repeated player downloads
  private static playerInnertube: Innertube | undefined;
  // Prevent concurrent duplicate player initializations
  private static playerInit?: Promise<void>;
  private static readonly DEFAULT_HTTP_OPTIONS: Readonly<HttpOptions> = {
    timeoutMs: 12000,
    maxAttempts: 3,
    retryOnStatus: [408, 429, 500, 502, 503, 504],
    backoffBaseMs: 100,
    maxBackoffMs: 3_000,
    retryMethods: ['GET', 'HEAD', 'OPTIONS', 'POST'], // Innertube frequently uses POST
    respectRetryAfter: true,
  } as const;
  // Centralized max attempts for transient playability/unavailability retries
  private static readonly MAX_PLAYABILITY_ATTEMPTS = 3;
  // Maximum jitter cap used in our retry backoff helper
  private static readonly MAX_BACKOFF_JITTER_MS = 600;

  /**
   * Fetch and parse video information with a normalized shape safe for clients.
   */
  public async getVideoInfo(id: string, opts?: RequestOptions): Promise<ParsedVideoInfo> {
    const started = performance.now();
    let info!: YT.VideoInfo;
    try {
      info = await InnertubeService.requestContext.run({ signal: opts?.signal, requestId: opts?.requestId }, async () => {
        const ctx = InnertubeService.requestContext.getStore();
        logger.debug('getVideoInfo:start', { id, requestId: ctx?.requestId });
        const res = await this.getVideoInfoRawWithRetries(id);
        logger.debug('getVideoInfo:fetched', { id, requestId: ctx?.requestId });
        return res;
      });
    } catch (error) {
      const ctx = InnertubeService.requestContext.getStore();
      logger.error('getVideoInfo:getInfo error', { id, requestId: ctx?.requestId, error });
      throw error;
    }
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

  public async getCaption(id: string, language?: string, translateLanguage?: string, opts?: RequestOptions): Promise<ParsedVideoInfoWithCaption> {
    const started = performance.now();

    // First stage: fetch video info
    let info: YT.VideoInfo;
    try {
      info = await InnertubeService.requestContext.run({ signal: opts?.signal, requestId: opts?.requestId }, async () => {
        const ctx = InnertubeService.requestContext.getStore();
        logger.debug('getCaption:start', { id, language, requestId: ctx?.requestId });
        const res = await this.getVideoInfoWithPoToken(id, false, { signal: opts?.signal, requestId: opts?.requestId });
        logger.debug('getCaption:fetched', { id, language, requestId: ctx?.requestId });
        return res;
      });
    } catch (error) {
      const ctx = InnertubeService.requestContext.getStore();
      logger.error('getCaption:getInfo error', { id, language, requestId: ctx?.requestId, error });
      throw error;
    }

    const parsedVideoInfo = parseVideoInfo(info);
    if (!hasCaptions(info)) {
      return {
        ...parsedVideoInfo,
        caption: {
          hascaption: false,
          language: "",
          segments: [],
          words: [],
          text: "",
        },
      };
    }

    // Second stage: fetch caption
    try {
      const selectedCaption = finCaptionByLanguageCode(parsedVideoInfo.captionLanguages, language);

      // Check if translate language is provided
      if (translateLanguage) {
        // Ensure source caption has baseUrl
        if (!selectedCaption.baseUrl) {
          throw new Error('Transcript unavailable: missing caption base URL');
        }
        // Ensure this caption is translatable
        if (!selectedCaption.isTranslatable) {
          throw Object.assign(new Error('Translation unsupported for selected language'), { name: 'ValidationError' });
        }
        // Ensure requested translateLanguage is available in the video's translation languages
        const availableTl = (parsedVideoInfo.captionTranslationLanguages || []).some(
          tl => tl.languageCode?.toLowerCase() === translateLanguage.toLowerCase()
        );
        if (!availableTl) {
          throw Object.assign(new Error('Invalid translate language: not available'), { name: 'ValidationError' });
        }
        // Ensure target language differs from source
        if (selectedCaption.languageCode?.toLowerCase() === translateLanguage.toLowerCase()) {
          throw Object.assign(new Error('Translate language must differ from source'), { name: 'ValidationError' });
        }
      }

      // Build timedtext URL; add `tlang` when translation requested
      let timedtextUrl = selectedCaption.baseUrl!;
      if (translateLanguage) {
        const u = new URL(timedtextUrl);
        u.searchParams.set('tlang', translateLanguage);
        // Ensure json3 format remains
        u.searchParams.set('fmt', 'json3');
        timedtextUrl = u.toString();
      }

      const response = await http(timedtextUrl, {
        signal: opts?.signal,
      });
      const text = await response.text();
      const decoded = decodeJson3Caption(text);
      const result = buildParsedVideoInfoWithCaption(parsedVideoInfo, decoded, selectedCaption.languageCode);
      return result;

    } catch (error) {
      const ctx = InnertubeService.requestContext.getStore();
      logger.error('getCaption:caption error', { id, language, requestId: ctx?.requestId, error });
      throw error;
    }
  }

  /**
   * Retrieve transcript, optionally selecting a specific language.
   */
  public async getTranscript(id: string, language?: string, opts?: RequestOptions): Promise<ParsedVideoInfoWithTranscript> {
    const started = performance.now();
    // First stage: fetch video info
    let info: YT.VideoInfo;
    try {
      info = await InnertubeService.requestContext.run({ signal: opts?.signal, requestId: opts?.requestId }, async () => {
        const ctx = InnertubeService.requestContext.getStore();
        logger.debug('getTranscript:start', { id, language, requestId: ctx?.requestId });
        // Reuse resilient raw info (no Po token) with unavailable retries
        const res = await this.getVideoInfoRawWithRetries(id);
        logger.debug('getTranscript:fetched', { id, language, requestId: ctx?.requestId });
        return res;
      });
    } catch (error) {
      const ctx = InnertubeService.requestContext.getStore();
      logger.error('getTranscript:getInfo error', { id, language, requestId: ctx?.requestId, error });
      throw error;
    }

    const parsedVideoInfo = parseVideoInfo(info);
    if (!hasCaptions(info)) {
      return {
        ...parsedVideoInfo,
        transcript: {
          language: "",
          segments: [],
          text: "",
        },
      };
    }

    // Second stage: fetch transcript (and optionally select language)
    let selectedTranscript: YT.TranscriptInfo;
    try {
      selectedTranscript = await info.getTranscript();
      if (language && Array.isArray(selectedTranscript?.languages) && selectedTranscript.languages.includes(language)) {
        try {
          selectedTranscript = await selectedTranscript.selectLanguage(language);
        } catch (errLang) {
          // Language selection is best-effort; log and keep default transcript
          logger.warn('Language selection failed, fallback to default language', errLang);
        }
      }
    } catch (error) {
      const ctx = InnertubeService.requestContext.getStore();
      logger.error('getTranscript:transcript error', { id, language, requestId: ctx?.requestId, error });
      // Ensure message contains the word "transcript" for better mapping
      const msg = String((error as any)?.message || '');
      if (!msg.toLowerCase().includes('transcript')) {
        const wrapped = new Error(`Transcript fetch failed: ${msg}`);
        (wrapped as any).name = (error as any)?.name || 'InnertubeTranscriptError';
        throw wrapped;
      }
      throw error;
    }

    const parsed = parseTranscript(parsedVideoInfo, selectedTranscript);
    const durationMs = Math.round(performance.now() - started);
    const ctx2 = InnertubeService.requestContext.getStore();
    logger.info('getTranscript:done', { id, language, durationMs, requestId: ctx2?.requestId, hasTranscript: parsed.transcript.segments.length > 0 });
    return parsed;
  }

  // Centralized raw getInfo with 3 attempts when playability appears unavailable (no Po token)
  private async getVideoInfoRawWithRetries(id: string): Promise<YT.VideoInfo> {
    const ctx = InnertubeService.requestContext.getStore();
    let last: YT.VideoInfo | undefined;
    for (let attempt = 0; attempt < InnertubeService.MAX_PLAYABILITY_ATTEMPTS; attempt++) {
      const res = await this.innertube.getInfo(id);
      last = res;
      logger.debug('getVideoInfoRawWithRetries:fetched', { id, attempt, requestId: ctx?.requestId });
      if (!InnertubeService.isUnavailablePlayability(res)) break;
      if (attempt < InnertubeService.MAX_PLAYABILITY_ATTEMPTS - 1) {
        await InnertubeService.backoffJitter(
          attempt,
          InnertubeService.DEFAULT_HTTP_OPTIONS.backoffBaseMs ?? 100,
          InnertubeService.MAX_BACKOFF_JITTER_MS
        );
        continue;
      }
    }
    return last as YT.VideoInfo;
  }

  public async getVideoInfoWithPoToken(id: string, parse: true, opts?: RequestOptions): Promise<ParsedVideoInfo>;
  public async getVideoInfoWithPoToken(id: string, parse: false, opts?: RequestOptions): Promise<YT.VideoInfo>;
  public async getVideoInfoWithPoToken(id: string, parse: boolean, opts?: RequestOptions): Promise<YT.VideoInfo | ParsedVideoInfo> {
    return await InnertubeService.requestContext.run({ signal: opts?.signal, requestId: opts?.requestId }, async () => {
      const webInnertube = await InnertubeService.createPlayerInnertubeSafe(id);
      let clientName = webInnertube.session.context.client.clientName;

      const visitorData = InnertubeService.assertVisitorData(webInnertube);
      const { contentPoToken, sessionPoToken } = await InnertubeService.mintPoTokensSafe(id, visitorData);

      // Attempt up to 3 times if playability reports "unavailable" (with per-attempt MWEB fallback)
      const retried = await InnertubeService.getWebOrMwebInfoWithRetries(webInnertube, id, contentPoToken);
      let info: YT.VideoInfo = retried.info;
      clientName = retried.clientName ?? clientName;

      // SABR-only workaround via MWEB
      const mwebInfo = await InnertubeService.getMwebInfoBestEffort(webInnertube, id, contentPoToken);
      if (mwebInfo?.playability_status?.status === 'OK' && mwebInfo?.streaming_data) {
        InnertubeService.mergeInfoFromMweb(info, mwebInfo);
        clientName = 'MWEB';
      }

      let hasTrailer = info.has_trailer;
      let trailerIsAgeRestricted = info.getTrailerInfo() === null;

      if (InnertubeService.needsAgeBypass(info, hasTrailer, trailerIsAgeRestricted)) {
        const bypass = await InnertubeService.tryWebEmbeddedBypassBestEffort(webInnertube, info, id, contentPoToken);
        if (bypass?.updated) {
          ({ hasTrailer, trailerIsAgeRestricted } = bypass);
          clientName = bypass.clientName ?? clientName;
        }
      }

      if (InnertubeService.isUnplayableOrLoginRequired(info, hasTrailer, trailerIsAgeRestricted)) {
        return parse ? parseVideoInfo(info) : info;
      }

      if (hasTrailer && info?.playability_status?.status !== 'OK') {
        InnertubeService.applyTrailerInfo(info);
      }

      InnertubeService.augmentStreamingDataWithSessionPot(info, sessionPoToken);
      InnertubeService.augmentCaptionsWithPot(info, contentPoToken, clientName);

      return parse ? parseVideoInfo(info) : info;
    });
  }

  // #region getVideoInfoWithPoToken helpers
  private static async createPlayerInnertubeSafe(id: string): Promise<Innertube> {
    try {
      await InnertubeService.ensurePlayerReady();
      // playerInnertube is guaranteed by ensurePlayerReady
      return InnertubeService.playerInnertube as Innertube;
    } catch (error) {
      const ctx = InnertubeService.requestContext.getStore();
      logger.error('getVideoInfoWithPoToken:createInnertube error', { id, requestId: ctx?.requestId, error });
      throw error;
    }
  }

  private static assertVisitorData(inn: Innertube): string {
    const visitorData = inn.session.context.client.visitorData;
    if (!visitorData) throw new Error('Missing visitorData in Innertube session context');
    return visitorData;
  }

  private static async mintPoTokensSafe(id: string, visitorData: string): Promise<{ contentPoToken: string; sessionPoToken: string; }> {
    const { generatePoToken } = await import("@/lib/pot.lib");
    try {
      const ctx = InnertubeService.requestContext.getStore();
      return await generatePoToken(id, visitorData, { signal: ctx?.signal });
    } catch (error) {
      const ctx = InnertubeService.requestContext.getStore();
      logger.error('getVideoInfoWithPoToken:generatePoToken error', { id, requestId: ctx?.requestId, error });
      throw error;
    }
  }

  private static async getWebInfoSafe(inn: Innertube, id: string, po: string): Promise<YT.VideoInfo> {
    try {
      return await inn.getInfo(id, { po_token: po });
    } catch (error) {
      const ctx = InnertubeService.requestContext.getStore();
      logger.error('getVideoInfoWithPoToken:getInfo error', { id, requestId: ctx?.requestId, error });
      throw error;
    }
  }

  private static async getMwebInfoBestEffort(inn: Innertube, id: string, po: string): Promise<YT.VideoInfo | undefined> {
    try {
      return await inn.getBasicInfo(id, { client: 'MWEB', po_token: po });
    } catch (error) {
      const ctx = InnertubeService.requestContext.getStore();
      logger.warn('getVideoInfoWithPoToken:MWEB getBasicInfo failed; continuing with WEB info', { id, requestId: ctx?.requestId, error });
      return undefined;
    }
  }

  private static mergeInfoFromMweb(info: YT.VideoInfo, mwebInfo: YT.VideoInfo): void {
    info.playability_status = mwebInfo.playability_status;
    info.streaming_data = mwebInfo.streaming_data;
  }

  private static needsAgeBypass(info: YT.VideoInfo, hasTrailer: boolean, trailerIsAgeRestricted: boolean): boolean {
    const status = info?.playability_status?.status;
    const reason = info?.playability_status?.reason;
    return (
      ((status === 'UNPLAYABLE' || status === 'LOGIN_REQUIRED') && reason === 'Sign in to confirm your age') ||
      (hasTrailer && trailerIsAgeRestricted)
    );
  }

  private static isUnplayableOrLoginRequired(info: YT.VideoInfo, hasTrailer: boolean, trailerIsAgeRestricted: boolean): boolean {
    const status = info?.playability_status?.status;
    return (status === 'UNPLAYABLE' && (!hasTrailer || trailerIsAgeRestricted)) || status === 'LOGIN_REQUIRED';
  }

  // Detect common "unavailable" playability states that may be transient
  private static isUnavailablePlayability(info: YT.VideoInfo): boolean {
    const status = info?.playability_status?.status as string | undefined;
    const reason = String((info as any)?.playability_status?.reason ?? '').toLowerCase();
    const embeddable = (info as any)?.playability_status?.embeddable;
    return (
      status === 'ERROR' ||
      status === 'UNPLAYABLE' ||
      status === 'LOGIN_REQUIRED' ||
      reason.includes('unavailable') ||
      embeddable === false
    );
  }

  // Try WEB with PoToken, and on failure per attempt, try MWEB once. Retry attempts when playability seems unavailable.
  private static async getWebOrMwebInfoWithRetries(inn: Innertube, id: string, po: string): Promise<{ info: YT.VideoInfo; clientName: string; }> {
    const ctx = InnertubeService.requestContext.getStore();
    let last!: YT.VideoInfo;
    let clientName = inn.session.context.client.clientName;
    for (let attempt = 0; attempt < InnertubeService.MAX_PLAYABILITY_ATTEMPTS; attempt++) {
      try {
        last = await InnertubeService.getWebInfoSafe(inn, id, po);
      } catch (e) {
        // On WEB failure, try MWEB once for this attempt
        const mwebOnError = await InnertubeService.getMwebInfoBestEffort(inn, id, po);
        if (mwebOnError) {
          last = mwebOnError;
          clientName = 'MWEB';
        } else {
          if (attempt >= InnertubeService.MAX_PLAYABILITY_ATTEMPTS - 1) throw e;
          await InnertubeService.backoffJitter(
            attempt,
            InnertubeService.DEFAULT_HTTP_OPTIONS.backoffBaseMs ?? 100,
            InnertubeService.MAX_BACKOFF_JITTER_MS
          );
          continue;
        }
      }

      if (!InnertubeService.isUnavailablePlayability(last)) {
        break;
      }
      // If unavailable and not the last attempt, sleep and retry
      if (attempt < InnertubeService.MAX_PLAYABILITY_ATTEMPTS - 1) {
        await InnertubeService.backoffJitter(
          attempt,
          InnertubeService.DEFAULT_HTTP_OPTIONS.backoffBaseMs ?? 100,
          InnertubeService.MAX_BACKOFF_JITTER_MS
        );
        continue;
      }
      // Out of attempts; proceed with current info (may still be unavailable)
      break;
    }
    logger.debug('getWebOrMwebInfoWithRetries:done', { id, clientName, requestId: ctx?.requestId });
    return { info: last, clientName };
  }

  // Abort-aware jittered exponential backoff sleep
  private static async backoffJitter(attempt: number, baseMs: number, maxMs: number): Promise<void> {
    const max = Math.min(baseMs * 2 ** attempt, maxMs);
    const delay = Math.floor(Math.random() * Math.max(1, max));
    const ctx = InnertubeService.requestContext.getStore();
    const { signal, cleanup } = InnertubeService.linkAbortSignals([ctx?.signal]);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanupTimer();
          resolve();
        }, delay);
        const onAbort = () => {
          cleanupTimer();
          const e = Object.assign(new Error('Aborted during retry backoff'), { name: 'AbortError' });
          reject(e);
        };
        const cleanupTimer = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
        };
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    } finally {
      cleanup();
    }
  }

  private static async tryWebEmbeddedBypassBestEffort(webInnertube: Innertube, info: YT.VideoInfo, id: string, po: string): Promise<{ updated: boolean; clientName?: string; hasTrailer: boolean; trailerIsAgeRestricted: boolean; } | undefined> {
    try {
      const webEmbeddedInnertube = await InnertubeService.createInnertube({ clientType: ClientType.WEB_EMBEDDED });
      webEmbeddedInnertube.session.context.client.visitorData = webInnertube.session.context.client.visitorData;

      const errorScreen = info?.playability_status?.error_screen as { video_id?: string } | undefined;
      const videoId = info.has_trailer && info.getTrailerInfo() === null ? (errorScreen?.video_id ?? id) : id;

      // getBasicInfo needs the signature timestamp (sts) from inside the player
      webEmbeddedInnertube.session.player = webInnertube.session.player;

      const bypassedInfo = await webEmbeddedInnertube.getBasicInfo(videoId, { client: 'WEB_EMBEDDED', po_token: po });
      if (bypassedInfo?.playability_status?.status === 'OK' && bypassedInfo?.streaming_data) {
        info.playability_status = bypassedInfo.playability_status;
        info.streaming_data = bypassedInfo.streaming_data;
        info.basic_info.start_timestamp = bypassedInfo.basic_info.start_timestamp;
        info.basic_info.duration = bypassedInfo.basic_info.duration;
        info.captions = bypassedInfo.captions;
        info.storyboards = bypassedInfo.storyboards;

        return {
          updated: true,
          clientName: webEmbeddedInnertube.session.context.client.clientName,
          hasTrailer: false,
          trailerIsAgeRestricted: false,
        };
      }
    } catch (error) {
      const ctx = InnertubeService.requestContext.getStore();
      logger.warn('getVideoInfoWithPoToken:WEB_EMBEDDED bypass failed; continuing without bypass', { id, requestId: ctx?.requestId, error });
    }
    return { updated: false, hasTrailer: info.has_trailer, trailerIsAgeRestricted: info.getTrailerInfo() === null };
  }

  private static applyTrailerInfo(info: YT.VideoInfo): void {
    const trailerInfo = info.getTrailerInfo();
    if (!trailerInfo) return;
    if (info.basic_info.start_timestamp && info?.playability_status?.status !== 'LIVE_STREAM_OFFLINE') {
      info.basic_info.start_timestamp = trailerInfo?.basic_info.start_timestamp ?? null;
    }
    info.playability_status = trailerInfo?.playability_status;
    info.streaming_data = trailerInfo?.streaming_data;
    info.basic_info.duration = trailerInfo?.basic_info.duration;
    info.captions = trailerInfo?.captions;
    info.storyboards = trailerInfo?.storyboards;
  }

  private static augmentStreamingDataWithSessionPot(info: YT.VideoInfo, sessionPoToken: string): void {
    if (!info.streaming_data?.dash_manifest_url) return;
    let url = info.streaming_data.dash_manifest_url;
    if (url.includes('?')) {
      url += `&pot=${encodeURIComponent(sessionPoToken)}&mpd_version=7`;
    } else {
      url += `${url.endsWith('/') ? '' : '/'}pot/${encodeURIComponent(sessionPoToken)}/mpd_version/7`;
    }
    info.streaming_data.dash_manifest_url = url;
  }

  private static augmentCaptionsWithPot(info: YT.VideoInfo, contentPoToken: string, clientName: string): void {
    if (!info.captions?.caption_tracks) return;
    for (const captionTrack of info.captions.caption_tracks) {
      const url = new URL(captionTrack.base_url);
      url.searchParams.set('potc', '1');
      url.searchParams.set('pot', contentPoToken);
      url.searchParams.set('c', clientName);
      url.searchParams.set('fmt', 'json3');
      // Remove &xosf=1 as it adds `position:63% line:0%` to the subtitle lines
      url.searchParams.delete('xosf');
      captionTrack.base_url = url.toString();
    }
  }
  // #endregion

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

  private static isTranscriptEndpoint(url: string): boolean {
    // YouTube transcript endpoint used by youtubei.js
    return url.includes('/v1/get_transcript');
  }

  private static isPlayerAssetUrl(url: string): boolean {
    // Typical player asset path: /s/player/<playerId>/player_*.js (e.g., base.js)
    return url.includes('/s/player/') && (url.includes('base.js') || url.includes('player_'));
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
    const isPlayerAsset = InnertubeService.isPlayerAssetUrl(targetUrl);
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

    // If this is a player asset (JS), serve from in-memory cache or coalesce concurrent fetches
    if (isPlayerAsset && (mergedInit?.method ?? 'GET').toUpperCase() === 'GET') {
      const key = typeof url === 'string' ? url : String(url);
      const cached = InnertubeService.playerAssetCache.get(key);
      if (cached) {
        return new Response(cached.body, { status: cached.status, headers: cached.headers });
      }
      const inflight = InnertubeService.playerAssetInflight.get(key);
      if (inflight) {
        return await inflight;
      }
      const fetchPromise = (async () => {
        // Use resilient http() without proxy for static asset
        const res = await http(url, { ...(mergedInit || {}) });
        const text = await res.text();
        const headersArr: [string, string][] = [];
        res.headers.forEach((v, k) => headersArr.push([k, v]));
        InnertubeService.playerAssetCache.set(key, { body: text, status: res.status, headers: headersArr });
        InnertubeService.playerAssetInflight.delete(key);
        return new Response(text, { status: res.status, headers: headersArr });
      })();
      InnertubeService.playerAssetInflight.set(key, fetchPromise);
      return await fetchPromise;
    }

    // Fast-path: use native fetch directly for non-player endpoints without proxy needs,
    // except transcript endpoint which benefits from our retry logic
    const isTranscript = InnertubeService.isTranscriptEndpoint(targetUrl);
    if (!isPlayerEndpoint && !isProxyEnabled && !isTranscript) {
      // Combine context signal and any init.signal
      const { signal, cleanup } = InnertubeService.linkAbortSignals([ctx?.signal, (writableInit?.signal as AbortSignal | undefined)]);
      try {
        const res = await fetch(url as any, { ...(writableInit || {}), signal } as RequestInit);
        logger.verbose('innertubeFetch native', {
          url: String(url),
          status: res.status,
          durationMs: Math.round(performance.now() - start),
          requestId: ctx?.requestId,
        });
        return res;
      } finally {
        cleanup();
      }
    }

    // Combine context and init signals for http(); stop retries on abort
    const { signal: compositeSignal, cleanup: cleanupLinked } = InnertubeService.linkAbortSignals([
      ctx?.signal,
      (writableInit?.signal as AbortSignal | undefined),
    ]);

    const requestOptions: HttpOptions = {
      ...InnertubeService.DEFAULT_HTTP_OPTIONS,
      ...(isProxyNeeded ? { useProxy: true } : {}),
      // Extend retry behavior for transcript endpoint to also retry on 400 FAILED_PRECONDITION
      ...(isTranscript ? {
        retryOnStatus: [
          ...(InnertubeService.DEFAULT_HTTP_OPTIONS.retryOnStatus ?? []),
          400,
        ]
      } : {}),
      // Player endpoint is heavy (download + parse). Allow longer timeout.
      ...(isPlayerEndpoint ? { timeoutMs: Math.max(20000, InnertubeService.DEFAULT_HTTP_OPTIONS.timeoutMs ?? 0) } : {}),
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
    Log.setLevel(Log.Level.INFO);
    const { withPlayer, location, safetyMode, clientType, generateSessionLocally } = {
      withPlayer: false,
      safetyMode: false,
      // Generate session locally to avoid sw.js_data and similar bootstrap calls
      generateSessionLocally: true,
      ...opts,
    };

    // Initialize and reuse a single persistent cache for all instances (player, session, etc.)
    if (!InnertubeService.sharedCache) {
      // Persistent=true to allow player JSON/JS to be reused reliably across calls
      InnertubeService.sharedCache = new UniversalCache(true);
    }
    const cache: UniversalCache | undefined = InnertubeService.sharedCache;

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

  /**
   * Ensure a singleton player-enabled Innertube is initialized and ready.
   * Safe to call multiple times; subsequent calls are no-ops.
   */
  public static async ensurePlayerReady(): Promise<void> {
    if (InnertubeService.playerInnertube) return;
    if (InnertubeService.playerInit) {
      // Another caller is initializing; await it.
      await InnertubeService.playerInit;
      return;
    }
    const started = performance.now();
    InnertubeService.playerInit = (async () => {
      try {
        InnertubeService.playerInnertube = await InnertubeService.createInnertube({ withPlayer: true });
        const elapsed = Math.round(performance.now() - started);
        logger.info('[ensurePlayerReady] Player initialized', { durationMs: elapsed });
      } catch (error) {
        // Do not crash startup if player pre-warm fails; next request will retry
        const elapsed = Math.round(performance.now() - started);
        logger.warn('[ensurePlayerReady] Player init failed; will retry on demand', { durationMs: elapsed, error });
      } finally {
        InnertubeService.playerInit = undefined;
      }
    })();
    await InnertubeService.playerInit;
  }
}
