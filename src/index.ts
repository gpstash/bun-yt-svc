import { parseConfig } from './config';
import { setLogLevel } from './lib/logger.lib';

// Parse minimal config early for server bind parameters and logging
const config = parseConfig();
setLogLevel(config.APP_LOG_LEVEL);

// Lazily create the app on first request to keep cold start minimal
let appPromise: Promise<ReturnType<typeof import('./app')['createApp']>> | null = null;

async function getApp() {
  if (!appPromise) {
    appPromise = import('./app').then(({ createApp }) => createApp(config));
  }
  return appPromise;
}

export default {
  fetch: async (...args: any[]) => {
    const app = await getApp();
    return (app.fetch as any)(...args);
  },
  port: Number(config.APP_PORT),
  idleTimeout: Number(config.IDLE_TIMEOUT_SECONDS),
};
