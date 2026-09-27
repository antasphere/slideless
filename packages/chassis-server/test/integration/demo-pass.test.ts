import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { workspaceMembers } from '@antasphere/chassis-db';
import { FakeHub } from '@antasphere/chassis-server/testing';
import {
  createDatabase,
  createTestApp,
  expectBootRefusal,
  extractCookie,
  readJson,
  startPostgres,
  type TestApp,
  host
} from './helpers.js';

/**
 * Demo sign-in (the demo pass spec): an owner mints a link that signs one
 * member in without a password. The link is sign-in-equivalent, so this suite
 * pins every boundary around it:
 *
 *   the switch      → off, every demo path is an unknown path, signed in or
 *                     not; on, only on a loopback or listed host; on cloud,
 *                     nothing at all
 *   the mint        → owner and session only, the refusals in the spec's
 *                     order, the secret stored as its sha256 and nowhere else
 *   the redeem      → the library's own session and cookie, AS THE MEMBER;
 *                     one answer for every refusal; Origin required; a wall
 *                     of 20 per address
 *   the trail       → mint, use and revoke rows with the right actor, no
 *                     secret anywhere, and a mutation made through a pass's
 *                     session marked with the pass
 */

const PASSWORD = 'a-long-demo-pass-password-1';
const ORIGIN = 'http://localhost:3000';
const OWNER = { email: 'owner@example.com', name: 'Olive Owner', password: PASSWORD };
const DEMO_ON = { DEMO_SIGN_IN: 'true' };

type Actor = { email: string; cookie: string; userId: string };

let container: StartedPostgreSqlContainer;
let connectionString = '';
let app: TestApp;
let workspaceId = '';
const actors: Record<string, Actor> = {};
/** Every secret this suite minted: none may ever appear in an audit row. */
const secrets: string[] = [];

let ipCounter = 0;
const nextIp = () => `10.88.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

const send = (
  target: TestApp,
  method: string,
  path: string,
  who: { cookie?: string; key?: string } = {},
  body?: unknown,
  headers: Record<string, string> = {}
) =>
  target.app.request(`/api/v1${path}`, {
    method,
    headers: {
      'x-forwarded-for': nextIp(),
      origin: ORIGIN,
      ...(who.cookie ? { cookie: who.cookie } : {}),
      ...(who.key ? { authorization: `Bearer ${who.key}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });

async function expectError(res: Response, status: number, code: string): Promise<void> {
  const body = await readJson(res);
  expect({ status: res.status, code: body?.error?.code }).toEqual({ status, code });
}

async function signIn(target: TestApp, email: string): Promise<string> {
  const res = await send(target, 'POST', '/auth/sign-in/email', {}, { email, password: PASSWORD });
  expect(res.status).toBe(200);
  return extractCookie(res);
}

async function addMember(
  name: string,
  email: string,
  opts: { role?: 'owner' | 'admin' | 'member'; origin?: 'local' | 'guest'; signIn?: boolean } = {}
): Promise<Actor> {
  const created = await app.auth.api.signUpEmail({ body: { email, password: PASSWORD, name } });
  await app.db.db.insert(workspaceMembers).values({
    workspaceId,
    userId: created.user.id,
    role: opts.role ?? 'member',
    origin: opts.origin ?? 'local'
  });
  const actor = {
    email,
    cookie: opts.signIn === false ? '' : await signIn(app, email),
    userId: created.user.id
  };
  actors[name] = actor;
  return actor;
}

async function mint(
  who: Actor,
  body: { email: string; path?: string; expiresInMinutes?: number },
  target: TestApp = app
): Promise<{ id: string; secret: string; url: string; pass: Record<string, unknown> }> {
  const res = await send(target, 'POST', '/demo/passes', who, body);
  expect(res.status).toBe(201);
  const minted = await readJson(res);
  secrets.push(minted.secret);
  return { id: minted.pass.id, secret: minted.secret, url: minted.url, pass: minted.pass };
}

const redeem = (secret: string, target: TestApp = app, headers: Record<string, string> = {}) =>
  send(target, 'POST', '/auth/demo/redeem', {}, { pass: secret }, headers);

/** True when a response sets the session cookie (any value, any attributes). */
const setsSession = (res: Response) => (res.headers.get('set-cookie') ?? '').includes('session_token');

/** Status and body of an answer, the request id apart (it is a header, never a body field). */
async function answerOf(res: Response): Promise<{ status: number; body: string }> {
  return { status: res.status, body: await res.text() };
}

beforeAll(async () => {
  container = await startPostgres();
  connectionString = await createDatabase(container, 'demo_pass');
  app = await createTestApp(connectionString, DEMO_ON);
  const setup = await send(
    app,
    'POST',
    '/setup',
    {},
    { setupToken: 'integration-test-setup-token', instanceName: 'Demo', owner: OWNER }
  );
  expect(setup.status).toBe(201);
  workspaceId = (await readJson(setup)).workspaceId;
  const ownerCookie = await signIn(app, OWNER.email);
  const me = await readJson(await send(app, 'GET', '/me', { cookie: ownerCookie }));
  actors.owner = { email: OWNER.email, cookie: ownerCookie, userId: me.user.id };

  await addMember('member', 'member@example.com');
  await addMember('admin', 'admin@example.com', { role: 'admin' });
  await addMember('otherOwner', 'other-owner@example.com', { role: 'owner' });
  await addMember('gmail', 'someone@gmail.com');
  await addMember('twoFactor', 'two-factor@example.com');
  await addMember('twoFactorGmail', 'two-factor@gmail.com');
  await addMember('guest', 'guest@example.org', { origin: 'guest' });
  await addMember('cross', 'cross@team.test');
  await app.db.pool.query(`UPDATE "user" SET two_factor_enabled = true WHERE email LIKE 'two-factor@%'`);
  // `cross` also owns a second workspace: a pass for them would carry into it.
  const second = await send(app, 'POST', '/workspaces', actors.cross!, { name: 'Elsewhere' });
  expect(second.status).toBe(201);
});

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the switch', () => {
  it('a. off: every demo path answers what an unknown path answers, signed out and signed in; /instance has no demoSignIn', async () => {
    const off = await createTestApp(connectionString);
    try {
      const ownerCookie = await signIn(off, OWNER.email);
      for (const who of [{}, { cookie: ownerCookie }]) {
        const unknownApi = await answerOf(
          await send(off, 'POST', '/definitely-not-a-route', who, { email: 'member@example.com' })
        );
        const unknownAuth = await answerOf(
          await send(off, 'POST', '/auth/definitely-not-a-route', who, { pass: 'x' })
        );
        expect(
          await answerOf(await send(off, 'POST', '/demo/passes', who, { email: 'member@example.com' }))
        ).toEqual(unknownApi);
        expect(await answerOf(await send(off, 'GET', '/demo/passes', who))).toEqual(unknownApi);
        expect(
          await answerOf(await send(off, 'DELETE', '/demo/passes/11111111-1111-4111-8111-111111111111', who))
        ).toEqual(unknownApi);
        expect(await answerOf(await redeem('x', off, who.cookie ? { cookie: who.cookie } : {}))).toEqual(
          unknownAuth
        );
      }
      const instance = await readJson(await send(off, 'GET', '/instance'));
      expect('demoSignIn' in instance).toBe(false);
      // …and on, the key is there.
      expect((await readJson(await send(app, 'GET', '/instance'))).demoSignIn).toBe(true);
    } finally {
      await off.stop();
    }
  });

  it('b. the boot refuses the switch on a public host nobody listed, and accepts loopback or a listed host', async () => {
    // The env parser's refusal is a printed table and process.exit(1): both
    // are stubbed so the refusal surfaces as a rejection carrying the table.
    let printed = '';
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      printed += args.map(String).join(' ');
    });
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${String(code)}): ${printed}`);
    });
    await expectBootRefusal(
      createTestApp(connectionString, { ...DEMO_ON, PUBLIC_BASE_URL: 'https://tool.example.io' }),
      /DEMO_SIGN_IN\s+DEMO_SIGN_IN is refused on tool\.example\.io/
    );
    printed = '';
    await expectBootRefusal(
      createTestApp(connectionString, { ...DEMO_ON, PUBLIC_BASE_URL: 'https://localhost.evil.test' }),
      /DEMO_SIGN_IN is refused on localhost\.evil\.test/
    );
    vi.restoreAllMocks();

    const listed = await createTestApp(connectionString, {
      ...DEMO_ON,
      PUBLIC_BASE_URL: 'https://tool.example.io',
      DEMO_SIGN_IN_HOSTS: 'tool.example.io'
    });
    await listed.stop();
    const subdomain = await createTestApp(connectionString, {
      ...DEMO_ON,
      PUBLIC_BASE_URL: 'http://app.localhost:3000'
    });
    await subdomain.stop();
  });

  it('l. cloud: with the switch on, every demo path is an unknown path and /instance has no demoSignIn', async () => {
    const hub = await FakeHub.start({ clientId: host.hubClientId });
    const cloud = await createTestApp(await createDatabase(container, 'demo_pass_cloud'), {
      ...DEMO_ON,
      EDITION: 'cloud',
      HUB_ISSUER_URL: hub.issuer,
      HUB_CLIENT_ID: host.hubClientId,
      HUB_CLIENT_SECRET: 'integration-test-hub-secret-0001'
    });
    try {
      const unknownApi = await answerOf(
        await send(cloud, 'POST', '/definitely-not-a-route', {}, { email: 'a' })
      );
      const unknownAuth = await answerOf(
        await send(cloud, 'POST', '/auth/definitely-not-a-route', {}, { pass: 'x' })
      );
      expect(await answerOf(await send(cloud, 'POST', '/demo/passes', {}, { email: 'a' }))).toEqual(
        unknownApi
      );
      expect(await answerOf(await send(cloud, 'GET', '/demo/passes'))).toEqual(unknownApi);
      expect(
        await answerOf(await send(cloud, 'DELETE', '/demo/passes/11111111-1111-4111-8111-111111111111'))
      ).toEqual(unknownApi);
      expect(await answerOf(await redeem('x', cloud))).toEqual(unknownAuth);
      expect('demoSignIn' in (await readJson(await send(cloud, 'GET', '/instance')))).toBe(false);
    } finally {
      await cloud.stop();
      await hub.stop();
    }
  });
});

describe('the mint', () => {
  it('c. an owner mints a pass for a member: 201, a 43-character secret stored only as its sha256, a fragment link', async () => {
    const minted = await mint(actors.owner!, { email: 'member@example.com', path: '/decks/1?x=1' });
    expect(minted.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(minted.url).toBe(`${ORIGIN}/demo#pass=${minted.secret}&to=${encodeURIComponent('/decks/1?x=1')}`);
    expect(minted.pass).toMatchObject({
      userId: actors.member!.userId,
      email: 'member@example.com',
      targetPath: '/decks/1?x=1',
      createdBy: actors.owner!.userId,
      revokedAt: null,
      useCount: 0
    });
    // Default lifetime: one day.
    const lifetime = Date.parse(String(minted.pass.expiresAt)) - Date.parse(String(minted.pass.createdAt));
    expect(Math.round(lifetime / 60_000)).toBe(1440);

    const { rows } = await app.db.pool.query(
      `SELECT *, row_to_json(p)::text AS json FROM demo_passes p WHERE id = $1`,
      [minted.id]
    );
    expect(rows[0].secret_hash).toBe(sha256(minted.secret));
    expect(rows[0].json).not.toContain(minted.secret);
    expect(rows[0].target_path).toBe('/decks/1?x=1');
  });

  it('d. the refusals, in the spec’s order', async () => {
    const owner = actors.owner!;
    // 1. nobody of this workspace holds the address
    await expectError(
      await send(app, 'POST', '/demo/passes', owner, { email: 'nobody@example.com' }),
      404,
      'no_such_member'
    );
    // 2. another owner
    await expectError(
      await send(app, 'POST', '/demo/passes', owner, { email: 'other-owner@example.com' }),
      403,
      'owner_target'
    );
    // …but the owner for themself is fine.
    await mint(owner, { email: OWNER.email });
    // 3. not a demonstration address (checked before the second factor)
    await expectError(
      await send(app, 'POST', '/demo/passes', owner, { email: 'someone@gmail.com' }),
      403,
      'demo_address_required'
    );
    await expectError(
      await send(app, 'POST', '/demo/passes', owner, { email: 'two-factor@gmail.com' }),
      403,
      'demo_address_required'
    );
    // 4. a second factor
    await expectError(
      await send(app, 'POST', '/demo/passes', owner, { email: 'two-factor@example.com' }),
      403,
      'two_factor_enrolled'
    );
    // 5. the shared credential-minting refusal
    await expectError(
      await send(app, 'POST', '/demo/passes', owner, { email: 'guest@example.org' }),
      403,
      'guest_target'
    );
    await expectError(
      await send(app, 'POST', '/demo/passes', owner, { email: 'cross@team.test' }),
      403,
      'cross_workspace_target'
    );
    // 6. the page and the lifetime
    for (const path of ['//evil', '/\\evil', 'decks', '/a#b', '/a b']) {
      await expectError(
        await send(app, 'POST', '/demo/passes', owner, { email: 'member@example.com', path }),
        400,
        'invalid_demo_path'
      );
    }
    for (const expiresInMinutes of [0, 10081]) {
      await expectError(
        await send(app, 'POST', '/demo/passes', owner, { email: 'member@example.com', expiresInMinutes }),
        400,
        'validation_error'
      );
    }
    await mint(owner, { email: 'member@example.com', expiresInMinutes: 10080 });

    // The operator names gmail.com: the same member is now a demonstration address.
    const widened = await createTestApp(connectionString, {
      ...DEMO_ON,
      DEMO_SIGN_IN_EMAIL_DOMAINS: 'gmail.com'
    });
    try {
      await mint(owner, { email: 'someone@gmail.com' }, widened);
    } finally {
      await widened.stop();
    }
  });

  it('e. an admin and a member are refused; an API key held by the owner reaches none of the three routes', async () => {
    for (const who of [actors.admin!, actors.member!]) {
      await expectError(
        await send(app, 'POST', '/demo/passes', who, { email: 'member@example.com' }),
        403,
        'forbidden'
      );
      await expectError(await send(app, 'GET', '/demo/passes', who), 403, 'forbidden');
    }
    const keyRes = await send(app, 'POST', '/api-keys', actors.owner!, {
      name: 'demo-key',
      scopes: [host.scopes.read, host.scopes.write]
    });
    expect(keyRes.status).toBe(201);
    const key = (await readJson(keyRes)).key as string;
    const byKey = [
      await send(app, 'POST', '/demo/passes', { key }, { email: 'member@example.com' }),
      await send(app, 'GET', '/demo/passes', { key }),
      await send(app, 'DELETE', '/demo/passes/11111111-1111-4111-8111-111111111111', { key })
    ];
    for (const res of byKey) expect(res.status).toBe(403);
  });
});

describe('the redeem', () => {
  it('f. signs the MEMBER in with the library’s own session cookie; two redeems, two sessions, use_count 2', async () => {
    const minted = await mint(actors.owner!, { email: 'member@example.com', path: '/decks' });
    const cookies: string[] = [];
    for (let i = 0; i < 2; i++) {
      const res = await redeem(minted.secret);
      expect(res.status).toBe(200);
      expect(res.headers.get('set-cookie')).toMatch(/better-auth\.session_token=/);
      const body = await readJson(res);
      expect(body).toEqual({
        user: { id: actors.member!.userId, email: 'member@example.com', name: 'member' },
        path: '/decks',
        expiresAt: minted.pass.expiresAt
      });
      cookies.push(extractCookie(res));
    }
    expect(cookies[0]).not.toBe(cookies[1]);
    for (const cookie of cookies) {
      const me = await readJson(await send(app, 'GET', '/me', { cookie }));
      expect(me.user.id).toBe(actors.member!.userId);
      expect(me.role).toBe('member');
      // An owner-only route stays closed to the member's session.
      await expectError(await send(app, 'GET', '/demo/passes', { cookie }), 403, 'forbidden');
    }
    const { rows } = await app.db.pool.query(
      `SELECT use_count, last_used_at FROM demo_passes WHERE id = $1`,
      [minted.id]
    );
    expect(rows[0].use_count).toBe(2);
    expect(rows[0].last_used_at).not.toBeNull();
    const sessions = await app.db.pool.query(
      `SELECT count(*)::int AS n FROM demo_pass_sessions WHERE pass_id = $1`,
      [minted.id]
    );
    expect(sessions.rows[0].n).toBe(2);
  });

  it('g. every refusal of a pass is the same 401 and sets no session', async () => {
    const owner = actors.owner!;
    const refusals: Array<{ status: number; body: string; sets: boolean }> = [];
    const collect = async (res: Response) =>
      refusals.push({ ...(await answerOf(res)), sets: setsSession(res) });

    // unknown
    await collect(await redeem('A'.repeat(43)));
    // expired
    const expired = await mint(owner, { email: 'member@example.com' });
    await app.db.pool.query(`UPDATE demo_passes SET expires_at = now() - interval '1 minute' WHERE id = $1`, [
      expired.id
    ]);
    await collect(await redeem(expired.secret));
    // revoked
    const revoked = await mint(owner, { email: 'member@example.com' });
    expect((await send(app, 'DELETE', `/demo/passes/${revoked.id}`, owner)).status).toBe(200);
    await collect(await redeem(revoked.secret));
    // the member removed from the workspace
    const gone = await addMember('gone', 'gone@example.com', { signIn: false });
    const goneMint = await mint(owner, { email: gone.email });
    await app.db.pool.query(`DELETE FROM workspace_members WHERE user_id = $1`, [gone.userId]);
    await collect(await redeem(goneMint.secret));
    // a second factor enrolled after the mint
    const late = await addMember('late', 'late-two-factor@example.com', { signIn: false });
    const lateMint = await mint(owner, { email: late.email });
    await app.db.pool.query(`UPDATE "user" SET two_factor_enabled = true WHERE id = $1`, [late.userId]);
    await collect(await redeem(lateMint.secret));
    // the domain taken off the operator's list: minted where gmail.com was
    // listed, redeemed where it no longer is (the same database)
    const widened = await createTestApp(connectionString, {
      ...DEMO_ON,
      DEMO_SIGN_IN_EMAIL_DOMAINS: 'gmail.com'
    });
    let gmailSecret = '';
    try {
      gmailSecret = (await mint(owner, { email: 'someone@gmail.com' }, widened)).secret;
    } finally {
      await widened.stop();
    }
    await collect(await redeem(gmailSecret));

    expect(refusals).toHaveLength(6);
    for (const refusal of refusals) {
      expect(refusal).toEqual({
        status: 401,
        body: JSON.stringify({
          error: { code: 'invalid_demo_pass', message: 'This demo link is not valid' }
        }),
        sets: false
      });
    }
  });

  it('h. no Origin: 403 and no cookie; a foreign Origin: refused and no cookie', async () => {
    const minted = await mint(actors.owner!, { email: 'member@example.com' });
    const noOrigin = await app.app.request('/api/v1/auth/demo/redeem', {
      method: 'POST',
      headers: { 'x-forwarded-for': nextIp(), 'content-type': 'application/json' },
      body: JSON.stringify({ pass: minted.secret })
    });
    await expectError(noOrigin, 403, 'cross_site_forbidden');
    expect(setsSession(noOrigin)).toBe(false);

    const foreign = await redeem(minted.secret, app, { origin: 'https://evil.test' });
    expect(foreign.status).toBe(403);
    expect(setsSession(foreign)).toBe(false);

    // Neither spent the pass.
    const { rows } = await app.db.pool.query(`SELECT use_count FROM demo_passes WHERE id = $1`, [minted.id]);
    expect(rows[0].use_count).toBe(0);
  });

  it('i. the wall: the 21st redeem from one address in the window answers 429', async () => {
    const address = { 'x-forwarded-for': '10.99.0.1' };
    for (let i = 0; i < 20; i++) {
      expect((await redeem('B'.repeat(43), app, address)).status).toBe(401);
    }
    await expectError(await redeem('B'.repeat(43), app, address), 429, 'rate_limited');
    // Another address is untouched.
    expect((await redeem('B'.repeat(43), app, { 'x-forwarded-for': '10.99.0.2' })).status).toBe(401);
  });
});

describe('the trail and the owner’s list', () => {
  it('j. mint, use and revoke rows with the right actor, no secret or hash anywhere, and a pass session’s mutation marked', async () => {
    const owner = actors.owner!;
    const minted = await mint(owner, { email: 'member@example.com' });
    const redeemed = await redeem(minted.secret);
    expect(redeemed.status).toBe(200);
    const passCookie = extractCookie(redeemed);
    expect((await send(app, 'DELETE', `/demo/passes/${minted.id}`, owner)).status).toBe(200);

    const rowsOf = async (action: string) =>
      (
        await app.db.pool.query(
          `SELECT actor_user_id, actor_via, workspace_id, resource_type, metadata FROM audit_log
            WHERE action = $1 AND resource_id = $2`,
          [action, minted.id]
        )
      ).rows;
    const [mintRow] = await rowsOf('demo_pass.mint');
    expect(mintRow).toMatchObject({
      actor_user_id: owner.userId,
      actor_via: 'session',
      workspace_id: workspaceId,
      resource_type: 'demo_pass',
      metadata: { targetUserId: actors.member!.userId, targetPath: '/', expiresAt: minted.pass.expiresAt }
    });
    const [useRow] = await rowsOf('demo_pass.use');
    expect(useRow).toMatchObject({
      actor_user_id: actors.member!.userId,
      actor_via: 'session',
      workspace_id: workspaceId,
      metadata: { passId: minted.id }
    });
    const [revokeRow] = await rowsOf('demo_pass.revoke');
    expect(revokeRow).toMatchObject({ actor_user_id: owner.userId, resource_type: 'demo_pass' });

    // A mutation a member may make, once through the pass's session (the
    // pass is revoked now, but the session it opened lives on), once
    // through the member's own password session.
    const viaPass = await send(
      app,
      'POST',
      '/projects',
      { cookie: passCookie },
      { name: 'Through the demo link' }
    );
    expect(viaPass.status).toBe(201);
    const viaPassId = (await readJson(viaPass)).id;
    const viaPassword = await send(app, 'POST', '/projects', actors.member!, { name: 'By hand' });
    expect(viaPassword.status).toBe(201);
    const viaPasswordId = (await readJson(viaPassword)).id;
    const metadataOf = async (projectId: string) =>
      (
        await app.db.pool.query(
          `SELECT metadata, actor_user_id FROM audit_log WHERE action = 'project.create' AND resource_id = $1`,
          [projectId]
        )
      ).rows[0];
    const marked = await metadataOf(viaPassId);
    expect(marked.actor_user_id).toBe(actors.member!.userId);
    expect(marked.metadata.demoPassId).toBe(minted.id);
    const unmarked = await metadataOf(viaPasswordId);
    expect(unmarked.actor_user_id).toBe(actors.member!.userId);
    expect(unmarked.metadata?.demoPassId).toBeUndefined();

    // No audit row anywhere carries a secret this suite minted, or its hash.
    const { rows: all } = await app.db.pool.query(`SELECT row_to_json(a)::text AS json FROM audit_log a`);
    const trail = all.map((r: { json: string }) => r.json).join('\n');
    expect(secrets.length).toBeGreaterThan(5);
    for (const secret of secrets) {
      expect(trail).not.toContain(secret);
      expect(trail).not.toContain(sha256(secret));
    }
  });

  it('k. revoke is idempotent, another workspace’s pass is 404, and the list never carries a secret', async () => {
    const owner = actors.owner!;
    const minted = await mint(owner, { email: 'member@example.com' });
    const first = await readJson(await send(app, 'DELETE', `/demo/passes/${minted.id}`, owner));
    expect(first.revokedAt).not.toBeNull();
    const again = await send(app, 'DELETE', `/demo/passes/${minted.id}`, owner);
    expect(again.status).toBe(200);
    expect((await readJson(again)).revokedAt).toBe(first.revokedAt);

    // A pass of `cross`'s other workspace, written in place.
    const { rows: elsewhere } = await app.db.pool.query(
      `SELECT workspace_id FROM workspace_members WHERE user_id = $1 AND workspace_id <> $2`,
      [actors.cross!.userId, workspaceId]
    );
    const { rows: foreign } = await app.db.pool.query(
      `INSERT INTO demo_passes (workspace_id, user_id, secret_hash, expires_at)
       VALUES ($1, $2, $3, now() + interval '1 day') RETURNING id`,
      [elsewhere[0].workspace_id, actors.cross!.userId, sha256('elsewhere')]
    );
    await expectError(await send(app, 'DELETE', `/demo/passes/${foreign[0].id}`, owner), 404, 'not_found');
    await expectError(await send(app, 'DELETE', '/demo/passes/not-a-uuid', owner), 400, 'validation_error');

    const listRes = await send(app, 'GET', '/demo/passes', owner);
    expect(listRes.status).toBe(200);
    const text = await listRes.text();
    const list = JSON.parse(text) as { passes: Array<{ id: string; createdAt: string }> };
    expect(list.passes.length).toBeGreaterThan(5);
    expect(list.passes.map((p) => p.id)).not.toContain(foreign[0].id);
    const created = list.passes.map((p) => Date.parse(p.createdAt));
    expect([...created].sort((a, b) => b - a)).toEqual(created);
    expect(text).not.toMatch(/secret/i);
    for (const secret of secrets) {
      expect(text).not.toContain(secret);
      expect(text).not.toContain(sha256(secret));
    }
  });
});
