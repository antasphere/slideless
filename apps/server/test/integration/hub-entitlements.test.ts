import { createHash, randomBytes } from 'node:crypto';
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
import { FakeHub, type HubUserFixture } from '../fake-hub.js';
import { json, ssoLogin } from './sso-helpers.js';

/**
 * Phase 4 (docs/federation.md, ADR 016): the hub gates that hold BETWEEN
 * logins, against the FakeHub's accounts:status surface —
 *
 *  - org suspension (D5 dials): suspended/404 deny with a reason within the
 *    cache window, for sessions AND machine credentials; hub outages serve
 *    stale within 15 min (scaled here), then fail closed, then recover;
 *  - membership re-assertion (D3/D11, hub delta H2): a definitive
 *    `{active:false}` deactivates the local origin='hub' row → sessions,
 *    API keys, and OAuth bearers all lock out; role deltas sync; H2
 *    absence/errors NEVER deactivate; non-hub rows are never touched;
 *  - workspaces with no `centralAccountId` never talk to the hub at all;
 *  - oss binds the plain local seams (zero hub surface).
 *
 * Cache dials are shrunk via the hubDials boot override so propagation is
 * observable in milliseconds; production runs the fixed D5/D3 values
 * (pinned in the unit suite).
 */

const OWNER = { email: 'owner@entitle.test', name: 'Op Owner', password: 'op-owner-password-123' };

const ORG_SUSPEND = '22222222-aaaa-4bbb-8ccc-000000000001';
const ORG_GONE = '22222222-aaaa-4bbb-8ccc-000000000002';
const ORG_OUTAGE = '22222222-aaaa-4bbb-8ccc-000000000003';
const ORG_REMOVE = '22222222-aaaa-4bbb-8ccc-000000000004';
const ORG_ROLE = '22222222-aaaa-4bbb-8ccc-000000000005';
const ORG_QUIET = '22222222-aaaa-4bbb-8ccc-000000000006';
const ORG_RACE = '22222222-aaaa-4bbb-8ccc-000000000007';
const ORG_RACE_ROLE = '22222222-aaaa-4bbb-8ccc-000000000008';

const DIALS = { orgTtlMs: 150, orgStaleMaxMs: 600, retryMs: 40, memberTtlMs: 150, timeoutMs: 2000 };

const REDIRECT_URI = 'http://127.0.0.1:19999/callback';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let container: StartedPostgreSqlContainer;
let hub: FakeHub;
let app: TestApp;

beforeAll(async () => {
  [container, hub] = await Promise.all([startPostgres(), FakeHub.start()]);
  app = await createTestApp(
    await createDatabase(container, 'hub_entitlements'),
    {
      EDITION: 'cloud',
      HUB_ISSUER_URL: hub.issuer,
      HUB_CLIENT_ID: 'tool-slideless-cloud',
      HUB_CLIENT_SECRET: 'integration-test-hub-secret-0001',
      HUB_SERVICE_KEY: 'ant_integration_test_key'
    },
    { hubDials: DIALS }
  );
  const res = await app.app.request('/api/v1/setup', json({ instanceName: 'Entitle', owner: OWNER }));
  expect(res.status).toBe(201);
}, 240_000);

afterAll(async () => {
  await app?.stop();
  await Promise.all([container?.stop(), hub?.stop()]);
});

/** Poll until `fn` says done or the deadline passes; returns the last probe. */
async function eventually<T>(
  probe: () => Promise<T> | T,
  done: (value: T) => boolean,
  deadlineMs = 5_000
): Promise<T> {
  const startedAt = Date.now();
  for (;;) {
    const value = await probe();
    if (done(value) || Date.now() - startedAt > deadlineMs) return value;
    await sleep(50);
  }
}

const me = async (cookie: string) => app.app.request('/api/v1/me', { headers: { cookie } });

async function mintApiKey(cookie: string): Promise<string> {
  const create = await app.app.request('/api/v1/api-keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: 'gate test key', scopes: ['presentations:read', 'presentations:write'] })
  });
  expect(create.status).toBe(201);
  return (await readJson(create)).key;
}

describe('org suspension gate (D5)', () => {
  const sam: HubUserFixture = {
    sub: 'hub-sam',
    email: 'sam@suspend.test',
    name: 'Sam Suspended',
    workspaceId: ORG_SUSPEND,
    role: 'owner',
    workspaceName: 'Suspend Org'
  };
  let samCookie: string;
  let samKey: string;

  beforeAll(async () => {
    samCookie = await ssoLogin(app, hub, sam);
    samKey = await mintApiKey(samCookie);
  });

  it('an active hub org works, and the status poll presents the service key', async () => {
    expect((await me(samCookie)).status).toBe(200);
    const decks = await app.app.request('/api/v1/presentations', {
      headers: { authorization: `Bearer ${samKey}` }
    });
    expect(decks.status).toBe(200);
    const statusCalls = hub.statusRequests.filter((r) => r.path === `/api/v1/accounts/${ORG_SUSPEND}/status`);
    expect(statusCalls.length).toBeGreaterThan(0);
    for (const call of statusCalls) expect(call.auth).toBe('Bearer ant_integration_test_key');
  });

  it('suspension denies sessions AND API keys within the cache window, with the reason', async () => {
    hub.orgStatuses.set(ORG_SUSPEND, 'suspended');
    const denied = await eventually(
      () => me(samCookie),
      (r) => r.status === 403
    );
    expect(denied.status).toBe(403);
    const body = await readJson(denied);
    expect(body.error.code).toBe('account_suspended');
    expect(body.error.message).toContain('Antasphere');

    // The machine path is denied by the same gate (cached — no extra poll).
    const viaKey = await app.app.request('/api/v1/presentations', {
      headers: { authorization: `Bearer ${samKey}` }
    });
    expect(viaKey.status).toBe(403);
    expect((await readJson(viaKey)).error.code).toBe('account_suspended');
  });

  it('reactivation restores access within the window', async () => {
    hub.orgStatuses.set(ORG_SUSPEND, 'active');
    const restored = await eventually(
      () => me(samCookie),
      (r) => r.status === 200
    );
    expect(restored.status).toBe(200);
  });

  it('a hub org that no longer exists (404) is denied like a suspension', async () => {
    hub.orgStatuses.set(ORG_SUSPEND, 'missing');
    const denied = await eventually(
      () => me(samCookie),
      (r) => r.status === 403
    );
    expect(denied.status).toBe(403);
    expect((await readJson(denied)).error.code).toBe('account_suspended');
    hub.orgStatuses.set(ORG_SUSPEND, 'active');
    await eventually(
      () => me(samCookie),
      (r) => r.status === 200
    );
  });

  it('the deny also reaches the EntitlementService seam (defense in depth)', async () => {
    const principal = {
      userId: 'u',
      email: 'sam@suspend.test',
      name: 'Sam',
      workspaceId: 'w',
      role: 'owner' as const,
      origin: 'hub' as const,
      via: 'session' as const,
      scopes: null,
      accountRef: ORG_GONE
    };
    const check = () =>
      app.registry.entitlements.check(principal, { key: 'files.upload', quantity: 1, unit: 'bytes' });
    expect((await check()).allowed).toBe(true);
    hub.orgStatuses.set(ORG_GONE, 'suspended');
    // Stale-while-revalidate: the first post-TTL check may still serve the
    // stale allow while the refresh lands — the deny follows within it.
    const denied = await eventually(check, (d) => !d.allowed);
    expect(denied).toEqual({ allowed: false, reason: expect.stringContaining('Antasphere') });
  });
});

describe('hub outage posture (stale-while-error, then fail closed, then recover)', () => {
  const eva: HubUserFixture = {
    sub: 'hub-eva',
    email: 'eva@outage.test',
    name: 'Eva Outage',
    workspaceId: ORG_OUTAGE,
    role: 'member',
    workspaceName: 'Outage Org'
  };

  it('serves stale within the window, fails closed after it, recovers on the next probe', async () => {
    const cookie = await ssoLogin(app, hub, eva);
    expect((await me(cookie)).status).toBe(200); // cache warmed from a real success
    hub.statusMode = 'network';
    try {
      // Inside the stale window: requests keep working on the last value
      // (and the H2 re-assertion failure is inconclusive — fail open).
      await sleep(DIALS.orgTtlMs + 60);
      expect((await me(cookie)).status).toBe(200);
      // Beyond it: fail closed with its own reason code.
      const closed = await eventually(
        () => me(cookie),
        (r) => r.status === 403
      );
      expect(closed.status).toBe(403);
      expect((await readJson(closed)).error.code).toBe('hub_unavailable');
    } finally {
      hub.statusMode = 'ok';
    }
    const recovered = await eventually(
      () => me(cookie),
      (r) => r.status === 200
    );
    expect(recovered.status).toBe(200);

    // The membership survived the whole outage: errors never deactivate.
    const { rows } = await app.db.pool.query(
      `SELECT m.is_active FROM workspace_members m
       JOIN workspaces w ON w.id = m.workspace_id WHERE w.central_account_id = $1`,
      [ORG_OUTAGE]
    );
    expect(rows).toEqual([{ is_active: true }]);
  });

  it('5xx answers are the same inconclusive posture (no deactivation, stale org status)', async () => {
    const cookie = await ssoLogin(app, hub, eva);
    expect((await me(cookie)).status).toBe(200);
    hub.statusMode = 'http500';
    try {
      await sleep(DIALS.memberTtlMs + 60); // member cache expired → H2 re-asserted → 500 → fail open
      expect((await me(cookie)).status).toBe(200); // org status stale-served, membership kept
    } finally {
      hub.statusMode = 'ok';
    }
  });
});

describe('workspaces with no hub projection', () => {
  it('the operator workspace (no centralAccountId) never talks to the hub', async () => {
    const signIn = await app.app.request(
      '/api/v1/auth/sign-in/email',
      json({ email: OWNER.email, password: OWNER.password })
    );
    expect(signIn.status).toBe(200);
    const cookie = extractCookie(signIn);
    const before = hub.statusRequests.length;
    for (let i = 0; i < 3; i += 1) {
      expect((await me(cookie)).status).toBe(200);
    }
    expect((await app.app.request('/api/v1/presentations', { headers: { cookie } })).status).toBe(200);
    expect(hub.statusRequests.length).toBe(before);
  });
});

describe('membership re-assertion (D3/D11, hub delta H2)', () => {
  const max: HubUserFixture = {
    sub: 'hub-max',
    email: 'max@remove.test',
    name: 'Max Removed',
    workspaceId: ORG_REMOVE,
    role: 'owner',
    workspaceName: 'Remove Org'
  };
  const rita: HubUserFixture = {
    sub: 'hub-rita',
    email: 'rita@role.test',
    name: 'Rita Role',
    workspaceId: ORG_ROLE,
    role: 'admin',
    workspaceName: 'Role Org'
  };

  /** In-process OAuth 2.1 dance (PKCE + consent) for a session cookie. */
  let oauthClientId: string;
  async function oauthBearer(cookie: string): Promise<string> {
    if (!oauthClientId) {
      const register = await app.app.request(
        '/api/v1/auth/oauth2/register',
        json({
          client_name: 'hub-gate-client',
          redirect_uris: [REDIRECT_URI],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code']
        })
      );
      expect([200, 201]).toContain(register.status);
      oauthClientId = (await readJson(register)).client_id;
    }
    const verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest().toString('base64url');
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: oauthClientId,
      redirect_uri: REDIRECT_URI,
      scope: 'openid presentations:read',
      state: 'gate-state',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: 'http://localhost:3000/mcp'
    });
    const authorize = await app.app.request(`/api/v1/auth/oauth2/authorize?${params}`, {
      headers: { cookie }
    });
    let location: string;
    if (authorize.status === 302) {
      location = authorize.headers.get('location') ?? '';
    } else {
      expect(authorize.status).toBe(200);
      location = (await readJson(authorize)).url;
    }
    let codeUrl: URL;
    if (location.includes('/oauth/consent?')) {
      const consent = await app.app.request('/api/v1/auth/oauth2/consent', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ accept: true, oauth_query: location.split('?')[1] ?? '' })
      });
      expect(consent.status).toBe(200);
      const body = await readJson(consent);
      codeUrl = new URL(body.redirect_uri ?? body.url ?? '');
    } else {
      codeUrl = new URL(location);
    }
    const code = codeUrl.searchParams.get('code');
    expect(code).toBeTruthy();
    const token = await app.app.request('/api/v1/auth/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code!,
        redirect_uri: REDIRECT_URI,
        client_id: oauthClientId,
        code_verifier: verifier,
        resource: 'http://localhost:3000/mcp'
      })
    });
    expect(token.status).toBe(200);
    return (await readJson(token)).access_token;
  }

  it('a hub removal locks out sessions, API keys, AND OAuth bearers; the row deactivates', async () => {
    const cookie = await ssoLogin(app, hub, max);
    const key = await mintApiKey(cookie);
    const bearer = await oauthBearer(cookie);

    // All three credential paths live.
    expect((await me(cookie)).status).toBe(200);
    const keyReq = () => app.app.request('/api/v1/presentations', { headers: { authorization: `Bearer ${key}` } });
    const bearerReq = () =>
      app.app.request('/api/v1/presentations', { headers: { authorization: `Bearer ${bearer}` } });
    expect((await keyReq()).status).toBe(200);
    expect((await bearerReq()).status).toBe(200);

    // Removed on the hub: the H2 re-assertion (definitive {active:false})
    // deactivates the local row on the next expiry.
    hub.members.set(`${ORG_REMOVE}:hub-max`, { active: false });
    const denied = await eventually(
      () => me(cookie),
      (r) => r.status !== 200
    );
    expect(denied.status).toBe(401);
    // The FIRST refusal is the gate's own verdict (it deactivated the row
    // in the same request); everything after is plain unauthenticated.
    expect((await readJson(denied)).error.code).toBe('membership_revoked');

    // Instant lockout everywhere: the live-membership re-check now fails
    // for every credential minted against this workspace.
    expect((await me(cookie)).status).toBe(401);
    expect((await keyReq()).status).toBe(401);
    expect((await bearerReq()).status).toBe(401);

    // DB truth: deactivated, still origin='hub'; audited as system.
    const { rows } = await app.db.pool.query(
      `SELECT m.is_active, m.origin FROM workspace_members m
       JOIN workspaces w ON w.id = m.workspace_id WHERE w.central_account_id = $1`,
      [ORG_REMOVE]
    );
    expect(rows).toEqual([{ is_active: false, origin: 'hub' }]);
    const { rows: audit } = await app.db.pool.query(
      `SELECT action, actor_via, metadata FROM audit_log WHERE action = 'member.deactivate'
       AND metadata->>'reason' = 'hub_reassertion'`
    );
    expect(audit.length).toBe(1);
    expect(audit[0].actor_via).toBe('system');
  });

  it('a hub role change syncs the local row and takes effect on that very request (D11)', async () => {
    const cookie = await ssoLogin(app, hub, rita);
    // Admin surface reachable with the hub-asserted admin role.
    expect((await app.app.request('/api/v1/audit', { headers: { cookie } })).status).toBe(200);

    // Demoted on the hub → the admin surface closes within the window…
    hub.members.set(`${ORG_ROLE}:hub-rita`, { active: true, role: 'member' });
    const demoted = await eventually(
      () => app.app.request('/api/v1/audit', { headers: { cookie } }),
      (r) => r.status === 403
    );
    expect(demoted.status).toBe(403);
    // …/me agrees, and the row carries the synced role.
    expect((await readJson(await me(cookie))).role).toBe('member');
    const { rows } = await app.db.pool.query(
      `SELECT m.role, m.origin, m.is_active FROM workspace_members m
       JOIN workspaces w ON w.id = m.workspace_id WHERE w.central_account_id = $1`,
      [ORG_ROLE]
    );
    expect(rows).toEqual([{ role: 'member', origin: 'hub', is_active: true }]);

    // Promoted back → the surface reopens.
    hub.members.set(`${ORG_ROLE}:hub-rita`, { active: true, role: 'admin' });
    const promoted = await eventually(
      () => app.app.request('/api/v1/audit', { headers: { cookie } }),
      (r) => r.status === 200
    );
    expect(promoted.status).toBe(200);
  });

  it('an older hub without H2 (404) never deactivates anything', async () => {
    const quinn: HubUserFixture = {
      sub: 'hub-quinn',
      email: 'quinn@quiet.test',
      name: 'Quinn Quiet',
      workspaceId: ORG_QUIET,
      role: 'member',
      workspaceName: 'Quiet Org'
    };
    const cookie = await ssoLogin(app, hub, quinn);
    hub.h2 = false;
    try {
      await sleep(DIALS.memberTtlMs + 60);
      expect((await me(cookie)).status).toBe(200);
      await sleep(DIALS.memberTtlMs + 60);
      expect((await me(cookie)).status).toBe(200);
    } finally {
      hub.h2 = true;
    }
    const { rows } = await app.db.pool.query(
      `SELECT m.is_active FROM workspace_members m
       JOIN workspaces w ON w.id = m.workspace_id WHERE w.central_account_id = $1`,
      [ORG_QUIET]
    );
    expect(rows).toEqual([{ is_active: true }]);
  });

  it('non-hub membership rows in a projected workspace are never re-asserted', async () => {
    // A guest row in Rita's projected workspace: the tool's own grant, not
    // hub truth. The gate must skip H2 for it entirely.
    const guest = await app.auth.api.signUpEmail({
      body: { email: 'guest@role.test', password: 'guest-password-123456', name: 'Gary Guest' }
    });
    const { rows: ws } = await app.db.pool.query(`SELECT id FROM workspaces WHERE central_account_id = $1`, [
      ORG_ROLE
    ]);
    await app.db.pool.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role, origin, is_active)
       VALUES ($1, $2, 'member', 'guest', true)`,
      [ws[0].id, guest.user.id]
    );
    const signIn = await app.app.request(
      '/api/v1/auth/sign-in/email',
      json({ email: 'guest@role.test', password: 'guest-password-123456' })
    );
    expect(signIn.status).toBe(200);
    const cookie = extractCookie(signIn);

    const memberCallsBefore = hub.statusRequests.filter((r) => r.path.includes('/members/')).length;
    expect((await me(cookie)).status).toBe(200);
    await sleep(DIALS.memberTtlMs + 60);
    expect((await me(cookie)).status).toBe(200);
    const memberCallsAfter = hub.statusRequests.filter((r) => r.path.includes('/members/')).length;
    // The org-status gate still applies (same workspace), but NO H2 call
    // was made for the guest — and the row is untouched.
    expect(memberCallsAfter).toBe(memberCallsBefore);
    const { rows } = await app.db.pool.query(
      `SELECT is_active, origin FROM workspace_members WHERE user_id = $1`,
      [guest.user.id]
    );
    expect(rows).toEqual([{ is_active: true, origin: 'guest' }]);
  });
});

describe('concurrent re-assertions audit once (D1)', () => {
  // The FakeHub holds every status answer for a beat, so all N racers are
  // provably in flight inside the member probe at the same time (the probe
  // fan-out is the accepted residual — N hub calls). Only the racer whose
  // UPDATE actually flips the row may audit: one logical hub-side event must
  // write ONE audit row, never one per racer.
  it('a removal race writes exactly ONE member.deactivate row; every racer is locked out', async () => {
    const racer: HubUserFixture = {
      sub: 'hub-race',
      email: 'race@remove.test',
      name: 'Race Removed',
      workspaceId: ORG_RACE,
      role: 'owner',
      workspaceName: 'Race Org'
    };
    const cookie = await ssoLogin(app, hub, racer);
    // Removed hub-side BEFORE the first authed request: the member cache is
    // cold for every racer, so all 8 re-assert concurrently.
    hub.members.set(`${ORG_RACE}:hub-race`, { active: false });
    hub.statusDelayMs = 150;
    let responses: Response[];
    try {
      responses = await Promise.all(Array.from({ length: 8 }, () => me(cookie)));
    } finally {
      hub.statusDelayMs = 0;
    }

    // Every racer is refused with the gate's own verdict — the lockout is
    // unconditional, whoever won the UPDATE.
    for (const res of responses) {
      expect(res.status).toBe(401);
      expect((await readJson(res)).error.code).toBe('membership_revoked');
    }
    // The race really fanned out: several racers probed H2 for this pair…
    const probes = hub.statusRequests.filter(
      (r) => r.path === `/api/v1/accounts/${ORG_RACE}/members/hub-race/status`
    );
    expect(probes.length).toBeGreaterThan(1);
    // …the row is deactivated…
    const { rows } = await app.db.pool.query(
      `SELECT m.is_active, m.origin FROM workspace_members m
       JOIN workspaces w ON w.id = m.workspace_id WHERE w.central_account_id = $1`,
      [ORG_RACE]
    );
    expect(rows).toEqual([{ is_active: false, origin: 'hub' }]);
    // …and the ONE removal produced exactly ONE audit row, not 8.
    const { rows: audit } = await app.db.pool.query(
      `SELECT a.action FROM audit_log a
       JOIN workspaces w ON w.id = a.workspace_id
       WHERE w.central_account_id = $1 AND a.action = 'member.deactivate'
       AND a.metadata->>'reason' = 'hub_reassertion'`,
      [ORG_RACE]
    );
    expect(audit.length).toBe(1);
  });

  it('a role-change race writes exactly ONE member.update row; the role still syncs', async () => {
    const rho: HubUserFixture = {
      sub: 'hub-rho',
      email: 'rho@role-race.test',
      name: 'Rho Raced',
      workspaceId: ORG_RACE_ROLE,
      role: 'admin',
      workspaceName: 'Role Race Org'
    };
    const cookie = await ssoLogin(app, hub, rho);
    hub.members.set(`${ORG_RACE_ROLE}:hub-rho`, { active: true, role: 'member' });
    hub.statusDelayMs = 150;
    let responses: Response[];
    try {
      responses = await Promise.all(Array.from({ length: 8 }, () => me(cookie)));
    } finally {
      hub.statusDelayMs = 0;
    }

    // Live member throughout: every racer succeeds, already demoted (D11).
    for (const res of responses) {
      expect(res.status).toBe(200);
      expect((await readJson(res)).role).toBe('member');
    }
    const { rows } = await app.db.pool.query(
      `SELECT m.role FROM workspace_members m
       JOIN workspaces w ON w.id = m.workspace_id WHERE w.central_account_id = $1`,
      [ORG_RACE_ROLE]
    );
    expect(rows).toEqual([{ role: 'member' }]);
    // One hub-side role change → exactly ONE member.update audit row.
    const { rows: audit } = await app.db.pool.query(
      `SELECT a.action FROM audit_log a
       JOIN workspaces w ON w.id = a.workspace_id
       WHERE w.central_account_id = $1 AND a.action = 'member.update'
       AND a.metadata->>'reason' = 'hub_reassertion'`,
      [ORG_RACE_ROLE]
    );
    expect(audit.length).toBe(1);
  });
});

describe('oss: the local seams, untouched', () => {
  it('an oss boot binds AllowAllEntitlements and no hub gate', async () => {
    const oss = await createTestApp(await createDatabase(container, 'hub_entitlements_oss'));
    try {
      expect(oss.registry.entitlements.constructor.name).toBe('AllowAllEntitlements');
      const res = await oss.app.request('/api/v1/setup', json({ instanceName: 'Oss', owner: OWNER }));
      expect(res.status).toBe(201);
      const signIn = await oss.app.request(
        '/api/v1/auth/sign-in/email',
        json({ email: OWNER.email, password: OWNER.password })
      );
      const before = hub.statusRequests.length;
      expect((await oss.app.request('/api/v1/me', { headers: { cookie: extractCookie(signIn) } })).status).toBe(
        200
      );
      // Nothing on oss knows any hub exists.
      expect(hub.statusRequests.length).toBe(before);
    } finally {
      await oss.stop();
    }
  });
});
