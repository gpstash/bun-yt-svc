import Redis from 'ioredis';
import { gzipSync, gunzipSync } from 'zlib';
import { createLogger } from '@/lib/logger.lib';
import { parseConfig } from '@/config';

const logger = createLogger('lib:redis');

let client: Redis | undefined;

// Compress values larger than this many bytes (after JSON.stringify)
const COMPRESS_THRESHOLD_BYTES = 8 * 1024; // 8KB
const COMPRESS_PREFIX = 'gz:'; // marker for compressed base64 payloads

function createClient(): Redis | undefined {
  const { REDIS_URL } = parseConfig();
  if (!REDIS_URL) {
    logger.warn('REDIS_URL not set. Redis cache disabled.');
    return undefined;
  }
  const redis = new Redis(REDIS_URL, {
    // Do not connect immediately at boot; we'll connect on first use
    lazyConnect: true,
    // Fail fast: do not queue commands when offline, and do not endlessly retry a single command
    enableOfflineQueue: false,
    autoResubscribe: false,
    autoResendUnfulfilledCommands: false,
    maxRetriesPerRequest: 1,
    // Backoff and stop reconnecting after a few attempts to avoid infinite loops on DNS errors
    retryStrategy: (times) => {
      if (times > 5) return null; // stop retrying after N attempts
      return Math.min(times * 200, 2000); // backoff up to 2s
    },
  });
  // Build a safe URL for logs (mask password)
  const safeUrl = (() => {
    try {
      const u = new URL(REDIS_URL);
      if (u.password) u.password = '***';
      return u.toString();
    } catch {
      return REDIS_URL.replace(/:[^@]*@/, ':***@');
    }
  })();

  logger.info('Redis configured', { url: safeUrl });

  redis.on('error', (err) => logger.error('Redis error', { url: safeUrl, err }));
  redis.on('connect', () => logger.info('Redis connected', { url: safeUrl }));
  redis.on('reconnecting', () => logger.warn('Redis reconnecting...', { url: safeUrl }));
  return redis;
}

export function getRedis(): Redis | undefined {
  if (client) return client;
  client = createClient();
  return client;
}

export async function redisGetJson<T>(key: string): Promise<T | null> {
  const r = getRedis();
  if (!r) return null;
  try {
    if (r.status !== 'ready') await r.connect();
    const data = await r.getBuffer(key as any);
    if (!data) return null;
    // Detect our compression marker when stored as string or buffer
    let text: string;
    if (data.length >= 3 && data[0] === 0x67 && data[1] === 0x7a && data[2] === 0x3a) { // 'g''z':''
      // Buffer begins with 'gz:' followed by base64
      const b64 = data.subarray(3).toString('utf8');
      const buf = Buffer.from(b64, 'base64');
      const out = gunzipSync(buf);
      text = out.toString('utf8');
    } else {
      // Not marked; treat as UTF-8 JSON string
      text = data.toString('utf8');
      // Also handle the case it was stored as gz:... string (older client)
      if (text.startsWith(COMPRESS_PREFIX)) {
        const b64 = text.slice(COMPRESS_PREFIX.length);
        const buf = Buffer.from(b64, 'base64');
        const out = gunzipSync(buf);
        text = out.toString('utf8');
      }
    }
    return JSON.parse(text) as T;
  } catch (err) {
    console.log(err)
    logger.error('redisGetJson failed', { key, err });
    return null;
  }
}

export async function redisSetJson<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
  const r = getRedis();
  if (!r) return;
  try {
    if (r.status !== 'ready') await r.connect();
    const plain = JSON.stringify(value);
    let toStore: string | Buffer;
    if (Buffer.byteLength(plain, 'utf8') >= COMPRESS_THRESHOLD_BYTES) {
      const gz = gzipSync(Buffer.from(plain, 'utf8'));
      const b64 = gz.toString('base64');
      toStore = Buffer.from(COMPRESS_PREFIX + b64, 'utf8');
    } else {
      toStore = plain;
    }
    await r.set(key as any, toStore as any, 'EX', ttlSeconds);
  } catch (err) {
    logger.error('redisSetJson failed', { key, err });
  }
}

export async function redisAcquireLock(lockKey: string, ttlMs: number): Promise<string | null> {
  const r = getRedis();
  if (!r) return null;
  try {
    if (r.status !== 'ready') await r.connect();
    const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const ok = await r.set(lockKey, token, 'PX', ttlMs, 'NX');
    return ok === 'OK' ? token : null;
  } catch (err) {
    logger.error('redisAcquireLock failed', { lockKey, err });
    return null;
  }
}

export async function redisReleaseLock(lockKey: string, token: string): Promise<boolean> {
  const r = getRedis();
  if (!r) return false;
  const lua = `
    if redis.call('GET', KEYS[1]) == ARGV[1] then
      return redis.call('DEL', KEYS[1])
    else
      return 0
    end
  `;
  try {
    if (r.status !== 'ready') await r.connect();
    const res = await r.eval(lua, 1, lockKey, token);
    return Number(res) === 1;
  } catch (err) {
    logger.error('redisReleaseLock failed', { lockKey, err });
    return false;
  }
}

export async function redisWaitForKey<T>(key: string, timeoutMs: number, pollMs = 50): Promise<T | null> {
  const r = getRedis();
  if (!r) return null;
  const start = Date.now();
  try {
    if (r.status !== 'ready') await r.connect();
    while (Date.now() - start < timeoutMs) {
      const data = await r.getBuffer(key as any);
      if (data) {
        let text: string;
        if (data.length >= 3 && data[0] === 0x67 && data[1] === 0x7a && data[2] === 0x3a) {
          const b64 = data.subarray(3).toString('utf8');
          const buf = Buffer.from(b64, 'base64');
          const out = gunzipSync(buf);
          text = out.toString('utf8');
        } else {
          text = data.toString('utf8');
          if (text.startsWith(COMPRESS_PREFIX)) {
            const b64 = text.slice(COMPRESS_PREFIX.length);
            const buf = Buffer.from(b64, 'base64');
            const out = gunzipSync(buf);
            text = out.toString('utf8');
          }
        }
        return JSON.parse(text) as T;
      }
      await new Promise(res => setTimeout(res, pollMs));
    }
    return null;
  } catch (err) {
    logger.error('redisWaitForKey failed', { key, err });
    return null;
  }
}
