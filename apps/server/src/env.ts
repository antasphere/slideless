import { z } from 'zod';
import { parseApiKeyPeppers } from './apikeys/peppers.js';
import { parseSuperadminEmails } from './accounts/superadmin.js';

/**
 * The single entry point for configuration. Every env var the app reads is
 * declared here; the docs env reference is generated from this schema.
 * Parsing failures print a readable table and exit — the app never boots on a
 * half-valid environment.
 */

/**
 * Empty OR whitespace-only (e.g. `VAR=` or `VAR=" "` in compose) means unset.
 * The trim matters: `Number(' ')` is 0, so an untrimmed blank would silently
 * flip a `min(0)` numeric knob (like the API rate limit) to its 0/disabled
 * meaning instead of the default — a security control off by a stray space.
 */
const blankToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

const booleanish = z.preprocess(
  blankToUndefined,
  z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1')
);

/** Optional string where an empty value (e.g. `VAR=` in compose) means unset. */
const optionalString = (inner: z.ZodString) => z.preprocess(blankToUndefined, inner.optional());

export const envSchema = z.object({
  /** Postgres connection string. The only required variable. */
  DATABASE_URL: z.string().min(1, 'required — postgres://user:pass@host:5432/db'),
  /** Port the single HTTP listener binds. */
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  /** Bind address. */
  HOST: z.string().default('0.0.0.0'),
  /** Public origin of this instance (scheme matters: https => Secure cookies). */
  PUBLIC_BASE_URL: z.url().default('http://localhost:3000'),
  /** Writable data directory (auto-generated secret, local file storage). */
  DATA_DIR: z.string().default('/data'),
  /** Apply pending migrations at boot. When false the app only checks and refuses readiness while behind. */
  AUTO_MIGRATE: booleanish.default(true),
  /** all = API + workers in one process; api = HTTP only; worker = jobs only. */
  SERVICE_ROLE: z.enum(['all', 'api', 'worker']).default('all'),
  /** Session/JWKS encryption secret. Auto-generated into DATA_DIR/secret when unset or empty. */
  AUTH_SECRET: optionalString(z.string().min(32)),
  /** Versioned API-key peppers for secret rotation: `<version>:<secret>` entries joined by `;` (e.g. `1:<historical AUTH_SECRET>;2:<new pepper>`, secrets >=32 chars). Version 1 defaults to AUTH_SECRET and, when pinned here, MUST keep the historical AUTH_SECRET-derived value or every existing key stops resolving; new keys mint under the highest version. Rotation runbook: docs/security.md. */
  API_KEY_PEPPERS: optionalString(
    z.string().superRefine((raw, ctx) => {
      try {
        parseApiKeyPeppers(raw);
      } catch (err) {
        ctx.addIssue({ code: 'custom', message: err instanceof Error ? err.message : String(err) });
      }
    })
  ),
  /** When set, POST /api/v1/setup requires this token (constant-time compared). */
  SETUP_TOKEN: optionalString(z.string().min(8)),
  /** Break-glass operator allowlist: comma-separated emails. A caller is superadmin ONLY on a SESSION whose VERIFIED email is listed here — machine credentials (API keys, OAuth tokens) never qualify, they 403 fail-closed. Unset (default) = the break-glass endpoints are dormant and 403 for everyone. Runbook: docs/security.md. */
  SUPERADMIN_EMAILS: optionalString(
    z.string().superRefine((raw, ctx) => {
      try {
        parseSuperadminEmails(raw);
      } catch (err) {
        ctx.addIssue({ code: 'custom', message: err instanceof Error ? err.message : String(err) });
      }
    })
  ),
  /** Optional Google social login. */
  GOOGLE_CLIENT_ID: optionalString(z.string().min(1)),
  GOOGLE_CLIENT_SECRET: optionalString(z.string().min(1)),
  /** Edition tag surfaced in discovery + usage events (products override). */
  EDITION: z.string().default('oss'),
  /** Build version stamped by CI (Docker ARG); 'dev' locally. */
  APP_VERSION: z.string().default('dev'),
  /** Instance-level cap read by the default AllowAllEntitlements. */
  MAX_FILE_SIZE_MB: z.coerce.number().int().min(1).default(100),
  /** General per-principal API quota: sustained requests/minute allowed to every authenticated /api/v1 principal (API key, OAuth token, session). 0 disables the general limiter. */
  API_RATE_LIMIT_PER_MINUTE: z.preprocess(blankToUndefined, z.coerce.number().int().min(0).default(600)),
  /** Spike cap for the general API quota: max requests per principal in any 1-second burst. 0 disables burst smoothing (the per-minute window still applies). */
  API_RATE_LIMIT_BURST: z.preprocess(blankToUndefined, z.coerce.number().int().min(0).default(100)),
  /** Email delivery. `none` (default) never blocks a flow: links stay copyable. */
  EMAIL_DRIVER: z.preprocess(blankToUndefined, z.enum(['none', 'smtp', 'resend']).default('none')),
  /** smtp(s)://user:pass@host:port — required when EMAIL_DRIVER=smtp. */
  SMTP_URL: optionalString(z.string().min(1)),
  /** Required when EMAIL_DRIVER=resend. */
  RESEND_API_KEY: optionalString(z.string().min(1)),
  /** Sender, e.g. "Platform <noreply@example.com>". Required when a driver delivers. */
  EMAIL_FROM: optionalString(z.string().min(3)),
  /** When set, rate limits (and later caches) are shared across replicas. */
  REDIS_URL: optionalString(z.string().min(1)),
  /** File storage: local (default; DATA_DIR volume, single replica) or s3 (MinIO/AWS/R2). */
  STORAGE_DRIVER: z.preprocess(blankToUndefined, z.enum(['local', 's3']).default('local')),
  S3_BUCKET: optionalString(z.string().min(1)),
  S3_REGION: optionalString(z.string().min(1)),
  /** Endpoint override for MinIO/R2; leave unset for AWS. */
  S3_ENDPOINT: z.preprocess(blankToUndefined, z.url().optional()),
  S3_ACCESS_KEY_ID: optionalString(z.string().min(1)),
  S3_SECRET_ACCESS_KEY: optionalString(z.string().min(1)),
  /** Path-style addressing — required by MinIO and most S3-compatibles. */
  S3_FORCE_PATH_STYLE: booleanish.default(true),
  /**
   * Trust x-forwarded-for for client IPs (rate limits, audit). The app reads
   * the RIGHTMOST hop — the one your proxy appended or set (Caddy ≥2.5
   * discards client-supplied X-Forwarded-* by default). Enable ONLY behind a
   * reverse proxy you control; when false the socket address is used and
   * spoofed headers are ignored.
   */
  TRUST_PROXY: booleanish.default(false),
  /** OTLP/HTTP endpoint for trace export. Unset (default) = no export, zero phone-home. */
  OTEL_EXPORTER_OTLP_ENDPOINT: z.preprocess(blankToUndefined, z.url().optional()),
  /** GET /metrics requires `Authorization: Bearer <token>`; unset = /metrics disabled (401). */
  METRICS_TOKEN: optionalString(z.string().min(8)),
  /** Days of audit_log to keep (nightly purge at 03:00). 0 = keep forever. */
  AUDIT_RETENTION_DAYS: z.coerce.number().int().min(0).default(365),
  /** Grace period for orphaned users (accounts with ZERO workspace memberships, e.g. setup-race losers): the nightly 03:00 sweep deletes them once older than this many hours. A user with ANY membership row — even deactivated — is never touched. 0 = sweep disabled. */
  ORPHAN_USER_RETENTION_HOURS: z.preprocess(blankToUndefined, z.coerce.number().int().min(0).default(72)),
  /** pino level. */
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production')
});

export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (result.success) return result.data;

  const rows: Array<[string, string]> = [];
  for (const issue of result.error.issues) {
    const key = issue.path.join('.') || '(root)';
    rows.push([key, issue.message]);
  }
  const width = Math.max(...rows.map(([k]) => k.length), 'VARIABLE'.length);
  const lines = [
    '',
    'Invalid environment configuration:',
    '',
    `  ${'VARIABLE'.padEnd(width)}  PROBLEM`,
    `  ${'-'.repeat(width)}  ${'-'.repeat(40)}`,
    ...rows.map(([k, msg]) => `  ${k.padEnd(width)}  ${msg}`),
    '',
    'See docs/env-reference.md (or .env.example) for every variable.',
    ''
  ];
  console.error(lines.join('\n'));
  process.exit(1);
}
