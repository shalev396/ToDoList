/**
 * Redacting logger. Everything that reaches CloudWatch (or the local console) passes through
 * redact(): values under sensitive keys are masked and secret-shaped strings are replaced, so a
 * provider error or a request object can never print a token (DATA.md §0.5, BACKEND.md §6).
 *
 * installConsoleRedaction() wraps console.* once, so existing console.error calls are covered too.
 */
import { redactString } from './secretPatterns.js';

type Level = 'debug' | 'info' | 'warn' | 'error';
const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Key names whose values are never logged. */
const SENSITIVE_KEY =
  /token|secret|authorization|password|passwd|api[-_]?key|cookie|credential|private[-_]?key|^enc$|ciphertext|signature|^sig$/i;

export function redact(value: unknown, seen = new WeakSet()): unknown {
  if (typeof value === 'string') return redactString(value);
  if (typeof value !== 'object' || value === null) return value;
  if (value instanceof Date) return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (value instanceof Error) {
    const out: Record<string, unknown> = { name: value.name, message: redactString(value.message) };
    if (value.stack !== undefined) out['stack'] = redactString(value.stack);
    const { code, status, statusCode } = value as {
      code?: unknown;
      status?: unknown;
      statusCode?: unknown;
    };
    if (code !== undefined) out['code'] = code;
    if (status !== undefined) out['status'] = status;
    if (statusCode !== undefined) out['statusCode'] = statusCode;
    return out;
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, seen));
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] =
      SENSITIVE_KEY.test(key) && child !== null && child !== undefined
        ? '[REDACTED]'
        : redact(child, seen);
  }
  return out;
}

/** Fixed threshold: 'info'. A script that wants quieter logs calls setLogLevel(). */
let currentLevel: Level = 'info';

export function setLogLevel(level: Level): void {
  currentLevel = level;
}

function threshold(): number {
  return LEVELS[currentLevel];
}

function emit(level: Level, message: string, meta?: unknown): void {
  if (LEVELS[level] < threshold()) return;
  const line = `[${level}] ${redactString(message)}`;
  const args = meta === undefined ? [line] : [line, redact(meta)];
  if (level === 'error') originalError(...args);
  else originalWarn(...args);
}

const originalWarn = console.warn.bind(console);
const originalError = console.error.bind(console);
const { dir } = console;
const originalDir = dir.bind(console);

export const logger = {
  debug: (message: string, meta?: unknown): void => {
    emit('debug', message, meta);
  },
  info: (message: string, meta?: unknown): void => {
    emit('info', message, meta);
  },
  warn: (message: string, meta?: unknown): void => {
    emit('warn', message, meta);
  },
  error: (message: string, meta?: unknown): void => {
    emit('error', message, meta);
  },
};

let consoleWrapped = false;

/** Routes console.log/info/warn/error/debug/trace/dir through redact(). Idempotent. */
export function installConsoleRedaction(): void {
  if (consoleWrapped) return;
  consoleWrapped = true;
  const wrap =
    (target: (...args: unknown[]) => void) =>
    (...args: unknown[]): void => {
      target(...args.map((arg) => redact(arg)));
    };
  Object.assign(console, {
    warn: wrap(originalWarn),
    error: wrap(originalError),
    log: wrap(originalWarn),
    info: wrap(originalWarn),
    debug: wrap(originalWarn),
    trace: wrap(originalWarn),
    dir: (value: unknown, options?: object): void => {
      originalDir(redact(value), options);
    },
  });
}
