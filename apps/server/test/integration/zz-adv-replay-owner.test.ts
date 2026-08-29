import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createDatabase,
  createTestApp,
  readJson,
  startPostgres,
  SETUP_TOKEN,
  type TestApp
} from './helpers.js';

const OWNER = { email: 'alice@adv.test', name: 'Alice', password: 'alice-password-12345' };
const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body)
});

let container: StartedPostgreSqlContainer;
beforeAll(async () => {
  container = await startPostgres();
}, 180_000);
afterAll(async () => {
  await container?.stop();
});

describe('ADV: tombstone replay when the erased subject is a sole active owner in the restored dump', () => {
  it('re-erases the user (ticket acceptance: a restored dump containing an erased subject leaves them erased)', async () => {
    const url = await createDatabase(container, 'adv_replay_owner');
    let app: TestApp = await createTestApp(url);
    const dataDir = app.env.DATA_DIR;
    const setup = await app.app.request(
      '/api/v1/setup',
      json({ setupToken: SETUP_TOKEN, instanceName: 'Adv', owner: OWNER })
    );
    expect(setup.status).toBe(201);
    const { ownerUserId } = await readJson(setup);

    // The live timeline: Alice promoted Bob, Bob erased Alice (admin DELETE /members) → tombstone.
    // The OLDER dump being restored: Alice is still the sole active owner. We model that by
    // writing the tombstone the live timeline produced, against the dump's state.
    appendFileSync(
      join(dataDir, 'erasures.jsonl'),
      JSON.stringify({ userId: ownerUserId, emailHash: 'x', at: new Date().toISOString() }) + '\n'
    );
    await app.stop();

    app = await createTestApp(url, { DATA_DIR: dataDir });
    try {
      const ready = await app.app.request('/readyz');
      const users = await app.db.pool.query(`SELECT id FROM "user" WHERE id = $1`, [ownerUserId]);
      const signIn = await app.app.request(
        '/api/v1/auth/sign-in/email',
        json({ email: OWNER.email, password: OWNER.password })
      );
      const audit = await app.db.pool.query(`SELECT 1 FROM audit_log WHERE action = 'user.erasure_replayed'`);
      const acc = await app.db.pool.query(`SELECT count(*)::int AS n FROM account WHERE user_id = $1`, [
        ownerUserId
      ]);
      const mem = await app.db.pool.query(
        `SELECT count(*)::int AS n FROM workspace_members WHERE user_id = $1`,
        [ownerUserId]
      );
      const u = await app.db.pool.query(`SELECT email, name FROM "user" WHERE id = $1`, [ownerUserId]);
      console.log('ADV accounts=%d memberships=%d user=%j', acc.rows[0].n, mem.rows[0].n, u.rows[0]);
      // eslint-disable-next-line no-console
      console.log(
        'ADV readyz=%d userRows=%d signIn=%d replayAudit=%d',
        ready.status,
        users.rows.length,
        signIn.status,
        audit.rows.length
      );
      expect(users.rows).toHaveLength(0);
      expect(signIn.status).not.toBe(200);
    } finally {
      await app.stop();
    }
  }, 120_000);
});
