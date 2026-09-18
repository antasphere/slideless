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
import { oauthBearer } from './sso-helpers.js';

/**
 * POST /api/v1/workspaces on the SELF-HOSTED edition (PRDCT-2444): the happy
 * path, every refusal, the per-user cap under a concurrent burst, the audit
 * placement (the NEW workspace hears of it, the one the person was in does
 * NOT), idempotent replay, and `/me.canCreateWorkspace` agreeing with the
 * route at every step.
 */
const OWNER = { email: 'owner@wscreate.test', name: 'Olive Owner', password: 'olive-owner-password-123' };
const MEMBER = { email: 'member@wscreate.test', name: 'Mia Member', password: 'mia-member-password-1234' };
const GUEST = { email: 'guest@wscreate.test', name: 'Gus Guest', password: 'gus-guest-password-12345' };
const MIXED = { email: 'mixed@wscreate.test', name: 'Max Mixed', password: 'max-mixed-password-12345' };

const WS_HEADER = 'x-workspace-id';
const CAP = 3;

let container: StartedPostgreSqlContainer;
let app: TestApp;
let w1 = '';
let ownerCookie = '';
let memberCookie = '';
let guestCookie = '';
let mixedCookie = '';

let ipCounter = 0;
const nextIp = () => `10.61.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

const post = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp(), ...headers },
  body: JSON.stringify(body)
});

async function signIn(target: TestApp, email: string, password: string): Promise<string> {
  const res = await target.app.request('/api/v1/auth/sign-in/email', post({ email, password }));
  expect(res.status).toBe(200);
  return extractCookie(res);
}

async function userId(email: string): Promise<string> {
  const res = await app.db.pool.query(`SELECT id FROM "user" WHERE email = $1`, [email]);
  return res.rows[0].id as string;
}

async function addMember(
  who: { email: string; name: string; password: string },
  workspaceId: string,
  origin: 'local' | 'guest',
  role: 'member' | 'owner' = 'member'
): Promise<void> {
  const existing = await app.db.pool.query(`SELECT id FROM "user" WHERE email = $1`, [who.email]);
  const id =
    (existing.rows[0]?.id as string | undefined) ?? (await app.auth.api.signUpEmail({ body: who })).user.id;
  await app.db.pool.query(
    `INSERT INTO workspace_members (workspace_id, user_id, role, origin, is_active) VALUES ($1, $2, $3, $4, true)`,
    [workspaceId, id, role, origin]
  );
}

const create = (cookie: string, name: unknown, headers: Record<string, string> = {}) =>
  app.app.request('/api/v1/workspaces', post({ name }, { cookie, ...headers }));

const canCreate = async (cookie: string, workspace?: string): Promise<boolean> => {
  const res = await app.app.request('/api/v1/me', {
    headers: { cookie, ...(workspace ? { [WS_HEADER]: workspace } : {}) }
  });
  expect(res.status).toBe(200);
  return (await readJson(res)).canCreateWorkspace as boolean;
};

beforeAll(async () => {
  container = await startPostgres();
  app = await createTestApp(await createDatabase(container, 'ws_create'), {
    MAX_WORKSPACES_PER_USER: String(CAP)
  });
  const setup = await app.app.request(
    '/api/v1/setup',
    post({ setupToken: 'integration-test-setup-token', instanceName: 'First', owner: OWNER })
  );
  expect(setup.status).toBe(201);
  w1 = (await readJson(setup)).workspaceId;
  ownerCookie = await signIn(app, OWNER.email, OWNER.password);

  await addMember(MEMBER, w1, 'local');
  memberCookie = await signIn(app, MEMBER.email, MEMBER.password);
  await addMember(GUEST, w1, 'guest');
  guestCookie = await signIn(app, GUEST.email, GUEST.password);
}, 240_000);

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

describe('POST /workspaces — self-hosted', () => {
  let created = '';

  it('a plain member creates a workspace and becomes its ACTIVE LOCAL OWNER', async () => {
    expect(await canCreate(memberCookie)).toBe(true);
    const res = await create(memberCookie, '  Mia’s studio  ');
    expect(res.status).toBe(201);
    const body = await readJson(res);
    expect(body).toEqual({ workspace: { id: expect.any(String), name: 'Mia’s studio' } }); // trimmed
    created = body.workspace.id;
    expect(created).not.toBe(w1);

    const rows = await app.db.pool.query(
      `SELECT role, origin, is_active FROM workspace_members WHERE workspace_id = $1`,
      [created]
    );
    expect(rows.rows).toEqual([{ role: 'owner', origin: 'local', is_active: true }]);
    const ws = await app.db.pool.query(`SELECT name, central_account_id FROM workspaces WHERE id = $1`, [
      created
    ]);
    expect(ws.rows[0]).toEqual({ name: 'Mia’s studio', central_account_id: null });

    // /me lists it, and the header selects it with the owner role.
    const me = await readJson(
      await app.app.request('/api/v1/me', { headers: { cookie: memberCookie, [WS_HEADER]: created } })
    );
    expect(me.activeWorkspaceId).toBe(created);
    expect(me.role).toBe('owner');
    expect(me.workspaces.map((w: { id: string }) => w.id)).toEqual([w1, created]);
  });

  it('audits workspace.create in the NEW workspace only — the one the person was in hears nothing', async () => {
    const mine = await app.db.pool.query(
      `SELECT action, actor_user_id, actor_via, resource_type, resource_id, metadata
         FROM audit_log WHERE workspace_id = $1`,
      [created]
    );
    expect(mine.rows).toEqual([
      {
        action: 'workspace.create',
        actor_user_id: await userId(MEMBER.email),
        actor_via: 'session',
        resource_type: 'workspace',
        resource_id: created,
        metadata: { name: 'Mia’s studio' }
      }
    ]);
    // Nothing anywhere else mentions it: not by action, not by path, not by id.
    const elsewhere = await app.db.pool.query(
      `SELECT id FROM audit_log
        WHERE (workspace_id IS DISTINCT FROM $1::uuid)
          AND (action ILIKE '%workspace%' OR resource_id = $1::text OR metadata::text ILIKE '%' || $1::text || '%')`,
      [created]
    );
    expect(elsewhere.rows).toEqual([]);
    // …and W1's owner cannot read it through the API either.
    const audit = await readJson(
      await app.app.request('/api/v1/audit', { headers: { cookie: ownerCookie } })
    );
    expect(JSON.stringify(audit)).not.toContain(created);
    expect(JSON.stringify(audit)).not.toContain('workspace.create');
  });

  it('400 on a name that is blank once trimmed, on a missing name, and on a control character', async () => {
    for (const name of ['   ', '', undefined, 'bad\u0000name', 'x'.repeat(121)]) {
      const res = await create(memberCookie, name);
      expect(res.status).toBe(400);
      expect((await readJson(res)).error.code).toBe('validation_error');
    }
  });

  it('401 without a session', async () => {
    const res = await app.app.request('/api/v1/workspaces', post({ name: 'Nope' }));
    expect(res.status).toBe(401);
  });

  it('401 for a session whose user holds NO active membership (not a member of this instance)', async () => {
    const stray = { email: 'stray@wscreate.test', name: 'Stray', password: 'stray-user-password-123' };
    await app.auth.api.signUpEmail({ body: stray });
    const cookie = await signIn(app, stray.email, stray.password);
    const res = await create(cookie, 'Squat');
    expect(res.status).toBe(401);
    const count = await app.db.pool.query(`SELECT count(*)::int AS n FROM workspaces WHERE name = 'Squat'`);
    expect(count.rows[0].n).toBe(0);
  });

  it('403 guest_forbidden for a guest-only user, and /me says so', async () => {
    expect(await canCreate(guestCookie)).toBe(false);
    const res = await create(guestCookie, 'Guest land');
    expect(res.status).toBe(403);
    expect((await readJson(res)).error.code).toBe('guest_forbidden');
  });

  it('a guest SOMEWHERE who is a real member ELSEWHERE may create — from either workspace', async () => {
    const other = (await app.registry.workspaces.create('Other', await userId(OWNER.email))).workspaceId;
    await addMember(MIXED, w1, 'guest');
    await addMember(MIXED, other, 'local');
    mixedCookie = await signIn(app, MIXED.email, MIXED.password);
    // Active workspace = W1, where they are a guest: still allowed, it is a
    // fact about the person.
    expect(await canCreate(mixedCookie, w1)).toBe(true);
    const res = await create(mixedCookie, 'Mixed’s own', { [WS_HEADER]: w1 });
    expect(res.status).toBe(201);
  });

  it('machine credentials are refused: API key and OAuth bearer, both 403, nothing created', async () => {
    const minted = await readJson(
      await app.app.request(
        '/api/v1/api-keys',
        post(
          { name: 'all-scopes', scopes: ['presentations:read', 'presentations:write', 'data:export'] },
          { cookie: ownerCookie }
        )
      )
    );
    const byKey = await app.app.request(
      '/api/v1/workspaces',
      post({ name: 'By key' }, { authorization: `Bearer ${minted.key}` })
    );
    expect(byKey.status).toBe(403);
    expect((await readJson(byKey)).error.code).toBe('endpoint_not_allowed');

    const bearer = await oauthBearer(app, ownerCookie);
    const byToken = await app.app.request(
      '/api/v1/workspaces',
      post({ name: 'By token' }, { authorization: `Bearer ${bearer}` })
    );
    expect(byToken.status).toBe(403);
    expect((await readJson(byToken)).error.code).toBe('endpoint_not_allowed');

    // The flag is false for a machine credential too.
    const me = await readJson(
      await app.app.request('/api/v1/me', { headers: { authorization: `Bearer ${minted.key}` } })
    );
    expect(me.canCreateWorkspace).toBe(false);

    const count = await app.db.pool.query(
      `SELECT count(*)::int AS n FROM workspaces WHERE name IN ('By key', 'By token')`
    );
    expect(count.rows[0].n).toBe(0);
  });

  it('is not reachable through /mcp: no tool creates a workspace', async () => {
    const bearer = await oauthBearer(app, ownerCookie);
    const res = await app.app.request('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${bearer}`
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    });
    expect(res.status).toBe(200);
    const names = ((await readJson(res)).result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((n) => /workspace/i.test(n) && /creat|new|add/i.test(n))).toEqual([]);
  });

  it('replays an Idempotency-Key instead of creating twice; a different body 409s', async () => {
    const before = await app.db.pool.query(`SELECT count(*)::int AS n FROM workspaces`);
    const first = await create(ownerCookie, 'Once', { 'idempotency-key': 'ws-once' });
    expect(first.status).toBe(201);
    const again = await create(ownerCookie, 'Once', { 'idempotency-key': 'ws-once' });
    expect(again.status).toBe(201);
    expect(again.headers.get('idempotency-replayed')).toBe('true');
    expect((await readJson(again)).workspace.id).toBe((await readJson(first)).workspace.id);
    const reuse = await create(ownerCookie, 'Twice', { 'idempotency-key': 'ws-once' });
    expect(reuse.status).toBe(409);
    const after = await app.db.pool.query(`SELECT count(*)::int AS n FROM workspaces`);
    expect(after.rows[0].n).toBe(before.rows[0].n + 1);
  });

  it('caps OWNED workspaces per user: a concurrent burst never passes the cap, then 403 workspace_limit_reached', async () => {
    // MEMBER owns 1 (created above); the cap is 3. Fire 6 at once.
    const owned = async () =>
      (
        await app.db.pool.query(
          `SELECT count(*)::int AS n FROM workspace_members
            WHERE user_id = $1 AND role = 'owner' AND is_active`,
          [await userId(MEMBER.email)]
        )
      ).rows[0].n as number;
    expect(await owned()).toBe(1);
    const burst = await Promise.all(Array.from({ length: 6 }, (_, i) => create(memberCookie, `Burst ${i}`)));
    const statuses = burst.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 201, 403, 403, 403, 403]);
    for (const res of burst.filter((r) => r.status === 403)) {
      expect((await readJson(res)).error.code).toBe('workspace_limit_reached');
    }
    expect(await owned()).toBe(CAP);
    expect(await canCreate(memberCookie)).toBe(false);

    // The cap counts OWNED workspaces only: memberships elsewhere are free,
    // and another person is unaffected.
    expect(await canCreate(mixedCookie)).toBe(true);
  });

  it('a deactivated owner membership stops counting; the cap is per person', async () => {
    const id = await userId(MEMBER.email);
    // Hand one of Mia's workspaces a second owner, then deactivate Mia there.
    const mine = await app.db.pool.query(
      `SELECT workspace_id FROM workspace_members WHERE user_id = $1 AND role = 'owner' LIMIT 1`,
      [id]
    );
    const target = mine.rows[0].workspace_id as string;
    await addMember(OWNER, target, 'local', 'owner');
    await app.db.pool.query(
      `UPDATE workspace_members SET is_active = false WHERE workspace_id = $1 AND user_id = $2`,
      [target, id]
    );
    expect(await canCreate(memberCookie)).toBe(true);
    expect((await create(memberCookie, 'Room again')).status).toBe(201);
    expect((await create(memberCookie, 'Over')).status).toBe(403);
  });
});

describe('MAX_WORKSPACES_PER_USER=0 closes creation for everyone', () => {
  let closed: TestApp;
  let cookie = '';

  beforeAll(async () => {
    closed = await createTestApp(await createDatabase(container, 'ws_create_closed'), {
      MAX_WORKSPACES_PER_USER: '0'
    });
    const setup = await closed.app.request(
      '/api/v1/setup',
      post({ setupToken: 'integration-test-setup-token', instanceName: 'Closed', owner: OWNER })
    );
    expect(setup.status).toBe(201);
    cookie = await signIn(closed, OWNER.email, OWNER.password);
  }, 240_000);

  afterAll(async () => {
    await closed?.stop();
  });

  it('403 workspace_creation_disabled even for the instance owner, and /me answers false', async () => {
    const res = await closed.app.request('/api/v1/workspaces', post({ name: 'Nope' }, { cookie }));
    expect(res.status).toBe(403);
    expect((await readJson(res)).error.code).toBe('workspace_creation_disabled');
    const me = await readJson(await closed.app.request('/api/v1/me', { headers: { cookie } }));
    expect(me.canCreateWorkspace).toBe(false);
    const count = await closed.db.pool.query(`SELECT count(*)::int AS n FROM workspaces`);
    expect(count.rows[0].n).toBe(1);
  });
  it('is walled: 60 attempts per hour per IP and per user, then 429 — refused attempts count too', async () => {
    const headers = { cookie, 'x-forwarded-for': '10.63.0.1' };
    const statuses: number[] = [];
    for (let i = 0; i < 61; i++) {
      const res = await closed.app.request('/api/v1/workspaces', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ name: `Wall ${i}` })
      });
      statuses.push(res.status);
    }
    // The per-USER key already spent one point in the test above (another
    // IP, the same person): 59 more are judged, then the wall answers.
    expect(statuses.filter((st) => st === 403)).toHaveLength(59);
    expect(statuses.slice(59)).toEqual([429, 429]);
  });
});
