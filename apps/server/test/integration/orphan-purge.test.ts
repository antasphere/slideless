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
 * Orphaned-user GC (ADR 010 + user-scoped federation): the nightly sweep
 * deletes Better Auth users with ZERO workspace_members rows AND no live
 * (unexpired) session once they are older than ORPHAN_USER_RETENTION_HOURS.
 * The LIVE SESSION is the collect/protect discriminator — a hub account
 * link deliberately is NOT (a fail-closed SSO login strands a linked,
 * grant-bearing user whose session was revoked; protecting on the link
 * would accumulate dormant refresh families without bound). Safety
 * invariants under test: a user with ANY membership row — even DEACTIVATED
 * — is never touched; neither is a fresh orphan inside the grace window, an
 * orphan with a live pending invitation (mid-onboarding), a zero-membership
 * user with a LIVE session (the legit /me zero state), nor a
 * superadmin-allowlisted address (the break-glass operator). Deletion is
 * always the WHOLE user (internalAdapter cascade: sessions + accounts +
 * memberships together — the no_link hard constraint) and lands a
 * system-actor `user.orphan_purge` audit row. 0 disables the sweep.
 */

const OWNER = { email: 'owner@gc.test', name: 'GC Owner', password: 'gc-owner-password-123' };
const MEMBER = { email: 'member@gc.test', name: 'GC Member', password: 'gc-member-password-12' };
const SUPERADMIN_EMAIL = 'breakglass@gc.test';

let container: StartedPostgreSqlContainer;

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body)
});

/**
 * Insert a raw user row (+ a session and credential account to prove the
 * cascade). `sessionLive: false` seeds an EXPIRED session — the strand
 * shape (a fail-closed login revokes; here expiry stands in for revocation
 * while still proving the delete cascades session rows).
 */
async function seedUser(
  app: TestApp,
  id: string,
  email: string,
  ageHours: number,
  opts: { sessionLive?: boolean; hubLinked?: boolean } = {}
): Promise<void> {
  await app.db.pool.query(
    `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
     VALUES ($1, $2, $3, false, now() - make_interval(hours => $4), now())`,
    [id, email, email, ageHours]
  );
  await app.db.pool.query(
    `INSERT INTO session (id, expires_at, token, created_at, updated_at, user_id)
     VALUES ($1, now() + $2::interval, $3, now(), now(), $4)`,
    [`sess-${id}`, opts.sessionLive ? '7 days' : '-1 hour', `token-${id}`, id]
  );
  if (opts.hubLinked) {
    // The fail-closed-login strand: an `antasphere` link HOLDING a stored
    // offline grant (Better Auth writes tokens before the after-hook).
    await app.db.pool.query(
      `INSERT INTO account (id, account_id, provider_id, user_id, refresh_token, created_at, updated_at)
       VALUES ($1, $2, 'antasphere', $3, 'stranded-grant-ciphertext', now(), now())`,
      [`acc-${id}`, `hub-${id}`, id]
    );
  } else {
    await app.db.pool.query(
      `INSERT INTO account (id, account_id, provider_id, user_id, password, created_at, updated_at)
       VALUES ($1, $2, 'credential', $3, 'hash', now(), now())`,
      [`acc-${id}`, id, id]
    );
  }
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
    app = await createTestApp(await createDatabase(container, 'gc_on'), {
      SUPERADMIN_EMAILS: SUPERADMIN_EMAIL
    });
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
    await seedUser(app, 'orphan-old', 'orphan-old@gc.test', 100); // past grace, dead session → deleted
    await seedUser(app, 'orphan-fresh', 'orphan-fresh@gc.test', 1); // inside grace → kept
    await seedUser(app, 'orphan-invited', 'orphan-invited@gc.test', 100); // past grace but re-invited → kept
    await app.app.request(
      '/api/v1/invitations',
      json({ email: 'orphan-invited@gc.test', role: 'member' }, { cookie: ownerCookie })
    );
    // The fail-closed-login STRAND: hub-linked, grant-bearing, session
    // revoked (expired here) — the link must NOT protect it.
    await seedUser(app, 'orphan-strand', 'orphan-strand@gc.test', 100, { hubLinked: true });
    // The LEGIT zero-org user (the /me zero state): hub-linked too, but
    // holding a LIVE session — the session is the protection.
    await seedUser(app, 'zero-org-live', 'zero-org-live@gc.test', 100, {
      hubLinked: true,
      sessionLive: true
    });
    // Same protection for an UNLINKED zero-membership user with a live
    // session (the discriminator is the session, never the link).
    await seedUser(app, 'zero-org-live-local', 'zero-org-live-local@gc.test', 100, { sessionLive: true });
    // The break-glass operator: allowlisted email, no membership, session
    // long gone — must survive so recovery stays possible (ADR 010).
    await seedUser(app, 'superadmin-dormant', SUPERADMIN_EMAIL, 100);
  }, 60_000);

  afterAll(async () => {
    await app.stop();
  });

  it('deletes only the no-session zero-membership orphans and cascades sessions/accounts', async () => {
    await runPurge(app);

    // The old orphan is gone, cascade included.
    expect(await userExists(app, 'orphan-old')).toBe(false);
    const sess = await app.db.pool.query(`SELECT 1 FROM session WHERE user_id = 'orphan-old'`);
    expect(sess.rows).toHaveLength(0);
    const acc = await app.db.pool.query(`SELECT 1 FROM account WHERE user_id = 'orphan-old'`);
    expect(acc.rows).toHaveLength(0);

    // The fail-closed-login STRAND is collected — the hub link does NOT
    // protect it, and its stored grant ciphertext dies with the account row
    // (the whole point: no unbounded dormant-refresh-family accumulation).
    expect(await userExists(app, 'orphan-strand')).toBe(false);
    const strandAcc = await app.db.pool.query(`SELECT 1 FROM account WHERE user_id = 'orphan-strand'`);
    expect(strandAcc.rows).toHaveLength(0);

    // The LEGIT zero-org users survive: the LIVE SESSION is the
    // discriminator, for linked and unlinked users alike.
    expect(await userExists(app, 'zero-org-live')).toBe(true);
    expect(await userExists(app, 'zero-org-live-local')).toBe(true);

    // The dormant break-glass operator survives on the allowlist alone.
    expect(await userExists(app, 'superadmin-dormant')).toBe(true);

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

    // ── The no_link HARD CONSTRAINT (user-scoped federation) ────────────
    // The purge must never leave an `origin='hub'` membership row whose
    // user lost their `antasphere` account row — that state would make the
    // reconciler's fail-open no_link branch reachable for a hub-origin
    // principal. The whole-user cascade makes it impossible; pin it.
    const dangling = await app.db.pool.query(
      `SELECT wm.id FROM workspace_members wm
       WHERE wm.origin = 'hub'
         AND NOT EXISTS (
           SELECT 1 FROM account a WHERE a.user_id = wm.user_id AND a.provider_id = 'antasphere'
         )`
    );
    expect(dangling.rows).toHaveLength(0);

    // Audited as a system actor with the count — INSTANCE-attributed
    // (workspace_id NULL, ADR 014): orphans belong to no workspace.
    const audit = await app.db.pool.query(
      `SELECT actor_via, actor_user_id, workspace_id, metadata FROM audit_log WHERE action = 'user.orphan_purge' ORDER BY id DESC LIMIT 1`
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].actor_via).toBe('system');
    expect(audit.rows[0].actor_user_id).toBeNull();
    expect(audit.rows[0].workspace_id).toBeNull();
    expect(audit.rows[0].metadata.deleted).toBe(2);
    expect(audit.rows[0].metadata.sample).toContain('orphan-old@gc.test');
    expect(audit.rows[0].metadata.sample).toContain('orphan-strand@gc.test');
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
