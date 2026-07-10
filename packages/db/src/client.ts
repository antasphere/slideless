import pg from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;

/**
 * A database handle OR an open transaction — for code that must run either
 * standalone or inside a caller's transaction (e.g. the presentation blob
 * in-use guard inside the file-delete transaction).
 */
export type DbConn = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

export interface DbHandle {
  db: Db;
  pool: pg.Pool;
}

export function createDb(connectionString: string): DbHandle {
  // Conservative pool defaults for a single-container instance. A runaway
  // query cannot hold a connection (or a transaction) forever, and the pool
  // cannot starve Postgres' default max_connections when replicas multiply.
  // Note for PgBouncer transaction mode: statement_timeout is a session-level
  // setting — set it server-side instead (documented in deployment-profiles).
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 30_000,
    idle_in_transaction_session_timeout: 30_000
  });
  const db = drizzle(pool, { schema });
  return { db, pool };
}
