export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug' | 'verbose';

const LEVEL_ORDER: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
  verbose: 5,
};

function normalizeLevel(lvl: string): LogLevel {
  const v = (lvl || '').toLowerCase() as LogLevel;
  return (v in LEVEL_ORDER ? v : 'info');
}

let currentLevel: LogLevel = normalizeLevel(process.env.APP_LOG_LEVEL ?? 'info');

export function setLogLevel(level: LogLevel) {
  currentLevel = normalizeLevel(level);
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

function shouldLog(level: LogLevel): boolean {
  if (currentLevel === 'silent') return false;
  return LEVEL_ORDER[level] <= LEVEL_ORDER[currentLevel];
}

function nowIso(): string {
  return new Date().toISOString();
}

function asString(v: unknown): string {
  if (v instanceof Error) return v.stack || `${v.name}: ${v.message}`;
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

export interface Logger {
  error: (msg: string, meta?: unknown) => void;
  warn: (msg: string, meta?: unknown) => void;
  info: (msg: string, meta?: unknown) => void;
  debug: (msg: string, meta?: unknown) => void;
  verbose: (msg: string, meta?: unknown) => void;
  child: (scope: string) => Logger;
}

function emit(level: Exclude<LogLevel, 'silent'>, scope: string | undefined, msg: string, meta?: unknown) {
  if (!shouldLog(level)) return;
  const prefix = scope ? `[${scope}]` : '';
  const line = `${nowIso()} ${level.toUpperCase()} ${prefix} ${msg}`.trim();
  const outMeta = meta === undefined ? '' : `\n  → ${asString(meta)}`;
  switch (level) {
    case 'error':
      // eslint-disable-next-line no-console
      console.error(line + outMeta);
      break;
    case 'warn':
      // eslint-disable-next-line no-console
      console.warn(line + outMeta);
      break;
    default:
      // eslint-disable-next-line no-console
      console.log(line + outMeta);
  }
}

export function createLogger(scope?: string): Logger {
  const sc = scope;
  return {
    error: (msg, meta) => emit('error', sc, msg, meta),
    warn: (msg, meta) => emit('warn', sc, msg, meta),
    info: (msg, meta) => emit('info', sc, msg, meta),
    debug: (msg, meta) => emit('debug', sc, msg, meta),
    verbose: (msg, meta) => emit('verbose', sc, msg, meta),
    child: (childScope: string) => createLogger(sc ? `${sc}:${childScope}` : childScope),
  };
}

// Default application logger
export const log = createLogger();
