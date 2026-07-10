import { pino, type Logger } from 'pino';
import type { Env } from './env.js';

export type { Logger };

/** The single redaction list — secrets never reach the log stream. */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  '*.password',
  '*.secret',
  '*.token',
  'DATABASE_URL',
  'AUTH_SECRET',
  'API_KEY_PEPPERS',
  'SETUP_TOKEN',
  'METRICS_TOKEN',
  'SMTP_URL',
  'RESEND_API_KEY',
  'S3_SECRET_ACCESS_KEY',
  'S3_ACCESS_KEY_ID'
];

export function createLogger(env: Pick<Env, 'LOG_LEVEL' | 'NODE_ENV'>): Logger {
  const options = {
    level: env.LOG_LEVEL,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' }
  };
  if (env.NODE_ENV === 'development') {
    // pino-pretty is a devDependency; if it is absent (e.g. NODE_ENV flipped
    // on a pruned production image) fall back to JSON instead of crashing.
    try {
      return pino({ ...options, transport: { target: 'pino-pretty', options: { colorize: true } } });
    } catch {
      // fall through to JSON output
    }
  }
  return pino(options);
}
