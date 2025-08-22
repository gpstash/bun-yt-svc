import { z } from 'zod';

export const configSchema = z.object({
  APP_PORT: z.string().default('1331'),
  APP_LOG_LEVEL: z.enum(['silent', 'error', 'warn', 'info', 'debug', 'verbose']).default('info'),
  PROXY_HOST: z.string().default('127.0.0.1'),
  PROXY_PORT: z.string().default('10800'),
  PROXY_USERNAME: z.string().default(''),
  PROXY_PASSWORD: z.string().default(''),
  PROXY_STATUS: z.enum(['active', 'inactive']).default('inactive'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  VIDEO_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 4), // 4 hours
  CHANNEL_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 24), // 1 day
  TRANSCRIPT_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 24), // 1 day
  CAPTION_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 24), // 1 day
  // Prefer longer navigation cache to avoid repeated resolveURL calls.
  // If set, this overrides VIDEO/CHANNEL cache TTLs used in navigation.helper.
  NAVIGATION_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 24 * 30), // 30 days
  // Batch throttling controls for safe crawling
  INNERTUBE_BATCH_CONCURRENCY: z.coerce.number().int().positive().max(10).default(3),
  INNERTUBE_BATCH_MIN_DELAY_MS: z.coerce.number().int().positive().default(150),
  INNERTUBE_BATCH_MAX_DELAY_MS: z.coerce.number().int().positive().default(400),
  // Bun.serve idle timeout (seconds). Default Bun is 10s; increase for long requests
  IDLE_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(120),
});

export type AppConfig = z.infer<typeof configSchema>;

export const parseConfig = (): AppConfig => configSchema.parse(process.env);
