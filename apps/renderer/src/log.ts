/**
 * The renderer's logger: one JSON line per call on stdout, `{ level, time,
 * msg, ...fields }`, gated by LOG_LEVEL. Deliberately tiny (the image carries
 * playwright-core and nothing else). Callers never pass the shared secret or a
 * job's key: jobs are named by their id.
 */
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export type LogFields = Record<string, unknown>;

export interface Log {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

export function isLogLevel(v: string): v is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(v);
}

export function createLog(
  level: LogLevel = 'info',
  write: (line: string) => void = (l) => process.stdout.write(l)
): Log {
  const min = LOG_LEVELS.indexOf(level);
  const at =
    (lvl: LogLevel) =>
    (msg: string, fields: LogFields = {}): void => {
      if (LOG_LEVELS.indexOf(lvl) < min) return;
      write(`${JSON.stringify({ level: lvl, time: new Date().toISOString(), msg, ...fields })}\n`);
    };
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}
