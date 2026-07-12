import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDatabase, createTestApp, readJson, startPostgres, type TestApp } from './helpers.js';
import { FakeHub, type HubUserFixture } from '../fake-hub.js';
import * as sso from './sso-helpers.js';

/**
 * CLI cross-tool connect — Phase 5, `POST /api/v1/sso/cli-connect`
 * (docs/federation.md): the endpoint that turns a hub-minted 120 s exchange
 * JWT (hub delta H3, `purpose: 'sso-connect'`, unique `jti`) into an
 * ordinary local `slk_` key, so `antasphere login` is the ONLY login a
 * cloud CLI user ever performs.
 *
 * The endpoint is public (the hub JWT is the credential), so this suite is
 * mostly negative space:
 *
 *  - the full verification chain fail-closed: signature, iss pin, aud pin,
 *    `purpose` required (a flow-(a) hub access token dies here), expiry,
 *    `jti` required, and — G8 — jti ONE-TIME-USE (replay, incl. concurrent);
 *  - JIT parity with SSO login: same user/account/workspace/membership rows,
 *    the `user.created` seam fires (once), the two entrances interleave
 *    without duplicating anything;
 *  - the minted key: `slk_`, bound to the projected workspace, scopes
 *    presentations:read + presentations:write, NEVER data:export;
 *  - oss: the route does not exist (404, absent from the OpenAPI document).
 */

const OWNER = { email: 'owner@connect.test', name: 'Op Erator', password: 'op-erator-password-123' };

const ORG_ACME = '22222222-aaaa-4bbb-8ccc-000000000001';
const ORG_BETA = '22222222-aaaa-4bbb-8ccc-000000000002';

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

/** The instance's own resource URL — the exchange token's pinned audience. */
const RESOURCE = 'http://localhost:3000/mcp';

function cloudEnv() {
  return {
    EDITION: 'cloud',
    HUB_ISSUER_URL: hub.issuer,
    HUB_CLIENT_ID: 'tool-slideless-cloud',
    HUB_CLIENT_SECRET: 'integration-test-hub-secret-0001',
    HUB_SERVICE_KEY: 'ant_integration_test_key'
  };
}

/** POST the exchange token from a fresh per-call IP (the login wall is per IP). */
async function connect(app: TestApp, token: string, ip = sso.nextIp()): Promise<Response> {
  const init = json({ token });
  return await app.app.request('/api/v1/sso/cli-connect', {
    ...init,
    headers: { ...init.headers, 'x-forwarded-for': ip }
  });
}

describe('cloud edition: POST /sso/cli-connect', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp(await createDatabase(container, 'sso_cli_connect'), cloudEnv());
    const res = await app.app.request('/api/v1/setup', json({ instanceName: 'Connect', owner: OWNER }));
    expect(res.status).toBe(201);
  });

  afterAll(async () => {
    await app.stop();
  });

  const alice: HubUserFixture = {
    sub: 'hub-cli-alice',
    email: 'alice@connect.test',
    workspaceId: ORG_ACME,
    role: 'member',
    workspaceName: 'Acme Corp'
  };

  it('exchanges a valid token: JIT user + projection + an slk_ key bound to the projected workspace', async () => {
    // The user.created seam must fire exactly once, from the internal
    // adapter's JIT create — the proof this entrance is the sanctioned one
    // (same hook the collaborator grant sweep rides).
    const created: Array<{ userId: string; email: string }> = [];
    const off = app.registry.events.on('user.created', (p) => {
      created.push(p);
    });

    const { token } = await hub.signConnectToken(alice, RESOURCE);
    const res = await connect(app, token);
    expect(res.status).toBe(201);
    const body = await readJson(res);

    // The one-shot key: slk_, the CLI grant, never data:export.
    expect(body.key).toMatch(/^slk_/);
    expect(body.apiKey.scopes.sort()).toEqual(['presentations:read', 'presentations:write']);
    expect(body.apiKey.scopes).not.toContain('data:export');
    expect(body.apiKey.name).toMatch(/^Antasphere CLI \d{4}-\d{2}-\d{2}$/);
    expect(body.apiKey.expiresAt).toBeNull();
    expect(body.user.email).toBe('alice@connect.test');

    // DB truth — the same rows an SSO login would produce (hub-sso suite):
    // verified user, antasphere account link, projection stamped with the
    // hub org id, membership role verbatim with origin='hub'.
    const { rows: users } = await app.db.pool.query(
      `SELECT id, email_verified FROM "user" WHERE email = 'alice@connect.test'`
    );
    expect(users).toHaveLength(1);
    expect(users[0].email_verified).toBe(true);
    const { rows: accounts } = await app.db.pool.query(
      `SELECT provider_id, account_id FROM account WHERE user_id = $1`,
      [users[0].id]
    );
    expect(accounts).toEqual([{ provider_id: 'antasphere', account_id: 'hub-cli-alice' }]);
    const { rows: ws } = await app.db.pool.query(
      `SELECT id, name FROM workspaces WHERE central_account_id = $1`,
      [ORG_ACME]
    );
    expect(ws).toHaveLength(1);
    expect(ws[0].name).toBe('Acme Corp');
    expect(body.workspaceId).toBe(ws[0].id);
    const { rows: members } = await app.db.pool.query(
      `SELECT role, origin, is_active FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
      [ws[0].id, users[0].id]
    );
    expect(members).toEqual([{ role: 'member', origin: 'hub', is_active: true }]);

    // The key row binds the projected workspace.
    const { rows: keys } = await app.db.pool.query(
      `SELECT workspace_id, scopes FROM api_keys WHERE created_by = $1`,
      [users[0].id]
    );
    expect(keys).toEqual([
      { workspace_id: ws[0].id, scopes: ['presentations:read', 'presentations:write'] }
    ]);

    // The audit row landed (principal-less route writes it directly).
    const { rows: audits } = await app.db.pool.query(
      `SELECT action, metadata FROM audit_log WHERE workspace_id = $1 AND action = 'apikey.create'`,
      [ws[0].id]
    );
    expect(audits).toHaveLength(1);
    expect(audits[0].metadata.via).toBe('sso_cli_connect');

    // JIT fired the single user.created seam exactly once.
    expect(created).toEqual([{ userId: users[0].id, email: 'alice@connect.test' }]);
    off();

    // The key WORKS as an ordinary machine credential in that workspace…
    const me = await app.app.request('/api/v1/me', {
      headers: { authorization: `Bearer ${body.key}` }
    });
    expect(me.status).toBe(200);
    const meBody = await readJson(me);
    expect(meBody.workspace.id).toBe(ws[0].id);
    expect(meBody.via).toBe('api_key');

    // …and CANNOT reach the export surface (no data:export, ever).
    const exportRes = await app.app.request('/api/v1/workspace/export', {
      headers: { authorization: `Bearer ${body.key}` }
    });
    expect(exportRes.status).toBe(403);
    expect((await readJson(exportRes)).error.code).toBe('insufficient_scope');
  });

  it('a returning user: no second user/account/membership, a second key, no user.created', async () => {
    const created: unknown[] = [];
    const off = app.registry.events.on('user.created', (p) => {
      created.push(p);
    });
    const { token } = await hub.signConnectToken(alice, RESOURCE);
    const res = await connect(app, token);
    expect(res.status).toBe(201);
    off();
    expect(created).toEqual([]);

    const { rows: users } = await app.db.pool.query(
      `SELECT id FROM "user" WHERE email = 'alice@connect.test'`
    );
    expect(users).toHaveLength(1);
    const { rows: accounts } = await app.db.pool.query(
      `SELECT account_id FROM account WHERE user_id = $1`,
      [users[0].id]
    );
    expect(accounts).toHaveLength(1);
    const { rows: keys } = await app.db.pool.query(
      `SELECT id FROM api_keys WHERE created_by = $1`,
      [users[0].id]
    );
    expect(keys).toHaveLength(2); // first test's key + this one
  });

  it('interleaves with browser SSO login without duplicating rows (same projection path)', async () => {
    // Bob enters via cli-connect first…
    const bob: HubUserFixture = {
      sub: 'hub-cli-bob',
      email: 'bob@connect.test',
      workspaceId: ORG_BETA,
      role: 'owner',
      workspaceName: 'Beta GmbH'
    };
    const { token } = await hub.signConnectToken(bob, RESOURCE);
    const res = await connect(app, token);
    expect(res.status).toBe(201);
    const body = await readJson(res);

    // …then logs in via the browser SSO dance: same user, same account
    // link, same projected workspace, still exactly one membership row.
    const cookie = await sso.ssoLogin(app, hub, bob);
    const me = await readJson(await app.app.request('/api/v1/me', { headers: { cookie } }));
    expect(me.user.email).toBe('bob@connect.test');
    expect(me.activeWorkspaceId).toBe(body.workspaceId);

    const { rows: users } = await app.db.pool.query(
      `SELECT id FROM "user" WHERE email = 'bob@connect.test'`
    );
    expect(users).toHaveLength(1);
    const { rows: accounts } = await app.db.pool.query(
      `SELECT account_id FROM account WHERE user_id = $1 AND provider_id = 'antasphere'`,
      [users[0].id]
    );
    expect(accounts).toHaveLength(1);
    const { rows: ws } = await app.db.pool.query(
      `SELECT id FROM workspaces WHERE central_account_id = $1`,
      [ORG_BETA]
    );
    expect(ws).toHaveLength(1);
    const { rows: members } = await app.db.pool.query(
      `SELECT role, origin, is_active FROM workspace_members WHERE user_id = $1`,
      [users[0].id]
    );
    expect(members).toEqual([{ role: 'owner', origin: 'hub', is_active: true }]);
  });

  it('rejects a replayed jti within the TTL — one token mints exactly one key (G8)', async () => {
    const { token } = await hub.signConnectToken(alice, RESOURCE);
    const first = await connect(app, token);
    expect(first.status).toBe(201);

    const replay = await connect(app, token);
    expect(replay.status).toBe(401);
    expect((await readJson(replay)).error.code).toBe('invalid_token');

    // No key row appeared for the replay.
    const { rows: users } = await app.db.pool.query(
      `SELECT id FROM "user" WHERE email = 'alice@connect.test'`
    );
    const { rows: keys } = await app.db.pool.query(
      `SELECT id FROM api_keys WHERE created_by = $1`,
      [users[0].id]
    );
    expect(keys).toHaveLength(3); // the two earlier suite keys + first, NOT replay
  });

  it('two CONCURRENT presentations of one token mint exactly one key', async () => {
    const carol: HubUserFixture = {
      sub: 'hub-cli-carol',
      email: 'carol@connect.test',
      workspaceId: ORG_ACME,
      role: 'member'
    };
    const { token } = await hub.signConnectToken(carol, RESOURCE);
    const [a, b] = await Promise.all([connect(app, token), connect(app, token)]);
    expect([a.status, b.status].sort()).toEqual([201, 401]);

    const { rows: users } = await app.db.pool.query(
      `SELECT id FROM "user" WHERE email = 'carol@connect.test'`
    );
    expect(users).toHaveLength(1);
    const { rows: keys } = await app.db.pool.query(
      `SELECT id FROM api_keys WHERE created_by = $1`,
      [users[0].id]
    );
    expect(keys).toHaveLength(1);
  });

  describe('the fail-closed negative space (uniform 401, no key minted)', () => {
    const mallory: HubUserFixture = {
      sub: 'hub-cli-mallory',
      email: 'mallory@connect.test',
      workspaceId: ORG_ACME,
      role: 'member'
    };

    async function expectRejected(token: string): Promise<void> {
      const res = await connect(app, token);
      expect(res.status).toBe(401);
      expect((await readJson(res)).error.code).toBe('invalid_token');
      const { rows } = await app.db.pool.query(`SELECT id FROM "user" WHERE email = $1`, [
        mallory.email
      ]);
      expect(rows).toHaveLength(0); // nothing provisioned, ever
    }

    it('rejects a token missing the purpose claim', async () => {
      const { token } = await hub.signConnectToken(mallory, RESOURCE, { purpose: null });
      await expectRejected(token);
    });

    it('rejects a wrong purpose', async () => {
      const { token } = await hub.signConnectToken(mallory, RESOURCE, { purpose: 'sso-login' });
      await expectRejected(token);
    });

    it('rejects a flow-(a) hub ACCESS token (right iss/aud, no purpose/jti)', async () => {
      const accessToken = await hub.signAccessToken(mallory, RESOURCE);
      await expectRejected(accessToken);
    });

    it('rejects a token audienced for another tool', async () => {
      const { token } = await hub.signConnectToken(
        { ...mallory, overrides: { accessAud: 'https://other-tool.test/mcp' } },
        RESOURCE
      );
      await expectRejected(token);
    });

    it('rejects a foreign issuer (covers any token this instance minted itself)', async () => {
      const { token } = await hub.signConnectToken(
        { ...mallory, overrides: { iss: 'http://localhost:3000' } },
        RESOURCE
      );
      await expectRejected(token);
    });

    it('rejects an expired token', async () => {
      const { token } = await hub.signConnectToken(
        { ...mallory, overrides: { expiresInSeconds: -60 } },
        RESOURCE
      );
      await expectRejected(token);
    });

    it('rejects a token without a jti', async () => {
      const { token } = await hub.signConnectToken(mallory, RESOURCE, { omitJti: true });
      await expectRejected(token);
    });

    it('rejects an unknown hub role claim (D11: derived, never mapped)', async () => {
      const { token } = await hub.signConnectToken({ ...mallory, role: 'superowner' }, RESOURCE);
      await expectRejected(token);
    });

    it('rejects a garbage body token', async () => {
      await expectRejected('x'.repeat(64));
    });
  });

  it('rides the login rate-limit wall (per IP)', async () => {
    const ip = sso.nextIp();
    // The login wall is 10/15min per key; burn the bucket with rejects.
    for (let i = 0; i < 10; i++) {
      const res = await connect(app, 'x'.repeat(64), ip);
      expect([401, 429]).toContain(res.status);
    }
    const eleventh = await connect(app, 'x'.repeat(64), ip);
    expect(eleventh.status).toBe(429);
  });

  it('refuses the trusted link onto an UNVERIFIED local email (403, no key)', async () => {
    // Park an unverified local account (a workspace invitation acceptance
    // path would create one); the connect must refuse rather than take it
    // over — the pre-registration-takeover posture, same as browser SSO.
    const { rows: owner } = await app.db.pool.query(`SELECT id FROM "user" WHERE email = $1`, [
      OWNER.email
    ]);
    await app.db.pool.query(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
       VALUES ('parked-user-1', 'Parked', 'parked@connect.test', false, now(), now())`
    );
    expect(owner).toHaveLength(1); // sanity: setup ran
    const { token } = await hub.signConnectToken(
      { sub: 'hub-cli-parked', email: 'parked@connect.test', workspaceId: ORG_ACME, role: 'member' },
      RESOURCE
    );
    const res = await connect(app, token);
    expect(res.status).toBe(403);
    expect((await readJson(res)).error.code).toBe('sso_link_refused');
    const { rows: keys } = await app.db.pool.query(
      `SELECT id FROM api_keys WHERE created_by = 'parked-user-1'`
    );
    expect(keys).toHaveLength(0);
  });

  it('links onto a VERIFIED local account of the same email (the D9 operator path)', async () => {
    // The setup operator's email is verified — a connect asserting it links
    // instead of duplicating, exactly like the browser SSO trusted link.
    const { token } = await hub.signConnectToken(
      { sub: 'hub-cli-operator', email: OWNER.email, workspaceId: ORG_ACME, role: 'admin' },
      RESOURCE
    );
    const res = await connect(app, token);
    expect(res.status).toBe(201);
    const { rows: users } = await app.db.pool.query(`SELECT id FROM "user" WHERE email = $1`, [
      OWNER.email
    ]);
    expect(users).toHaveLength(1); // still one local user
    const { rows: accounts } = await app.db.pool.query(
      `SELECT account_id FROM account WHERE user_id = $1 AND provider_id = 'antasphere'`,
      [users[0].id]
    );
    expect(accounts).toEqual([{ account_id: 'hub-cli-operator' }]);
    // The hub-asserted role landed on the projected org's membership; the
    // operator's own setup workspace membership is untouched.
    const { rows: members } = await app.db.pool.query(
      `SELECT wm.role, wm.origin FROM workspace_members wm
       JOIN workspaces w ON w.id = wm.workspace_id
       WHERE wm.user_id = $1 AND w.central_account_id = $2`,
      [users[0].id, ORG_ACME]
    );
    expect(members).toEqual([{ role: 'admin', origin: 'hub' }]);
  });

  it('burns the jti even when provisioning later refuses (claim-first, safe side)', async () => {
    // The parked-user conflict from above still refuses — and re-presenting
    // the SAME token now dies at the replay wall (401), proving claim-first.
    const { token } = await hub.signConnectToken(
      { sub: 'hub-cli-parked', email: 'parked@connect.test', workspaceId: ORG_ACME, role: 'member' },
      RESOURCE
    );
    const first = await connect(app, token);
    expect(first.status).toBe(403);
    const replay = await connect(app, token);
    expect(replay.status).toBe(401);
  });
});

describe('oss edition: the route does not exist', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp(await createDatabase(container, 'sso_cli_connect_oss'));
    const res = await app.app.request('/api/v1/setup', json({ instanceName: 'OSS', owner: OWNER }));
    expect(res.status).toBe(201);
  });

  afterAll(async () => {
    await app.stop();
  });

  it('answers the JSON 404 terminator for a well-formed exchange request', async () => {
    const { token } = await hub.signConnectToken(
      { sub: 'hub-oss-x', email: 'x@oss.test', workspaceId: ORG_ACME, role: 'member' },
      RESOURCE
    );
    const res = await connect(app, token);
    expect(res.status).toBe(404);
    expect((await readJson(res)).error.code).toBe('not_found');
    // Nothing provisioned, nothing minted.
    const { rows } = await app.db.pool.query(`SELECT id FROM "user" WHERE email = 'x@oss.test'`);
    expect(rows).toHaveLength(0);
  });

  it('does not advertise the route in the OpenAPI document', async () => {
    const doc = await readJson(await app.app.request('/api/v1/openapi.json'));
    expect(doc.paths['/sso/cli-connect']).toBeUndefined();
  });
});

describe('cloud edition: the OpenAPI document advertises the route', () => {
  it('serves /sso/cli-connect in paths', async () => {
    const app = await createTestApp(await createDatabase(container, 'sso_cli_connect_doc'), cloudEnv());
    try {
      const doc = await readJson(await app.app.request('/api/v1/openapi.json'));
      expect(doc.paths['/sso/cli-connect']).toBeDefined();
    } finally {
      await app.stop();
    }
  });
});
