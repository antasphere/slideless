import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDatabase, createTestApp, readJson, startPostgres, type TestApp } from './helpers.js';
import { FakeHub, type HubTokenOverrides, type HubUserFixture } from '../fake-hub.js';
import * as sso from './sso-helpers.js';

/**
 * "Sign in with Antasphere" — Phase 3 (docs/federation.md, ADR 015),
 * exercised against a faithful in-process hub stand-in (test/fake-hub.ts:
 * real OIDC discovery + JWKS + token endpoint over HTTP, minting the exact
 * token shapes the real hub does — the M1 gate re-proves the same flows in
 * a browser against the real hub in the federation harness):
 *
 *  - JIT provisioning + lazy org projection + membership assertion;
 *  - per-login re-sync of role (D11), workspace name (H1), email (D10);
 *  - D9 operator trusted-link; concurrent-first-login race; the fail-closed
 *    negative space (foreign aud/iss, expiry, opaque tokens, claim shape,
 *    email and identity collisions);
 *  - oss: zero SSO surface.
 */

const OWNER = { email: 'owner@sso.test', name: 'Op Erator', password: 'op-erator-password-123' };

const ORG_ACME = '11111111-aaaa-4bbb-8ccc-000000000001';
const ORG_BETA = '11111111-aaaa-4bbb-8ccc-000000000002';
const ORG_RACE = '11111111-aaaa-4bbb-8ccc-000000000003';
const ORG_LEFT = '11111111-aaaa-4bbb-8ccc-000000000004';
const ORG_RIGHT = '11111111-aaaa-4bbb-8ccc-000000000005';

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body)
});

let container: StartedPostgreSqlContainer;
let hub: FakeHub;

beforeAll(async () => {
  [container, hub] = await Promise.all([startPostgres(), FakeHub.start()]);
});

afterAll(async () => {
  await Promise.all([container?.stop(), hub?.stop()]);
});

function cloudEnv() {
  return {
    EDITION: 'cloud',
    HUB_ISSUER_URL: hub.issuer,
    HUB_CLIENT_ID: 'tool-slideless-cloud',
    HUB_CLIENT_SECRET: 'integration-test-hub-secret-0001',
    HUB_SERVICE_KEY: 'ant_integration_test_key'
  };
}

// The dance itself lives in sso-helpers.ts (shared with the P4
// hub-entitlements suite); these wrappers just bind this suite's hub.
const ssoInitiate = (app: TestApp) => sso.ssoInitiate(app);
const ssoDance = (app: TestApp, fixture: HubUserFixture) => sso.ssoDance(app, hub, fixture);
const ssoLogin = (app: TestApp, fixture: HubUserFixture) => sso.ssoLogin(app, hub, fixture);
const expectFailedLogin = sso.expectFailedLogin;

describe('cloud edition: the SSO entrance', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp(await createDatabase(container, 'hub_sso'), cloudEnv());
    const res = await app.app.request('/api/v1/setup', json({ instanceName: 'SSO', owner: OWNER }));
    expect(res.status).toBe(201);
  });

  afterAll(async () => {
    await app.stop();
  });

  const u1: HubUserFixture = {
    sub: 'hub-u1',
    email: 'alice@acme.test',
    name: 'Alice Acme',
    workspaceId: ORG_ACME,
    role: 'member',
    workspaceName: 'Acme Corp'
  };

  it('first login JIT-provisions the user, projects the org, and asserts the membership', async () => {
    const cookie = await ssoLogin(app, u1);

    // The session is real and lands in the projected workspace.
    const me = await readJson(await app.app.request('/api/v1/me', { headers: { cookie } }));
    expect(me.user.email).toBe('alice@acme.test');
    const projected = me.workspaces.find((w: { name: string }) => w.name === 'Acme Corp');
    expect(projected).toBeTruthy();
    expect(me.activeWorkspaceId).toBe(projected.id);

    // Deck list serves from the projected workspace (empty but authorized).
    const decks = await app.app.request('/api/v1/presentations', { headers: { cookie } });
    expect(decks.status).toBe(200);

    // DB truth: verified user, projection stamped with the hub org id,
    // membership carries the hub role verbatim with origin='hub'.
    const { rows: users } = await app.db.pool.query(
      `SELECT id, email_verified FROM "user" WHERE email = 'alice@acme.test'`
    );
    expect(users).toHaveLength(1);
    expect(users[0].email_verified).toBe(true);
    const { rows: ws } = await app.db.pool.query(
      `SELECT id, name FROM workspaces WHERE central_account_id = $1`,
      [ORG_ACME]
    );
    expect(ws).toHaveLength(1);
    expect(ws[0].name).toBe('Acme Corp');
    const { rows: members } = await app.db.pool.query(
      `SELECT role, origin, is_active FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
      [ws[0].id, users[0].id]
    );
    expect(members).toEqual([{ role: 'member', origin: 'hub', is_active: true }]);
  });

  it('passed RFC 8707 resource on the TOKEN request (the claim-minting switch)', () => {
    expect(hub.lastTokenRequest?.get('resource')).toBe('http://localhost:3000/mcp');
    // Confidential client: the secret rode the token request too.
    expect(hub.lastTokenRequest?.get('client_secret')).toBe('integration-test-hub-secret-0001');
  });

  it('second login re-syncs role (D11), workspace name (H1), and email (D10) — no duplicate projection', async () => {
    const cookie = await ssoLogin(app, {
      ...u1,
      email: 'alice.renamed@acme.test',
      role: 'admin',
      workspaceName: 'Acme Corp GmbH'
    });
    const me = await readJson(await app.app.request('/api/v1/me', { headers: { cookie } }));
    expect(me.user.email).toBe('alice.renamed@acme.test');

    const { rows: ws } = await app.db.pool.query(
      `SELECT id, name FROM workspaces WHERE central_account_id = $1`,
      [ORG_ACME]
    );
    expect(ws).toHaveLength(1); // the unique partial index held — same row, renamed
    expect(ws[0].name).toBe('Acme Corp GmbH');
    const { rows: members } = await app.db.pool.query(
      `SELECT m.role, m.origin, m.is_active FROM workspace_members m
       JOIN "user" u ON u.id = m.user_id WHERE m.workspace_id = $1 AND u.email = $2`,
      [ws[0].id, 'alice.renamed@acme.test']
    );
    expect(members).toEqual([{ role: 'admin', origin: 'hub', is_active: true }]);
    // The old address is gone — one user, synced in place.
    const { rows: old } = await app.db.pool.query(`SELECT 1 FROM "user" WHERE email = 'alice@acme.test'`);
    expect(old).toHaveLength(0);
  });

  it('reactivates a deactivated hub membership at the next login', async () => {
    await app.db.pool.query(
      `UPDATE workspace_members SET is_active = false
       WHERE workspace_id = (SELECT id FROM workspaces WHERE central_account_id = $1)`,
      [ORG_ACME]
    );
    await ssoLogin(app, { ...u1, email: 'alice.renamed@acme.test', role: 'admin' });
    const { rows } = await app.db.pool.query(
      `SELECT is_active FROM workspace_members
       WHERE workspace_id = (SELECT id FROM workspaces WHERE central_account_id = $1)`,
      [ORG_ACME]
    );
    expect(rows).toEqual([{ is_active: true }]);
  });

  it('projects under a placeholder when the hub omits workspace_name, and self-heals later', async () => {
    const u2: HubUserFixture = {
      sub: 'hub-u2',
      email: 'bob@beta.test',
      workspaceId: ORG_BETA,
      role: 'owner',
      workspaceName: null // hub without the H1 claim
    };
    await ssoLogin(app, u2);
    const { rows: before } = await app.db.pool.query(
      `SELECT name FROM workspaces WHERE central_account_id = $1`,
      [ORG_BETA]
    );
    expect(before[0].name).toBe(`Antasphere workspace ${ORG_BETA.slice(0, 8)}`);

    // The claim appears at a later login (hub upgraded) — the name follows.
    await ssoLogin(app, { ...u2, workspaceName: 'Beta LLC' });
    const { rows: after } = await app.db.pool.query(
      `SELECT name FROM workspaces WHERE central_account_id = $1`,
      [ORG_BETA]
    );
    expect(after[0].name).toBe('Beta LLC');
  });

  it('links the setup operator via the D9 trusted-provider path instead of duplicating', async () => {
    const cookie = await ssoLogin(app, {
      sub: 'hub-operator',
      email: OWNER.email,
      name: OWNER.name,
      workspaceId: ORG_ACME,
      role: 'owner',
      workspaceName: 'Acme Corp GmbH'
    });
    // Still exactly ONE local user for the operator's email…
    const { rows: users } = await app.db.pool.query(`SELECT id FROM "user" WHERE email = $1`, [OWNER.email]);
    expect(users).toHaveLength(1);
    // …now carrying the hub account link…
    const { rows: accounts } = await app.db.pool.query(
      `SELECT account_id FROM account WHERE user_id = $1 AND provider_id = 'antasphere'`,
      [users[0].id]
    );
    expect(accounts).toEqual([{ account_id: 'hub-operator' }]);
    // …with BOTH memberships: the local setup workspace and the projection.
    const me = await readJson(await app.app.request('/api/v1/me', { headers: { cookie } }));
    const names = me.workspaces.map((w: { name: string }) => w.name).sort();
    expect(names).toContain('Acme Corp GmbH');
    expect(me.workspaces.length).toBe(2);
    const { rows: memberships } = await app.db.pool.query(
      `SELECT origin, role FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
       WHERE m.user_id = $1 AND w.central_account_id = $2`,
      [users[0].id, ORG_ACME]
    );
    expect(memberships).toEqual([{ origin: 'hub', role: 'owner' }]);
  });

  it('two concurrent first-logins into a fresh org project exactly ONE workspace', async () => {
    const fixtures: HubUserFixture[] = [
      {
        sub: 'hub-race-1',
        email: 'r1@race.test',
        workspaceId: ORG_RACE,
        role: 'member',
        workspaceName: 'Race Org'
      },
      {
        sub: 'hub-race-2',
        email: 'r2@race.test',
        workspaceId: ORG_RACE,
        role: 'admin',
        workspaceName: 'Race Org'
      }
    ];
    // Two full states first, then both callbacks in flight together.
    const dances = [];
    for (const f of fixtures) {
      const { state, stateCookie } = await ssoInitiate(app);
      dances.push({ code: hub.mintCode(f), state, stateCookie });
    }
    const results = await Promise.all(
      dances.map(({ code, state, stateCookie }) =>
        app.app.request(
          `/api/v1/auth/oauth2/callback/antasphere?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
          { headers: { cookie: stateCookie } }
        )
      )
    );
    for (const res of results) {
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/');
    }
    const { rows: ws } = await app.db.pool.query(`SELECT id FROM workspaces WHERE central_account_id = $1`, [
      ORG_RACE
    ]);
    expect(ws).toHaveLength(1);
    const { rows: members } = await app.db.pool.query(
      `SELECT role FROM workspace_members WHERE workspace_id = $1 ORDER BY role`,
      [ws[0].id]
    );
    expect(members).toEqual([{ role: 'admin' }, { role: 'member' }]);
  });

  it('parallel logins of ONE user into two different orgs cannot cross-wire (request-scoped handoff)', async () => {
    const base = { sub: 'hub-multi', email: 'multi@orgs.test', name: 'Multi Org' };
    // Establish the user first: two parallel FIRST logins of one brand-new
    // user race the JIT insert and the loser fails cleanly on the email
    // uniqueness (retried by the human, never corrupting) — the race that
    // must hold is the ASSERTION handoff for an existing user.
    await ssoLogin(app, { ...base, workspaceId: ORG_LEFT, role: 'owner', workspaceName: 'Left Org' });

    const fixtures: HubUserFixture[] = [
      { ...base, workspaceId: ORG_LEFT, role: 'owner', workspaceName: 'Left Org' },
      { ...base, workspaceId: ORG_RIGHT, role: 'member', workspaceName: 'Right Org' }
    ];
    const dances = [];
    for (const f of fixtures) {
      const { state, stateCookie } = await ssoInitiate(app);
      dances.push({ code: hub.mintCode(f), state, stateCookie });
    }
    const results = await Promise.all(
      dances.map(({ code, state, stateCookie }) =>
        app.app.request(
          `/api/v1/auth/oauth2/callback/antasphere?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
          { headers: { cookie: stateCookie } }
        )
      )
    );
    for (const res of results) {
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/');
    }
    // Both orgs projected, each with the role ITS OWN login asserted — a
    // shared (non-request-scoped) handoff would have let one login project
    // the other's org/role.
    const { rows } = await app.db.pool.query(
      `SELECT w.central_account_id, m.role FROM workspace_members m
       JOIN workspaces w ON w.id = m.workspace_id
       JOIN "user" u ON u.id = m.user_id
       WHERE u.email = 'multi@orgs.test' ORDER BY w.central_account_id`,
      []
    );
    expect(rows).toEqual([
      { central_account_id: ORG_LEFT, role: 'owner' },
      { central_account_id: ORG_RIGHT, role: 'member' }
    ]);
  });

  describe('fail-closed negatives (no user, no session)', () => {
    const intruder = (overrides: HubTokenOverrides): HubUserFixture => ({
      sub: 'hub-evil',
      email: 'evil@negative.test',
      workspaceId: '11111111-aaaa-4bbb-8ccc-00000000dead',
      role: 'member',
      overrides
    });

    async function expectRejected(fixture: HubUserFixture) {
      const res = await ssoDance(app, fixture);
      // getUserInfo returned null → the plugin redirects to its error URL.
      await expectFailedLogin(app, res, 'error=');
      const { rows } = await app.db.pool.query(`SELECT 1 FROM "user" WHERE email = $1`, [fixture.email]);
      expect(rows).toHaveLength(0);
    }

    it('rejects an access token minted for another resource (aud)', async () => {
      await expectRejected(intruder({ accessAud: ['http://other-tool.test/mcp'] }));
    });

    it('rejects tokens from a foreign issuer', async () => {
      await expectRejected(intruder({ iss: 'http://evil-hub.test' }));
    });

    it('rejects expired tokens', async () => {
      await expectRejected(intruder({ expiresInSeconds: -60 }));
    });

    it('rejects an opaque access token (a hub that did not honor `resource`)', async () => {
      await expectRejected(intruder({ forceOpaque: true }));
    });

    it('rejects an id_token whose subject differs from the access token (cross-pin)', async () => {
      await expectRejected(intruder({ idTokenSub: 'hub-somebody-else' }));
    });

    it('refuses an unknown hub role rather than inventing a local one (D11)', async () => {
      await expectRejected({
        sub: 'hub-evil',
        email: 'evil@negative.test',
        workspaceId: '11111111-aaaa-4bbb-8ccc-00000000dead',
        role: 'superadmin'
      });
    });
  });

  it('fails the login cleanly when the hub-asserted email collides with another local user (D10)', async () => {
    const u6: HubUserFixture = {
      sub: 'hub-u6',
      email: 'carol@collide.test',
      workspaceId: ORG_BETA,
      role: 'member',
      workspaceName: 'Beta LLC'
    };
    await ssoLogin(app, u6); // establishes carol
    // The hub now asserts the OPERATOR's address for carol (hub-side email
    // change to an address someone else still holds locally).
    const res = await ssoDance(app, { ...u6, email: OWNER.email });
    await expectFailedLogin(app, res, 'error=sso_email_conflict');
    // Nothing corrupted: carol keeps her email, the operator keeps theirs.
    const { rows: carol } = await app.db.pool.query(
      `SELECT email FROM "user" u JOIN account a ON a.user_id = u.id
       WHERE a.provider_id = 'antasphere' AND a.account_id = 'hub-u6'`
    );
    expect(carol).toEqual([{ email: 'carol@collide.test' }]);
    const { rows: owners } = await app.db.pool.query(
      `SELECT COUNT(*)::int AS n FROM "user" WHERE email = $1`,
      [OWNER.email]
    );
    expect(owners).toEqual([{ n: 1 }]);
  });

  it('refuses to merge two hub identities onto one local user (stale-email takeover)', async () => {
    // dave logs in with e7 …
    const dave: HubUserFixture = {
      sub: 'hub-u7',
      email: 'dave@stale.test',
      workspaceId: ORG_BETA,
      role: 'member',
      workspaceName: 'Beta LLC'
    };
    await ssoLogin(app, dave);
    // … then a DIFFERENT hub identity asserts dave's (now stale hub-side)
    // address: the trusted email-match link would merge it onto dave's local
    // user — the guard undoes the link and fails the login.
    const res = await ssoDance(app, { ...dave, sub: 'hub-u8', name: 'Mallory' });
    await expectFailedLogin(app, res, 'error=sso_identity_conflict');
    const { rows: accounts } = await app.db.pool.query(
      `SELECT a.account_id FROM account a JOIN "user" u ON u.id = a.user_id
       WHERE u.email = 'dave@stale.test' AND a.provider_id = 'antasphere' ORDER BY a.account_id`
    );
    expect(accounts).toEqual([{ account_id: 'hub-u7' }]); // the merge left no trace
  });

  it('maps the hub email_verified claim honestly on JIT (unverified stays unverified)', async () => {
    await ssoLogin(app, {
      sub: 'hub-u9',
      email: 'eve@unverified.test',
      emailVerified: false,
      workspaceId: ORG_BETA,
      role: 'member',
      workspaceName: 'Beta LLC'
    });
    const { rows } = await app.db.pool.query(`SELECT email_verified FROM "user" WHERE email = $1`, [
      'eve@unverified.test'
    ]);
    expect(rows).toEqual([{ email_verified: false }]);
  });

  it('never syncs emailVerified DOWNWARD for an unchanged address (the break-glass latch)', async () => {
    const grace: HubUserFixture = {
      sub: 'hub-u11',
      email: 'grace@latch.test',
      workspaceId: ORG_BETA,
      role: 'member',
      workspaceName: 'Beta LLC'
    };
    await ssoLogin(app, grace); // JIT, verified (hub default)
    // The hub now asserts email_verified=false for the SAME address (a hub
    // posture change / bug): the local latch must hold — break-glass refuses
    // unverified users, so a downward flip would close the operator door.
    await ssoLogin(app, { ...grace, emailVerified: false });
    const { rows } = await app.db.pool.query(`SELECT email_verified FROM "user" WHERE email = $1`, [
      'grace@latch.test'
    ]);
    expect(rows).toEqual([{ email_verified: true }]);
  });

  it('takes the hub-asserted verification state when the address CHANGES (no false latch)', async () => {
    // grace's hub email changes to a NEW address asserted unverified: the
    // new mailbox is unproven, so the honest state is unverified.
    await ssoLogin(app, {
      sub: 'hub-u11',
      email: 'grace.moved@latch.test',
      emailVerified: false,
      workspaceId: ORG_BETA,
      role: 'member',
      workspaceName: 'Beta LLC'
    });
    const { rows } = await app.db.pool.query(`SELECT email, email_verified FROM "user" WHERE email = $1`, [
      'grace.moved@latch.test'
    ]);
    expect(rows).toEqual([{ email: 'grace.moved@latch.test', email_verified: false }]);
  });

  it('a residue second hub link is undone in favor of the OLDER identity (guard keys on recency)', async () => {
    const frank: HubUserFixture = {
      sub: 'hub-u10',
      email: 'frank@residue.test',
      workspaceId: ORG_BETA,
      role: 'member',
      workspaceName: 'Beta LLC'
    };
    await ssoLogin(app, frank);
    const { rows: users } = await app.db.pool.query(`SELECT id FROM "user" WHERE email = $1`, [
      'frank@residue.test'
    ]);
    // Simulate the residue a crash between better-auth's link and the
    // after-hook (or an explicit /oauth2/link) leaves behind: a SECOND,
    // newer antasphere row on the same user that no guard ever saw.
    await app.db.pool.query(
      `INSERT INTO account (id, account_id, provider_id, user_id, created_at, updated_at)
       VALUES ('residue-acct-1', 'hub-ghost', 'antasphere', $1, now() + interval '1 second', now())`,
      [users[0].id]
    );
    // Frank's own (older, legitimate) identity logs in: the guard must
    // delete the GHOST row, not frank's — deleting the current-sub row here
    // would destroy the established identity and strand the user.
    const res = await ssoDance(app, frank);
    await expectFailedLogin(app, res, 'error=sso_identity_conflict');
    const { rows: accounts } = await app.db.pool.query(
      `SELECT account_id FROM account WHERE user_id = $1 AND provider_id = 'antasphere'`,
      [users[0].id]
    );
    expect(accounts).toEqual([{ account_id: 'hub-u10' }]); // ghost gone, frank intact
    // Self-healed: the retry logs straight in.
    await ssoLogin(app, frank);
  });
});

describe('oss edition: zero SSO surface', () => {
  it('registers no OAuth relying party at all', async () => {
    const app = await createTestApp(await createDatabase(container, 'hub_sso_oss'));
    // The genericOAuth plugin is absent → its routes do not exist.
    const res = await app.app.request(
      '/api/v1/auth/sign-in/oauth2',
      json({ providerId: 'antasphere', callbackURL: '/' })
    );
    expect(res.status).toBe(404);
    const cb = await app.app.request('/api/v1/auth/oauth2/callback/antasphere?code=x&state=y');
    expect(cb.status).toBe(404);
    await app.stop();
  });
});
