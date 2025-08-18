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
  VIDEO_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 4),
});

export type AppConfig = z.infer<typeof configSchema>;

export const parseConfig = (): AppConfig => configSchema.parse(process.env);
