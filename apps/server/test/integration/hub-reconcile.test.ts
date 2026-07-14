import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDatabase, createTestApp, readJson, startPostgres, type TestApp } from './helpers.js';
import { FakeHub, type HubUserFixture } from '../fake-hub.js';
import * as sso from './sso-helpers.js';

/**
 * H4 read-through org reconciliation (ADR 018, docs/federation.md "Live org
 * reconciliation"): org and membership truth live ONLY at the hub, and a
 * page reload (`/me`) or an SSO login makes the local projections match —
 * project missing orgs, sync names/roles, deactivate what the hub no
 * longer asserts. The mirror-image posture of the P4 gates is pinned here
 * too: reconciliation is FRESHNESS, so every hub error fails OPEN (local
 * state served, nothing deactivated), while only a definitive 200 list
 * ever mutates state.
 *
 * Dials are shrunk so reload-time propagation is observable in
 * milliseconds; memberTtlMs is pinned HIGH so the H2 re-assertion
 * (hub-entitlements.test.ts owns those pins) never interleaves its own
 * deactivations with the reconciler's.
 */

const OWNER = { email: 'owner@reconcile.test', name: 'Op Owner', password: 'op-owner-password-123' };

const ORG_ONE = '33333333-aaaa-4bbb-8ccc-000000000001';
const ORG_TWO = '33333333-aaaa-4bbb-8ccc-000000000002';
const ORG_THREE = '33333333-aaaa-4bbb-8ccc-000000000003';
const ORG_SOLO = '33333333-aaaa-4bbb-8ccc-000000000004';
const ORG_TINA = '33333333-aaaa-4bbb-8ccc-000000000005';
const ORG_FRESH = '33333333-aaaa-4bbb-8ccc-000000000006';
const ORG_CLI = '33333333-aaaa-4bbb-8ccc-000000000007';
const ORG_CLI_2 = '33333333-aaaa-4bbb-8ccc-000000000008';
const ORG_WEIRD = '33333333-aaaa-4bbb-8ccc-000000000009';

const DIALS = {
  orgTtlMs: 150,
  orgStaleMaxMs: 60_000,
  retryMs: 250,
  memberTtlMs: 600_000, // H2 out of the picture — this suite pins H4 only
  timeoutMs: 2_000,
  userOrgsTtlMs: 120,
  userOrgsTimeoutMs: 400
};

const RESOURCE = 'http://localhost:3000/mcp';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Let the per-user reconcile cache expire so the next /me runs a fresh pass. */
const expireTtl = () => sleep(DIALS.userOrgsTtlMs + 40);

let container: StartedPostgreSqlContainer;
let hub: FakeHub;
let app: TestApp;

beforeAll(async () => {
  [container, hub] = await Promise.all([startPostgres(), FakeHub.start()]);
  app = await createTestApp(
    await createDatabase(container, 'hub_reconcile'),
    {
      EDITION: 'cloud',
      HUB_ISSUER_URL: hub.issuer,
      HUB_CLIENT_ID: 'tool-slideless-cloud',
      HUB_CLIENT_SECRET: 'integration-test-hub-secret-0001',
      HUB_SERVICE_KEY: 'ant_integration_test_key',
      METRICS_TOKEN: 'reconcile-metrics-token'
    },
    { hubDials: DIALS }
  );
  const res = await app.app.request('/api/v1/setup', sso.json({ instanceName: 'Reconcile', owner: OWNER }));
  expect(res.status).toBe(201);
}, 240_000);

afterAll(async () => {
  await app?.stop();
  await Promise.all([container?.stop(), hub?.stop()]);
});

const me = async (cookie: string, workspaceId?: string) =>
  app.app.request('/api/v1/me', {
    headers: { cookie, ...(workspaceId ? { 'x-workspace-id': workspaceId } : {}) }
  });

const h4Fetches = () => hub.statusRequests.filter((r) => r.path.endsWith('/memberships')).length;

async function workspaceIdOf(centralAccountId: string): Promise<string> {
  const { rows } = await app.db.pool.query(`SELECT id FROM workspaces WHERE central_account_id = $1`, [
    centralAccountId
  ]);
  expect(rows).toHaveLength(1);
  return rows[0].id as string;
}

async function membershipRow(centralAccountId: string, email: string) {
  const { rows } = await app.db.pool.query(
    `SELECT m.role, m.origin, m.is_active FROM workspace_members m
      JOIN workspaces w ON w.id = m.workspace_id
      JOIN "user" u ON u.id = m.user_id
     WHERE w.central_account_id = $1 AND u.email = $2`,
    [centralAccountId, email]
  );
  return rows;
}

describe('login-time reconciliation (assertLogin step 4)', () => {
  const rick: HubUserFixture = {
    sub: 'hub-rick',
    email: 'rick@reconcile.test',
    name: 'Rick Reconciled',
    workspaceId: ORG_ONE,
    role: 'owner',
    workspaceName: 'Rick Org'
  };
  let rickCookie: string;

  it('ONE login materializes ALL of the user’s hub orgs, not just the asserted one', async () => {
    // The hub knows rick in a SECOND org before he ever logs in here.
    hub.setUserOrg('hub-rick', ORG_TWO, { name: 'Second Org', role: 'member' });
    rickCookie = await sso.ssoLogin(app, hub, rick);

    const body = await readJson(await me(rickCookie));
    const byName = Object.fromEntries(
      body.workspaces.map((w: { name: string; role: string; hubOrigin: boolean }) => [w.name, w])
    );
    expect(byName['Rick Org']).toMatchObject({ role: 'owner', hubOrigin: true });
    expect(byName['Second Org']).toMatchObject({ role: 'member', hubOrigin: true });
    // The asserted org is the active one; the sibling was projected too.
    expect(body.workspace.name).toBe('Rick Org');
    expect(await membershipRow(ORG_TWO, rick.email)).toEqual([
      { role: 'member', origin: 'hub', is_active: true }
    ]);
  });

  it('a list outage can neither fail a login nor undo the row the login just wrote', async () => {
    const sam: HubUserFixture = {
      sub: 'hub-sam',
      email: 'sam@reconcile.test',
      workspaceId: ORG_SOLO,
      role: 'owner',
      workspaceName: 'Solo Org'
    };
    hub.statusMode = 'network';
    try {
      const cookie = await sso.ssoLogin(app, hub, sam); // 302 — the login itself succeeded
      expect(cookie).toBeTruthy();
    } finally {
      hub.statusMode = 'ok';
    }
    // The fail-closed step-3 projection is intact — nothing swept it.
    expect(await membershipRow(ORG_SOLO, sam.email)).toEqual([
      { role: 'owner', origin: 'hub', is_active: true }
    ]);
  });

  it('a fresh hub org appears IMMEDIATELY after a re-login (force pass bypasses the TTL)', async () => {
    await me(rickCookie); // warm the cache …
    hub.setUserOrg('hub-rick', ORG_FRESH, { name: 'Fresh Org', role: 'admin' });
    await sso.ssoLogin(app, hub, rick); // … the login must NOT wait for its expiry
    const body = await readJson(await me(rickCookie));
    expect(body.workspaces.map((w: { name: string }) => w.name)).toContain('Fresh Org');
    hub.removeUserOrg('hub-rick', ORG_FRESH); // keep the later pins focused
  });

  describe('reload-time reconciliation (/me read-through)', () => {
    it('an org created at the hub appears at the next reload', async () => {
      hub.setUserOrg('hub-rick', ORG_THREE, { name: 'Third Org', role: 'member' });
      await expireTtl();
      const body = await readJson(await me(rickCookie));
      expect(body.workspaces.map((w: { name: string }) => w.name)).toContain('Third Org');
      expect(await membershipRow(ORG_THREE, rick.email)).toEqual([
        { role: 'member', origin: 'hub', is_active: true }
      ]);
    });

    it('rename and role change at the hub propagate at the next reload', async () => {
      hub.setUserOrg('hub-rick', ORG_THREE, { name: 'Third Org GmbH', role: 'admin' });
      await expireTtl();
      const body = await readJson(await me(rickCookie));
      const third = body.workspaces.find((w: { name: string }) => w.name === 'Third Org GmbH');
      expect(third).toMatchObject({ role: 'admin', hubOrigin: true });
      expect(await membershipRow(ORG_THREE, rick.email)).toEqual([
        { role: 'admin', origin: 'hub', is_active: true }
      ]);
    });

    it('a hub-side removal deactivates the projection with exactly ONE audit row; the workspace 401s', async () => {
      // One mutation keeps H2 and H4 coherent: the explicit {active:false}
      // override drops the entry from the H4 list at read time.
      hub.members.set(`${ORG_THREE}:hub-rick`, { active: false });
      await expireTtl();
      const body = await readJson(await me(rickCookie));
      expect(body.workspaces.map((w: { name: string }) => w.name)).not.toContain('Third Org GmbH');
      expect(await membershipRow(ORG_THREE, rick.email)).toEqual([
        { role: 'admin', origin: 'hub', is_active: false }
      ]);

      // Naming the swept workspace now fails closed (no membership resolves).
      const wsThree = await workspaceIdOf(ORG_THREE);
      expect((await me(rickCookie, wsThree)).status).toBe(401);

      // Exactly ONE audit row per flip — system actor, hub_reconcile reason
      // (namespaced apart from the H2 gate's hub_reassertion).
      await expireTtl();
      await me(rickCookie); // an extra pass must NOT audit again (row already inactive)
      const { rows: audit } = await app.db.pool.query(
        `SELECT a.actor_via FROM audit_log a JOIN workspaces w ON w.id = a.workspace_id
         WHERE w.central_account_id = $1 AND a.action = 'member.deactivate'
           AND a.metadata->>'reason' = 'hub_reconcile'`,
        [ORG_THREE]
      );
      expect(audit).toEqual([{ actor_via: 'system' }]);
    });

    it('a suspended org stays VISIBLE (listed, row active) but its requests are blocked by the org gate', async () => {
      hub.orgStatuses.set(ORG_TWO, 'suspended');
      await expireTtl();
      const body = await readJson(await me(rickCookie));
      expect(body.workspaces.map((w: { name: string }) => w.name)).toContain('Second Org');
      expect(await membershipRow(ORG_TWO, rick.email)).toEqual([
        { role: 'member', origin: 'hub', is_active: true }
      ]);
      const wsTwo = await workspaceIdOf(ORG_TWO);
      const blocked = await me(rickCookie, wsTwo);
      expect(blocked.status).toBe(403);
      expect((await readJson(blocked)).error.code).toBe('account_suspended');
      hub.orgStatuses.set(ORG_TWO, 'active');
    });

    it('an unknown-role entry keeps the membership ALIVE but is never projected/synced', async () => {
      // A brand-new org with an unknown role: never projected.
      hub.setUserOrg('hub-rick', ORG_WEIRD, { name: 'Weird Org', role: 'emperor' });
      await expireTtl();
      const body = await readJson(await me(rickCookie));
      expect(body.workspaces.map((w: { name: string }) => w.name)).not.toContain('Weird Org');
      const { rows } = await app.db.pool.query(`SELECT 1 FROM workspaces WHERE central_account_id = $1`, [
        ORG_WEIRD
      ]);
      expect(rows).toHaveLength(0);

      // An EXISTING org whose entry turns unknown-role: kept alive (never
      // read as absence), local role kept (no sync from a malformed entry).
      hub.setUserOrg('hub-rick', ORG_ONE, { name: 'Rick Org', role: 'emperor' });
      await expireTtl();
      await me(rickCookie);
      expect(await membershipRow(ORG_ONE, rick.email)).toEqual([
        { role: 'owner', origin: 'hub', is_active: true }
      ]);
      hub.setUserOrg('hub-rick', ORG_ONE, { name: 'Rick Org', role: 'owner' });
      hub.removeUserOrg('hub-rick', ORG_WEIRD);
    });
  });

  describe('failure posture: every hub error fails OPEN and is retry-throttled', () => {
    it('5xx: local state served, nothing deactivated, ONE probe per retry window', async () => {
      await expireTtl();
      await me(rickCookie); // fresh definitive pass first
      hub.statusMode = 'http500';
      try {
        await expireTtl();
        const before = h4Fetches();
        const first = await readJson(await me(rickCookie));
        expect(first.workspaces.length).toBeGreaterThanOrEqual(2); // ORG_ONE + ORG_TWO intact
        expect(h4Fetches()).toBe(before + 1);
        // Within retryMs: no second probe, still 200 on local state.
        expect((await me(rickCookie)).status).toBe(200);
        expect((await me(rickCookie)).status).toBe(200);
        expect(h4Fetches()).toBe(before + 1);
      } finally {
        hub.statusMode = 'ok';
      }
      expect(await membershipRow(ORG_TWO, rick.email)).toEqual([
        { role: 'member', origin: 'hub', is_active: true }
      ]);
    });

    it('403 (stale hub / broken key) is a transient error, NEVER a deactivation — no absent state', async () => {
      await sleep(DIALS.retryMs + 40);
      await me(rickCookie); // recover with a definitive pass
      hub.statusMode = 'http403';
      try {
        await expireTtl();
        expect((await me(rickCookie)).status).toBe(200);
      } finally {
        hub.statusMode = 'ok';
      }
      expect(await membershipRow(ORG_ONE, rick.email)).toEqual([
        { role: 'owner', origin: 'hub', is_active: true }
      ]);
      expect(await membershipRow(ORG_TWO, rick.email)).toEqual([
        { role: 'member', origin: 'hub', is_active: true }
      ]);
    });

    it('timeout: the awaited pass is bounded by userOrgsTimeoutMs and fails open', async () => {
      await sleep(DIALS.retryMs + 40);
      await me(rickCookie);
      hub.statusDelayMs = DIALS.userOrgsTimeoutMs + 400; // beyond the H4 timeout, under the org gate's
      try {
        await expireTtl();
        const startedAt = Date.now();
        expect((await me(rickCookie)).status).toBe(200);
        expect(Date.now() - startedAt).toBeLessThan(DIALS.timeoutMs);
      } finally {
        hub.statusDelayMs = 0;
      }
      expect(await membershipRow(ORG_TWO, rick.email)).toEqual([
        { role: 'member', origin: 'hub', is_active: true }
      ]);
    });

    it('recovers after the throttle window: the next reload reconciles again', async () => {
      hub.setUserOrg('hub-rick', ORG_FRESH, { name: 'Fresh Org', role: 'member' });
      await sleep(DIALS.retryMs + 40);
      const body = await readJson(await me(rickCookie));
      expect(body.workspaces.map((w: { name: string }) => w.name)).toContain('Fresh Org');
      hub.removeUserOrg('hub-rick', ORG_FRESH);
      hub.members.set(`${ORG_FRESH}:hub-rick`, { active: false });
      await expireTtl();
      await me(rickCookie);
    });
  });

  describe('cost discipline: cache, single-flight, machine skip', () => {
    it('N concurrent reloads share ONE fetch; a fresh cache costs zero', async () => {
      await expireTtl();
      hub.statusDelayMs = 100; // hold all racers in flight together
      let before: number;
      try {
        before = h4Fetches();
        const responses = await Promise.all(Array.from({ length: 8 }, () => me(rickCookie)));
        for (const res of responses) expect(res.status).toBe(200);
      } finally {
        hub.statusDelayMs = 0;
      }
      expect(h4Fetches()).toBe(before + 1); // single-flight
      expect((await me(rickCookie)).status).toBe(200); // within the TTL
      expect(h4Fetches()).toBe(before + 1); // cache hit, no fetch
    });

    it('machine credentials never reconcile: /me over an API key costs zero H4 fetches', async () => {
      const minted = await app.app.request('/api/v1/api-keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: rickCookie },
        body: JSON.stringify({ name: 'reconcile key', scopes: ['presentations:read'] })
      });
      expect(minted.status).toBe(201);
      const { key } = await readJson(minted);
      await expireTtl();
      const before = h4Fetches();
      const res = await app.app.request('/api/v1/me', { headers: { authorization: `Bearer ${key}` } });
      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(body.workspaces).toHaveLength(1); // machine listing unchanged (ADR 014)
      expect(h4Fetches()).toBe(before);
    });
  });
});

describe('the sweep’s blast radius: ONLY hub rows in projected workspaces', () => {
  it('an empty definitive list deactivates hub projections and NOTHING else', async () => {
    const tina: HubUserFixture = {
      sub: 'hub-tina',
      email: 'tina@reconcile.test',
      workspaceId: ORG_TINA,
      role: 'owner',
      workspaceName: 'Tina Org'
    };
    const cookie = await sso.ssoLogin(app, hub, tina);
    // Warm the H2 gate's per-(user, org) cache (memberTtlMs is pinned high
    // here) so the {active:false} override below reaches ONLY the H4 list —
    // this suite pins the reconciler's sweep, not the P4 gate.
    expect((await me(cookie)).status).toBe(200);
    const { rows: users } = await app.db.pool.query(`SELECT id FROM "user" WHERE email = $1`, [tina.email]);
    const tinaId = users[0].id as string;

    // Three rows the sweep must NEVER touch: a local row in an unprojected
    // workspace, a guest row, and a hub-origin RESIDUE row whose workspace
    // is not a projection (centralAccountId NULL).
    const mkWorkspace = async (name: string) => {
      const { rows } = await app.db.pool.query(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [
        name
      ]);
      return rows[0].id as string;
    };
    const localWs = await mkWorkspace('Tina Local');
    const guestWs = await mkWorkspace('Tina Guest Host');
    const residueWs = await mkWorkspace('Tina Residue');
    await app.db.pool.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role, origin, is_active) VALUES
       ($1, $4, 'member', 'local', true),
       ($2, $4, 'member', 'guest', true),
       ($3, $4, 'member', 'hub', true)`,
      [localWs, guestWs, residueWs, tinaId]
    );

    // The hub now asserts NO memberships for tina (H2/H4 coherent).
    hub.members.set(`${ORG_TINA}:hub-tina`, { active: false });
    await expireTtl();
    expect((await me(cookie)).status).toBe(200); // resolution ran before the sweep

    const { rows: after } = await app.db.pool.query(
      `SELECT w.name, m.origin, m.is_active FROM workspace_members m
        JOIN workspaces w ON w.id = m.workspace_id
       WHERE m.user_id = $1 ORDER BY w.name`,
      [tinaId]
    );
    expect(after).toEqual([
      { name: 'Tina Guest Host', origin: 'guest', is_active: true },
      { name: 'Tina Local', origin: 'local', is_active: true },
      { name: 'Tina Org', origin: 'hub', is_active: false }, // the ONE swept row
      { name: 'Tina Residue', origin: 'hub', is_active: true } // unprojected: out of scope
    ]);
    const { rows: audit } = await app.db.pool.query(
      `SELECT a.workspace_id FROM audit_log a
       WHERE a.action = 'member.deactivate' AND a.metadata->>'reason' = 'hub_reconcile'
         AND a.resource_id = $1`,
      [tinaId]
    );
    expect(audit).toHaveLength(1);
  });
});

describe('cli-connect: reconciliation joins, key binding does not widen', () => {
  it('the minted key stays bound to the ONE asserted org while every org projects', async () => {
    const carl: HubUserFixture = {
      sub: 'hub-carl',
      email: 'carl@reconcile.test',
      workspaceId: ORG_CLI,
      role: 'member',
      workspaceName: 'Carl CLI Org'
    };
    hub.setUserOrg('hub-carl', ORG_CLI_2, { name: 'Carl Second Org', role: 'admin' });
    const { token } = await hub.signConnectToken(carl, RESOURCE);
    const res = await app.app.request('/api/v1/sso/cli-connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': sso.nextIp() },
      body: JSON.stringify({ token })
    });
    expect(res.status).toBe(201);
    const body = await readJson(res);

    // BOTH orgs projected by the login-path reconcile …
    expect(await membershipRow(ORG_CLI, carl.email)).toEqual([
      { role: 'member', origin: 'hub', is_active: true }
    ]);
    expect(await membershipRow(ORG_CLI_2, carl.email)).toEqual([
      { role: 'admin', origin: 'hub', is_active: true }
    ]);
    // … but the key binds exactly the asserted one (single-org mint, ADR 014).
    expect(body.workspaceId).toBe(await workspaceIdOf(ORG_CLI));
    const keyMe = await readJson(
      await app.app.request('/api/v1/me', { headers: { authorization: `Bearer ${body.key}` } })
    );
    expect(keyMe.activeWorkspaceId).toBe(body.workspaceId);
    expect(keyMe.workspaces).toHaveLength(1);
  });
});

describe('observability', () => {
  it('hub_reconcile_passes_total is registered and counting', async () => {
    const res = await app.app.request('/metrics', {
      headers: { authorization: 'Bearer reconcile-metrics-token' }
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toMatch(/hub_reconcile_passes_total\{outcome="ok"\} [1-9]/);
    expect(text).toMatch(/hub_reconcile_passes_total\{outcome="inconclusive"\} [1-9]/);
  });
});
