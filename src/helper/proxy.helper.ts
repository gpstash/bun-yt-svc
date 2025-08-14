import { parseConfig } from '@/config';
import { createLogger } from '@/lib/logger.lib';

const logger = createLogger('helper:proxy');

export function buildProxyUrlFromConfig(): string | undefined {
  try {
    const cfg = parseConfig();
    if (cfg.PROXY_STATUS !== 'active') {
      logger.debug('proxy inactive by config');
      return undefined;
    }
    const host = cfg.PROXY_HOST;
    const port = cfg.PROXY_PORT;
    if (!host || !port) return undefined;
    const user = cfg.PROXY_USERNAME;
    const pass = cfg.PROXY_PASSWORD;
    const auth = user ? `${encodeURIComponent(user)}${pass ? ':' + encodeURIComponent(pass) : ''}@` : '';
    const url = `http://${auth}${host}:${port}`;
    // Redact credentials in logs
    logger.info('proxy url built', { host, port, hasAuth: Boolean(user) });
    return url;
  } catch {
    logger.warn('failed to build proxy url');
    return undefined;
  }
}
