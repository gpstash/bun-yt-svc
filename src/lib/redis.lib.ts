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
  });
  redis.on('error', (err) => logger.error('Redis error', err));
  redis.on('connect', () => logger.info('Redis connected'));
  redis.on('reconnecting', () => logger.warn('Redis reconnecting...'));
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
