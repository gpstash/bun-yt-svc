import Redis from 'ioredis';
import { createLogger } from '@/lib/logger.lib';
import { parseConfig } from '@/config';

const logger = createLogger('lib:redis');

let client: Redis | undefined;

function createClient(): Redis | undefined {
  const { REDIS_URL } = parseConfig();
  if (!REDIS_URL) {
    logger.warn('REDIS_URL not set. Redis cache disabled.');
    return undefined;
  }
  const redis = new Redis(REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 3,
    enableOfflineQueue: true,
    connectTimeout: 10000,
    lazyConnectTimeout: 10000,
    keepAlive: 30000,
    family: 0, // Allow both IPv4 and IPv6
    dns: {
      lookup: require('dns').lookup,
    },
    retryDelayOnFailover: 100,
    retryDelayOnClusterDown: 300,
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
    if (!r.status || r.status === 'end') await r.connect();
    const data = await r.get(key);
    if (!data) return null;
    return JSON.parse(data) as T;
  } catch (err) {
    logger.error('redisGetJson failed', { key, err });
    return null;
  }
}

export async function redisSetJson<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
  const r = getRedis();
  if (!r) return;
  try {
    if (!r.status || r.status === 'end') await r.connect();
    const payload = JSON.stringify(value);
    await r.set(key, payload, 'EX', ttlSeconds);
  } catch (err) {
    logger.error('redisSetJson failed', { key, err });
  }
}
