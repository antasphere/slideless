import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  createDatabase,
  createTestApp,
  extractCookie,
  readJson,
  startPostgres,
  type TestApp
} from './helpers.js';

/**
 * Orphaned-user GC (ADR 010): the nightly sweep deletes Better Auth users
 * with ZERO workspace_members rows once they are older than
 * ORPHAN_USER_RETENTION_HOURS. The safety invariant under test: a user with
 * ANY membership row — even a DEACTIVATED one — is never touched; neither is
 * a fresh orphan inside the grace window, nor an orphan with a live pending
 * invitation (mid-onboarding). Deletion cascades sessions/accounts (Better
 * Auth internalAdapter) and lands a system-actor `user.orphan_purge` audit
 * row. 0 disables the sweep entirely.
 */

const OWNER = { email: 'owner@gc.test', name: 'GC Owner', password: 'gc-owner-password-123' };
const MEMBER = { email: 'member@gc.test', name: 'GC Member', password: 'gc-member-password-12' };

let container: StartedPostgreSqlContainer;

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body)
});

/** Insert a raw user row (+ a session and credential account to prove the cascade). */
async function seedUser(app: TestApp, id: string, email: string, ageHours: number): Promise<void> {
  await app.db.pool.query(
    `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
     VALUES ($1, $2, $3, false, now() - make_interval(hours => $4), now())`,
    [id, email, email, ageHours]
  );
  await app.db.pool.query(
    `INSERT INTO session (id, expires_at, token, created_at, updated_at, user_id)
     VALUES ($1, now() + interval '7 days', $2, now(), now(), $3)`,
    [`sess-${id}`, `token-${id}`, id]
  );
  await app.db.pool.query(
    `INSERT INTO account (id, account_id, provider_id, user_id, password, created_at, updated_at)
     VALUES ($1, $2, 'credential', $3, 'hash', now(), now())`,
    [`acc-${id}`, id, id]
  );
}

async function userExists(app: TestApp, id: string): Promise<boolean> {
  const res = await app.db.pool.query(`SELECT 1 FROM "user" WHERE id = $1`, [id]);
  return res.rows.length > 0;
}

/** Send the purge job and wait for pg-boss to complete it (deterministic). */
async function runPurge(app: TestApp): Promise<void> {
  const jobId = await app.jobs.boss.send('orphan-user-purge', {});
  expect(jobId).toBeTruthy();
  const deadline = Date.now() + 20_000;
  for (;;) {
    const job = await app.jobs.boss.getJobById('orphan-user-purge', jobId!);
    if (job && (job.state === 'completed' || job.state === 'failed')) {
      expect(job.state).toBe('completed');
      return;
    }
    if (Date.now() > deadline) throw new Error('orphan purge job did not complete in time');
    await new Promise((r) => setTimeout(r, 250));
  }
}

beforeAll(async () => {
  container = await startPostgres();
});

afterAll(async () => {
  await container?.stop();
});

describe('orphan purge (default 72h grace)', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp(await createDatabase(container, 'gc_on'));
    await app.app.request('/api/v1/setup', json({ instanceName: 'GC', owner: OWNER }));
    const ownerCookie = extractCookie(
      await app.app.request(
        '/api/v1/auth/sign-in/email',
        json({ email: OWNER.email, password: OWNER.password })
      )
    );

    // A real member — then DEACTIVATED and BACKDATED past the grace window:
    // the strongest "never touch a member" case (inactive + old).
    const inv = await readJson(
      await app.app.request(
        '/api/v1/invitations',
        json({ email: MEMBER.email, role: 'member' }, { cookie: ownerCookie })
      )
    );
    const token = (inv.acceptUrl as string).split('/invite/')[1]!;
    await app.app.request(
      '/api/v1/invitations/accept',
      json({ token, name: MEMBER.name, password: MEMBER.password })
    );
    const { members } = await readJson(
      await app.app.request('/api/v1/members', { headers: { cookie: ownerCookie } })
    );
    const member = members.find((m: { email: string }) => m.email === MEMBER.email);
    await app.app.request(`/api/v1/members/${member.id}`, {
      ...json({ isActive: false }, { cookie: ownerCookie }),
      method: 'PATCH'
    });
    await app.db.pool.query(`UPDATE "user" SET created_at = now() - interval '200 hours' WHERE email = $1`, [
      MEMBER.email
    ]);

    // The GC population:
    await seedUser(app, 'orphan-old', 'orphan-old@gc.test', 100); // past grace → deleted
    await seedUser(app, 'orphan-fresh', 'orphan-fresh@gc.test', 1); // inside grace → kept
    await seedUser(app, 'orphan-invited', 'orphan-invited@gc.test', 100); // past grace but re-invited → kept
    await app.app.request(
      '/api/v1/invitations',
      json({ email: 'orphan-invited@gc.test', role: 'member' }, { cookie: ownerCookie })
    );
  }, 60_000);

  afterAll(async () => {
    await app.stop();
  });

  it('deletes only the old zero-membership orphan and cascades sessions/accounts', async () => {
    await runPurge(app);

    // The old orphan is gone, cascade included.
    expect(await userExists(app, 'orphan-old')).toBe(false);
    const sess = await app.db.pool.query(`SELECT 1 FROM session WHERE user_id = 'orphan-old'`);
    expect(sess.rows).toHaveLength(0);
    const acc = await app.db.pool.query(`SELECT 1 FROM account WHERE user_id = 'orphan-old'`);
    expect(acc.rows).toHaveLength(0);

    // The fresh orphan survives the grace window.
    expect(await userExists(app, 'orphan-fresh')).toBe(true);

    // The re-invited orphan survives (live pending invitation = mid-onboarding).
    expect(await userExists(app, 'orphan-invited')).toBe(true);

    // THE invariant: a user with ANY membership row — even deactivated and
    // far older than the grace period — is never a purge candidate.
    const member = await app.db.pool.query(`SELECT 1 FROM "user" WHERE email = $1`, [MEMBER.email]);
    expect(member.rows).toHaveLength(1);
    const owner = await app.db.pool.query(`SELECT 1 FROM "user" WHERE email = $1`, [OWNER.email]);
    expect(owner.rows).toHaveLength(1);

    // Audited as a system actor with the count — INSTANCE-attributed
    // (workspace_id NULL, ADR 012): orphans belong to no workspace.
    const audit = await app.db.pool.query(
      `SELECT actor_via, actor_user_id, workspace_id, metadata FROM audit_log WHERE action = 'user.orphan_purge' ORDER BY id DESC LIMIT 1`
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].actor_via).toBe('system');
    expect(audit.rows[0].actor_user_id).toBeNull();
    expect(audit.rows[0].workspace_id).toBeNull();
    expect(audit.rows[0].metadata.deleted).toBe(1);
    expect(audit.rows[0].metadata.sample).toContain('orphan-old@gc.test');
  }, 40_000);

  it('is idempotent: a second run finds nothing and writes no extra audit row', async () => {
    const before = await app.db.pool.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE action = 'user.orphan_purge'`
    );
    await runPurge(app);
    expect(await userExists(app, 'orphan-fresh')).toBe(true);
    const after = await app.db.pool.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE action = 'user.orphan_purge'`
    );
    // No deletions → no audit row (the run itself only logs).
    expect(after.rows[0].n).toBe(before.rows[0].n);
  }, 40_000);
});

describe('ORPHAN_USER_RETENTION_HOURS=0 disables the sweep', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp(await createDatabase(container, 'gc_off'), {
      ORPHAN_USER_RETENTION_HOURS: '0'
    });
    await app.app.request('/api/v1/setup', json({ instanceName: 'GCOff', owner: OWNER }));
    await seedUser(app, 'orphan-ancient', 'orphan-ancient@gc.test', 1000);
  }, 60_000);

  afterAll(async () => {
    await app.stop();
  });

  it('leaves even ancient orphans untouched', async () => {
    await runPurge(app); // the handler early-returns; the job still completes
    expect(await userExists(app, 'orphan-ancient')).toBe(true);
  }, 40_000);
});
