import { buildProxyUrlFromConfig } from '@/helper/proxy.helper';
import { createLogger } from '@/lib/logger.lib';

const logger = createLogger('lib:http');

export interface HttpOptions {
  /** Per-attempt timeout in milliseconds (alias: timeoutMs). */
  timeout?: number;
  timeoutMs?: number;
  /** Total number of attempts including the first try. */
  maxAttempts?: number;
  /** HTTP statuses that should be retried (default: 408,429,5xx common). */
  retryOnStatus?: number[];
  /** Base backoff in ms (alias: backoffBaseMs). */
  backoff?: number;
  backoffBaseMs?: number;
  /** Maximum backoff delay in ms. */
  maxBackoffMs?: number;
  /** HTTP methods allowed to retry (default: GET, HEAD, OPTIONS). */
  retryMethods?: string[];
  /** Honor Retry-After header for retryable statuses (default: true). */
  respectRetryAfter?: boolean;
  /** Custom predicate to decide if a retry should happen. */
  shouldRetry?: (ctx: RetryContext) => boolean | Promise<boolean>;
  /** Optional external abort signal to cancel all attempts. */
  signal?: AbortSignal;
  /** Hook called at the start of each attempt (0-based). */
  onAttempt?: (ctx: RetryContext) => void;
  /** Hook called before a retry sleep with computed delay. */
  onRetry?: (ctx: RetryContext & { delayMs: number }) => void;
  /** Enable proxy for this call (default: follow config PROXY_STATUS). */
  useProxy?: boolean;
  /** Override proxy URL, e.g. http://user:pass@host:port (takes precedence). */
  proxyUrl?: string;
}

export interface RetryContext {
  url: RequestInfo | URL;
  init?: RequestInit;
  attempt: number; // 0-based
  maxAttempts: number;
  response?: Response;
  error?: unknown;
}

export class HttpError extends Error {
  public readonly url: string;
  public readonly method: string;
  public readonly attemptCount: number;
  public readonly status?: number;
  public readonly code?: string;
  public readonly cause?: unknown;

  constructor(message: string, opts: { url: RequestInfo | URL; method?: string; attemptCount: number; status?: number; code?: string; cause?: unknown }) {
    super(message);
    this.name = 'HttpError';
    this.url = String(opts.url);
    this.method = (opts.method || 'GET').toUpperCase();
    this.attemptCount = opts.attemptCount;
    this.status = opts.status;
    this.code = opts.code;
    this.cause = opts.cause;
  }
}

const DEFAULT_RETRYABLE_METHODS = ['GET', 'HEAD', 'OPTIONS'];

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

function linkAbortSignals(signals: (AbortSignal | undefined)[]) {
  const controller = new AbortController();
  if (signals.some(s => s?.aborted)) {
    controller.abort();
    return { signal: controller.signal, cleanup: () => { } };
  }
  const handlers: Array<() => void> = [];
  for (const s of signals) {
    if (!s) continue;
    const onAbort = () => controller.abort(s.reason);
    s.addEventListener('abort', onAbort, { once: true });
    handlers.push(() => s.removeEventListener('abort', onAbort));
  }
  return {
    signal: controller.signal,
    cleanup: () => handlers.forEach(h => h()),
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(Object.assign(new Error('Aborted during backoff sleep'), { name: 'AbortError' }));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function computeJitterBackoff(baseMs: number, attempt: number, maxMs: number): number {
  const exp = Math.min(baseMs * 2 ** attempt, maxMs);
  // Full jitter: random between 0 and exp
  return Math.floor(Math.random() * exp);
}

function parseRetryAfterMs(h: string | null): number | undefined {
  if (!h) return undefined;
  // seconds value
  const asInt = Number(h);
  if (Number.isFinite(asInt)) return Math.max(0, Math.floor(asInt * 1000));
  // HTTP-date
  const ts = Date.parse(h);
  if (Number.isFinite(ts)) {
    const diff = ts - Date.now();
    return diff > 0 ? diff : 0;
  }
  return undefined;
}

export const http = async (
  url: RequestInfo | URL,
  init?: RequestInit,
  options?: HttpOptions,
): Promise<Response> => {
  const {
    timeout: timeoutAlias,
    timeoutMs,
    maxAttempts = 3,
    retryOnStatus = [408, 429, 500, 502, 503, 504],
    backoff: backoffAlias,
    backoffBaseMs,
    maxBackoffMs = 150,
    retryMethods = DEFAULT_RETRYABLE_METHODS,
    respectRetryAfter = true,
    shouldRetry,
    signal: outerSignal,
    onAttempt,
    onRetry,
  } = options || {};

  const method = (init?.method || 'GET').toUpperCase();
  const perAttemptTimeout = timeoutMs ?? timeoutAlias ?? 8000;
  const baseBackoff = backoffBaseMs ?? backoffAlias ?? 100;

  // Prepare per-call proxy URL (Bun fetch native proxy support)
  const proxyUrl: string | undefined = options?.useProxy
    ? (options.proxyUrl ?? buildProxyUrlFromConfig())
    : undefined;
  if (options?.useProxy) {
    if (proxyUrl) {
      logger.debug('proxy enabled for request', { url: String(url), proxyUrl: String(proxyUrl) });
    } else {
      logger.warn('useProxy=true but no proxy URL provided/resolved');
    }
  }

  for (let attempt = 0; attempt < Math.max(1, maxAttempts); attempt++) {
    const timeoutController = new AbortController();
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      timeoutController.abort(Object.assign(new Error('Request timed out'), { name: 'AbortError' }));
    }, perAttemptTimeout);

    const { signal: mergedSignal, cleanup } = linkAbortSignals([outerSignal, (init?.signal ?? undefined) as AbortSignal | undefined, timeoutController.signal]);

    try {
      onAttempt?.({ url, init, attempt, maxAttempts });
      logger.verbose('attempt start', {
        url: String(url),
        method,
        attempt,
        maxAttempts,
        perAttemptTimeout,
      });

      // Attach Bun fetch native proxy option if enabled
      const requestInit: RequestInit & { proxy?: string } = { ...init, signal: mergedSignal };
      if (proxyUrl) requestInit.proxy = proxyUrl;
      const response = await fetch(url as any, requestInit as RequestInit);

      if (response.ok) {
        logger.verbose('response ok', { url: String(url), status: response.status });
        return response;
      }

      const status = response.status;
      const isRetryableStatus = retryOnStatus.includes(status);
      const methodAllowsRetry = retryMethods.includes(method);
      const isLastAttempt = attempt >= maxAttempts - 1;

      const ctx: RetryContext = { url, init, attempt, maxAttempts, response };
      const customWantsRetry = shouldRetry ? await shouldRetry(ctx) : undefined;
      const shouldRetryNow = (customWantsRetry ?? (isRetryableStatus && methodAllowsRetry)) && !isLastAttempt;

      if (!shouldRetryNow) {
        // Return the last received response (even if non-OK) so caller can inspect.
        logger.verbose('non-ok, not retrying', { url: String(url), status, attempt });
        return response;
      }

      // Compute delay: honor Retry-After when applicable
      let delayMs: number | undefined;
      if (respectRetryAfter && (status === 429 || status === 503)) {
        delayMs = parseRetryAfterMs(response.headers.get('retry-after'));
      }
      if (delayMs == null) {
        delayMs = computeJitterBackoff(baseBackoff, attempt, maxBackoffMs);
      }

      onRetry?.({ ...ctx, delayMs });
      logger.verbose('retrying after non-ok', { url: String(url), status, attempt, delayMs });
      // Sleep should also react to init.signal aborts, not just outerSignal
      const { signal: sleepSignal, cleanup: sleepCleanup } = linkAbortSignals([outerSignal, (init?.signal ?? undefined) as AbortSignal | undefined]);
      try {
        await sleep(delayMs, sleepSignal);
      } finally {
        sleepCleanup();
      }
      continue;
    } catch (err) {
      const isAborted = isAbortError(err);
      const methodAllowsRetry = retryMethods.includes(method);
      const isLastAttempt = attempt >= maxAttempts - 1;

      const ctx: RetryContext = { url, init, attempt, maxAttempts, error: err };
      const customWantsRetry = shouldRetry ? await shouldRetry(ctx) : undefined;
      const shouldRetryNow = (customWantsRetry ?? (isAborted ? timedOut : true)) && methodAllowsRetry && !isLastAttempt;

      if (!shouldRetryNow) {
        // Build informative error
        const code = isAborted ? (timedOut ? 'ETIMEDOUT' : 'EABORT') : undefined;
        const msg = isAborted
          ? `Fetch aborted for ${String(url)} (${timedOut ? 'timeout' : 'external abort'}) after ${attempt + 1} attempt(s)`
          : `Fetch failed for ${String(url)} after ${attempt + 1} attempt(s)`;
        logger.error('giving up after error', { url: String(url), attempt, code, message: msg });
        throw new HttpError(msg, { url, method, attemptCount: attempt + 1, code, cause: err });
      }

      const delayMs = computeJitterBackoff(baseBackoff, attempt, maxBackoffMs);
      onRetry?.({ url, init, attempt, maxAttempts, error: err, delayMs });
      logger.verbose('retrying after error', { url: String(url), attempt, delayMs, aborted: isAborted, timedOut });
      const { signal: sleepSignal, cleanup: sleepCleanup } = linkAbortSignals([outerSignal, (init?.signal ?? undefined) as AbortSignal | undefined]);
      try {
        await sleep(delayMs, sleepSignal);
      } finally {
        sleepCleanup();
      }
      continue;
    } finally {
      clearTimeout(timeoutId);
      logger.debug('attempt cleanup', { url: String(url), attempt });
      cleanup();
    }
  }

  // Should never reach here due to returns/throws in loop
  logger.error('unexpected retry loop exit', { url: String(url), method: (init?.method || 'GET').toUpperCase() });
  throw new HttpError(`Unexpected retry loop exit for ${String(url)}`, { url, attemptCount: 0, method: (init?.method || 'GET').toUpperCase() });
};

export async function httpJson<T = unknown>(
  url: RequestInfo | URL,
  init?: RequestInit,
  options?: HttpOptions,
): Promise<{ response: Response; data: T }> {
  const res = await http(url, init, options);
  const ctype = res.headers.get('content-type') || '';
  const text = await res.text();
  try {
    const data = (ctype.includes('application/json') || ctype.includes('+json'))
      ? JSON.parse(text) as T
      : (JSON.parse(text) as T); // attempt parse regardless; many APIs omit header
    return { response: res, data };
  } catch (e) {
    throw new HttpError(`Failed to parse JSON from ${String(url)}: ${(e as Error).message}`, {
      url,
      method: (init?.method || 'GET').toUpperCase(),
      attemptCount: 1,
      code: 'EJSONPARSE',
      cause: e,
      status: res.status,
    });
  }
}
