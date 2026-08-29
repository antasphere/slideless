import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { boot, type BootOverrides, type BootResult } from '../../src/boot.js';
import type { EmailDriver, EmailMessage } from '../../src/email/driver.js';

/**
 * Delivering driver that records instead of sending. Exists because
 * change-email tokens are stateless JWTs (never stored in the verification
 * table) — the only way a test can obtain the link is to capture the
 * outbound mail. Passed via the `email` boot override.
 */
export class RecordingEmailDriver implements EmailDriver {
  readonly name = 'smtp' as const; // narrowest honest label the union allows
  readonly delivers = true;
  readonly sent: EmailMessage[] = [];
  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }
}

/**
 * The first-boot claim credential every test app boots with (PRDCT-1347:
 * POST /setup ALWAYS requires a token now). Suites that exercise the
 * generated-token path override it with an empty SETUP_TOKEN.
 */
export const SETUP_TOKEN = 'integration-test-setup-token';

/** Matches the compose stack: Postgres 17 with pgvector available. */
export const PG_IMAGE = 'pgvector/pgvector:pg17';

export async function startPostgres(): Promise<StartedPostgreSqlContainer> {
  return new PostgreSqlContainer(PG_IMAGE).start();
}

export interface TestApp extends BootResult {
  stop: () => Promise<void>;
}

/** Boot the real app (real migrations, real Better Auth) against a database. */
export async function createTestApp(
  connectionString: string,
  extraEnv: Record<string, string> = {},
  overrides: BootOverrides = {}
): Promise<TestApp> {
  const dataDir = await mkdtemp(join(tmpdir(), 'slideless-test-'));
  const result = await boot(
    {
      DATABASE_URL: connectionString,
      DATA_DIR: dataDir,
      AUTH_SECRET: 'integration-test-secret-0123456789abcdef0123456789abcdef',
      SETUP_TOKEN,
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      PUBLIC_BASE_URL: 'http://localhost:3000',
      // app.request() has no socket; trusting XFF lets tests exercise the
      // per-IP bucket behavior deliberately.
      TRUST_PROXY: 'true',
      // Generous general-API quota so unrelated suites never trip it while
      // still exercising the consume path; the api-quota suite overrides
      // these with tight values via extraEnv.
      API_RATE_LIMIT_PER_MINUTE: '100000',
      API_RATE_LIMIT_BURST: '10000',
      ...extraEnv
    },
    overrides
  );
  return {
    ...result,
    stop: async () => {
      await result.jobs.stop().catch(() => {});
      await result.db.pool.end();
    }
  };
}

/** Create an extra empty database inside the shared container. */
export async function createDatabase(container: StartedPostgreSqlContainer, name: string): Promise<string> {
  const client = new pg.Client({ connectionString: container.getConnectionUri() });
  await client.connect();
  await client.query(`CREATE DATABASE ${name}`);
  await client.end();
  const base = new URL(container.getConnectionUri());
  base.pathname = `/${name}`;
  return base.toString();
}

/** Deliberate state isolation: wipe all rows, keep the schema. */
export async function truncateAll(connectionString: string): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const res = await client.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`
    );
    const tables = res.rows.map((r) => `"${r.tablename}"`).join(', ');
    if (tables.length > 0) {
      await client.query(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
    }
  } finally {
    await client.end();
  }
}

/** Read a JSON body without fighting Response's `unknown` under strict TS. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readJson(res: Response): Promise<any> {
  return res.json();
}

export function extractCookie(res: Response): string {
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) throw new Error('no set-cookie header in response');
  return setCookie
    .split(',')
    .map((part) => part.split(';')[0]?.trim())
    .filter(Boolean)
    .join('; ');
}
