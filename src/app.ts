import { Hono } from 'hono';
import type { AppConfig } from './config';
import { requestLogger } from '@/middleware/logger.middleware';
import { configMiddleware } from '@/middleware/config.middleware';
import { v1RootRouter } from '@/router/v1/root.router';
import type { InnertubeService } from '@/service/innertube.service';

export interface AppVariables {
  config: AppConfig;
  innertubeSvc: InnertubeService;
  signal: AbortSignal;
  requestId: string;
}

export interface AppSchema {
  Variables: AppVariables;
}

export function createApp(config: AppConfig) {
  const app = new Hono<AppSchema>();

  app.use('*', requestLogger());
  app.use('*', configMiddleware(config));

  // v1 route
  app.route('/v1', v1RootRouter);

  app.get('/', (c) => {
    return c.json({
      message: 'OK',
      timestamp: new Date().toISOString(),
    });
  });

  return app;
}