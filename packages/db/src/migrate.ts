import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { readdir } from 'node:fs/promises';

/**
 * Advisory-lock key for boot migrations. Constant and app-specific: every
 * replica of this app contends on the same key, so exactly one runs DDL while
 * the others wait, then find nothing left to apply.
 */
const MIGRATION_LOCK_KEY = 7_432_001n;

export interface MigrateOptions {
  connectionString: string;
  migrationsFolder: string;
  log?: (msg: string) => void;
}

export interface MigrationStatus {
  applied: number;
  onDisk: number;
  pending: boolean;
}

/**
 * Run all pending migrations exactly once across concurrent replicas.
 *
 * Uses a session-scoped pg_advisory_lock on a dedicated client (never a
 * pool): drizzle's migrator runs its own transactions, so a transaction-scoped
 * lock would release after the first internal commit and stop protecting the
 * rest of the run. Holding one session for lock + DDL guarantees every
 * statement runs under the lock.
 */
export async function runMigrations({
  connectionString,
  migrationsFolder,
  log
}: MigrateOptions): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    log?.('acquiring migration advisory lock');
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY.toString()]);
    log?.('advisory lock acquired, applying pending migrations');
    await migrate(drizzle(client), { migrationsFolder });
    log?.('migrations up to date');
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY.toString()]);
    } finally {
      await client.end();
    }
  }
}

/**
 * Compare applied migrations against the folder without running anything.
 * Used when AUTO_MIGRATE=false: the app refuses readiness while pending.
 */
export async function migrationStatus({
  connectionString,
  migrationsFolder
}: Omit<MigrateOptions, 'log'>): Promise<MigrationStatus> {
  const onDisk = (await readdir(migrationsFolder)).filter((f) => f.endsWith('.sql')).length;
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const res = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM information_schema.tables t
        WHERE t.table_schema = 'drizzle' AND t.table_name = '__drizzle_migrations'`
    );
    if (res.rows[0]?.count === '0') {
      return { applied: 0, onDisk, pending: onDisk > 0 };
    }
    const applied = await client.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations'
    );
    const appliedCount = Number(applied.rows[0]?.count ?? '0');
    return { applied: appliedCount, onDisk, pending: appliedCount < onDisk };
  } finally {
    await client.end();
  }
}
