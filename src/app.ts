import { Hono } from 'hono';
import type { AppConfig } from './config';
import { requestLogger } from '@/middleware/logger.middleware';
import { configMiddleware } from '@/middleware/config.middleware';
import { v1RootRouter } from '@/router/v1/root.router';
import type { InnertubeService } from '@/service/innertube.service';
import type { Context } from 'hono';
import type { YTNodes } from 'youtubei.js';
import type { NavigationMapValue } from '@/types/navigation.types';

export interface AppVariables {
  config: AppConfig;
  innertubeSvc: InnertubeService;
  signal: AbortSignal;
  requestId: string;
  navigationEndpoint?: YTNodes.NavigationEndpoint;
  batchIds?: string[];
  navigationEndpointMap?: Map<string, NavigationMapValue>;
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

  app.get('/', (c: Context<AppSchema>) => {
    return c.json({
      message: 'OK',
      timestamp: new Date().toISOString(),
    });
  });

  // HEAD health check endpoint (use generic handler for Hono versions without app.head)
  app.on('HEAD', '/', (c: Context<AppSchema>) => {
    // Fast, empty response for health check probes
    return c.body(null, 200);
  });

  return app;
}
