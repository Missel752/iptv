/** Minimal structured logger with levels, timing helpers and CI-friendly output. */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  gray: '\x1b[90m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
} as const;

const useColor = process.stdout.isTTY === true && process.env['NO_COLOR'] === undefined;

function paint(color: keyof typeof COLORS, text: string): string {
  return useColor ? `${COLORS[color]}${text}${COLORS.reset}` : text;
}

function envLevel(): LogLevel {
  const raw = (process.env['LOG_LEVEL'] ?? '').toLowerCase();
  return raw in LEVELS ? (raw as LogLevel) : 'info';
}

export class Logger {
  private level: number;

  constructor(
    private readonly scope: string,
    level: LogLevel = envLevel(),
  ) {
    this.level = LEVELS[level];
  }

  child(scope: string): Logger {
    const next = new Logger(`${this.scope}:${scope}`);
    next.level = this.level;
    return next;
  }

  setLevel(level: LogLevel): void {
    this.level = LEVELS[level];
  }

  private write(level: LogLevel, color: keyof typeof COLORS, args: unknown[]): void {
    if (LEVELS[level] < this.level) return;
    const prefix = `${paint('gray', new Date().toISOString().slice(11, 19))} ${paint(
      color,
      level.toUpperCase().padEnd(5),
    )} ${paint('cyan', this.scope)}`;
    const stream = LEVELS[level] >= LEVELS.warn ? console.error : console.log;
    stream(prefix, ...args);
  }

  debug(...args: unknown[]): void {
    this.write('debug', 'dim', args);
  }
  info(...args: unknown[]): void {
    this.write('info', 'blue', args);
  }
  warn(...args: unknown[]): void {
    this.write('warn', 'yellow', args);
  }
  error(...args: unknown[]): void {
    this.write('error', 'red', args);
  }
  success(...args: unknown[]): void {
    this.write('info', 'green', args);
  }

  /** Times an async operation and logs its duration. */
  async time<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const started = performance.now();
    this.info(`${label}…`);
    try {
      const result = await fn();
      this.success(`${label} ✓ ${paint('gray', formatDuration(performance.now() - started))}`);
      return result;
    } catch (error) {
      this.error(`${label} ✗ ${paint('gray', formatDuration(performance.now() - started))}`);
      throw error;
    }
  }

  /** Renders an in-place progress line; falls back to periodic logs off-TTY. */
  progress(total: number, label: string): (done: number, extra?: string) => void {
    let lastRender = 0;
    const started = Date.now();
    return (done: number, extra = '') => {
      const now = Date.now();
      const finished = done >= total;
      if (!finished && now - lastRender < 500) return;
      lastRender = now;
      const pct = total === 0 ? 100 : Math.round((done / total) * 100);
      const rate = done / Math.max(1, (now - started) / 1000);
      const eta = rate > 0 ? formatDuration(((total - done) / rate) * 1000) : '—';
      const line = `${label} ${done}/${total} (${pct}%) ${extra} eta ${eta}`;
      if (process.stdout.isTTY) {
        process.stdout.write(`\r\x1b[2K${paint('gray', line)}`);
        if (finished) process.stdout.write('\n');
      } else if (finished || pct % 10 === 0) {
        this.info(line);
      }
    };
  }
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m${seconds.toString().padStart(2, '0')}s`;
}

export const logger = new Logger('nexus');
