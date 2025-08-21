import { createApp } from './app';
import { parseConfig } from './config';
import { setLogLevel } from './lib/logger.lib';
import { InnertubeService } from './service/innertube.service';

const config = parseConfig();

// Apply application log level from config so it doesn't rely on process.env.LOG_LEVEL
setLogLevel(config.APP_LOG_LEVEL);
const app = createApp(config);

// Non-blocking prewarm: initialize the player-enabled Innertube singleton
// to avoid first-request latency on cold start.
void InnertubeService.ensurePlayerReady();

export default {
  fetch: app.fetch,
  port: Number(config.APP_PORT),
  idleTimeout: Number(config.IDLE_TIMEOUT_SECONDS),
};
