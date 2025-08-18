import type { WebPoSignalOutput } from 'bgutils-js';
import { BG, buildURL, GOOG_API_KEY, USER_AGENT } from 'bgutils-js';
import { Innertube } from 'youtubei.js';
import { createLogger } from './logger.lib';

const userAgent = USER_AGENT;

const logger = createLogger('lib:pot');

type GeneratePoTokenOptions = { signal?: AbortSignal };

// Cache and single-flight state
let domInitPromise: Promise<void> | null = null;
const interpreterCache = new Map<string, string>();
const interpreterInFlight = new Map<string, Promise<string>>();
const evaluatedInterpreter = new Set<string>();

async function ensureDomOnce() {
  if (domInitPromise) return domInitPromise;
  domInitPromise = (async () => {
    const { JSDOM } = await import('jsdom');
    const dom = new JSDOM('<!DOCTYPE html><html lang="en"><head><title></title></head><body></body></html>', {
      url: 'https://www.youtube.com/',
      referrer: 'https://www.youtube.com/',
      userAgent
    });
    Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document,
      location: dom.window.location,
      origin: dom.window.origin
    });
    if (!Reflect.has(globalThis, 'navigator')) {
      Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator });
    }
  })();
  return domInitPromise;
}

async function fetchInterpreterOnce(url: string, signal?: AbortSignal): Promise<string> {
  const key = url;
  if (interpreterCache.has(key)) return interpreterCache.get(key)!;
  const inflight = interpreterInFlight.get(key);
  if (inflight) return inflight;
  const p = (async () => {
    const res = await fetch(url, { signal });
    const txt = await res.text();
    interpreterCache.set(key, txt);
    interpreterInFlight.delete(key);
    return txt;
  })();
  interpreterInFlight.set(key, p);
  return p;
}

function evalInterpreterIfNeeded(url: string, code: string) {
  if (evaluatedInterpreter.has(url)) return;
  if (!code) throw new Error('Could not load VM');
  // Evaluate once per unique interpreter script URL
  new Function(code)();
  evaluatedInterpreter.add(url);
}

export async function generatePoToken(videoId: string, visitorData: string, opts?: GeneratePoTokenOptions): Promise<{ contentPoToken: string, sessionPoToken: string }> {
  // Initialize DOM environment once
  await ensureDomOnce();

  // Fresh innertube to request a challenge (session cache disabled intentionally)
  const innertube = await Innertube.create({ user_agent: userAgent, enable_session_cache: false });

  // #region BotGuard Initialization
  const challengeResponse = await innertube.getAttestationChallenge('ENGAGEMENT_TYPE_UNBOUND');
  if (!challengeResponse.bg_challenge)
    throw new Error('Could not get challenge');

  const interpreterUrlPath = challengeResponse.bg_challenge.interpreter_url.private_do_not_access_or_else_trusted_resource_url_wrapped_value;
  const fullInterpreterUrl = `https:${interpreterUrlPath}`;
  const interpreterJavascript = await fetchInterpreterOnce(fullInterpreterUrl, opts?.signal);
  evalInterpreterIfNeeded(fullInterpreterUrl, interpreterJavascript);

  const botguard = await BG.BotGuardClient.create({
    program: challengeResponse.bg_challenge.program,
    globalName: challengeResponse.bg_challenge.global_name,
    globalObj: globalThis
  });
  // #endregion

  // #region WebPO Token Generation
  const webPoSignalOutput: WebPoSignalOutput = [];
  const botguardResponse = await botguard.snapshot({ webPoSignalOutput });
  const requestKey = 'O43z0dpjhgX20SCx4KAo';

  const integrityTokenResponse = await fetch(buildURL('GenerateIT', true), {
    method: 'POST',
    headers: {
      'content-type': 'application/json+protobuf',
      'x-goog-api-key': GOOG_API_KEY,
      'x-user-agent': 'grpc-web-javascript/0.1',
      'user-agent': userAgent
    },
    body: JSON.stringify([requestKey, botguardResponse]),
    signal: opts?.signal,
  });

  const response = await integrityTokenResponse.json() as unknown[];
  if (typeof response[0] !== 'string')
    throw new Error('Could not get integrity token');

  const integrityTokenBasedMinter = await BG.WebPoMinter.create({ integrityToken: response[0] }, webPoSignalOutput);
  // #endregion

  // #region YouTube.js Usage Example
  const contentPoToken = await integrityTokenBasedMinter.mintAsWebsafeString(videoId);
  const sessionPoToken = await integrityTokenBasedMinter.mintAsWebsafeString(visitorData);

  const mask = (v: string) => (typeof v === 'string' ? `${v.length}b:***${v.slice(-4)}` : 'n/a');
  logger.debug('Visitor data:', mask(decodeURIComponent(visitorData)));
  logger.debug('Content WebPO Token:', mask(contentPoToken));
  logger.debug('Session WebPO Token:', mask(sessionPoToken));
  logger.debug('Cold Start WebPO Token:', mask(BG.PoToken.generateColdStartToken(visitorData)));
  // #endregion

  return { contentPoToken, sessionPoToken };
}