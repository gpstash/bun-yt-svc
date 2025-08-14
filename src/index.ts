import { createApp } from './app';
import { parseConfig } from './config';
import { setLogLevel } from './lib/logger.lib';

const config = parseConfig();

// Apply application log level from config so it doesn't rely on process.env.LOG_LEVEL
setLogLevel(config.APP_LOG_LEVEL);
const app = createApp(config);

export default {
  fetch: app.fetch,
  port: Number(config.APP_PORT),
};
