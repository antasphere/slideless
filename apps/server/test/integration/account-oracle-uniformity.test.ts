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
 * PRDCT-1437 — the account-existence oracle, closed on both remaining doors.
 *
 * Door 1: minting a change-email link succeeds for ANY new address; consuming
 * it used to answer a raw 500 when the address already had an account
 * anywhere on the instance (the update died at the `user.email` UNIQUE
 * constraint) versus a 302 when it did not — a mint-then-consume oracle for
 * any owner, free on a "yes". The consume now answers the SAME observables on
 * both branches: 302 to the callback, a session cookie for the target, no
 * error param — the email just does not change on a collision.
 *
 * Door 2: the public invitation/collaborator lookups no longer carry
 * `accountExists` (asserted in their own suites); this file pins door 1.
 */

const OWNER = { email: 'owner@oracle.test', name: 'Oracle Owner', password: 'oracle-owner-pass-1' };
const MEMBER = { email: 'member@oracle.test', name: 'Oracle Member', password: 'oracle-member-pass-1' };
/** An account that exists on the instance but NOT in this workspace. */
const ELSEWHERE_EMAIL = 'elsewhere@oracle.test';

let container: StartedPostgreSqlContainer;
let app: TestApp;
let ownerCookie: string;
let memberId: string;

let ipCounter = 0;
const nextIp = () => `10.67.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp(), ...headers },
  body: JSON.stringify(body)
});

async function memberEmail(): Promise<string> {
  const { rows } = await app.db.pool.query<{ email: string }>(
    `SELECT u.email FROM "user" u JOIN workspace_members m ON m.user_id = u.id WHERE m.id = $1`,
    [memberId]
  );
  return rows[0]!.email;
}

/** Mint a change-email link for the member; must succeed (200). */
async function mint(newEmail: string): Promise<string> {
  const res = await app.app.request(
    `/api/v1/members/${memberId}/change-email-link`,
    json({ newEmail }, { cookie: ownerCookie })
  );
  expect(res.status).toBe(200);
  return (await readJson(res)).verifyUrl as string;
}

/** Consume a link logged out; returns the observables a prober could read. */
async function consume(verifyUrl: string): Promise<{
  status: number;
  location: string | null;
  hasSessionCookie: boolean;
  hasErrorParam: boolean;
}> {
  const res = await app.app.request(verifyUrl, { headers: { 'x-forwarded-for': nextIp() } });
  const location = res.headers.get('location');
  const setCookie = res.headers.get('set-cookie') ?? '';
  return {
    status: res.status,
    location,
    hasSessionCookie: /better-auth\.session_token=[^;]/.test(setCookie),
    hasErrorParam: (location ?? '').includes('error=')
  };
}

beforeAll(async () => {
  container = await startPostgres();
  app = await createTestApp(await createDatabase(container, 'oracle_uniform'));
  await app.app.request(
    '/api/v1/setup',
    json({ setupToken: 'integration-test-setup-token', instanceName: 'Oracle', owner: OWNER })
  );
  ownerCookie = extractCookie(
    await app.app.request(
      '/api/v1/auth/sign-in/email',
      json({ email: OWNER.email, password: OWNER.password })
    )
  );

  // The member whose email the owner "changes" while probing.
  const inv = await readJson(
    await app.app.request(
      '/api/v1/invitations',
      json({ email: MEMBER.email, role: 'member' }, { cookie: ownerCookie })
    )
  );
  const token = (inv.acceptUrl as string).split('/invite/')[1]!;
  expect(
    (
      await app.app.request(
        '/api/v1/invitations/accept',
        json({ token, name: MEMBER.name, password: MEMBER.password })
      )
    ).status
  ).toBe(200);
  const members = await readJson(
    await app.app.request('/api/v1/members', { headers: { cookie: ownerCookie } })
  );
  memberId = members.members.find((m: { email: string }) => m.email === MEMBER.email).id;

  // The probed address: an account that exists on the instance but holds no
  // membership in this workspace (another tenant's user, say) — so the mint's
  // workspace-scoped advisory pre-check does NOT catch it and the collision
  // would only surface at consumption, exactly the oracle's shape.
  await app.db.pool.query(
    `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
     VALUES ('oracle-elsewhere-user', 'Elsewhere', $1, true, now(), now())`,
    [ELSEWHERE_EMAIL]
  );
}, 120_000);

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

describe('the change-email consume answers uniformly (door 1)', () => {
  it('unused address and taken address produce identical observables; only the unused one changes the email', async () => {
    // Branch A — the "no account" case: the change goes through.
    const unusedUrl = await mint('fresh@oracle.test');
    const unused = await consume(unusedUrl);
    expect(unused.status).toBeGreaterThanOrEqual(300);
    expect(unused.status).toBeLessThan(400);
    expect(await memberEmail()).toBe('fresh@oracle.test');

    // Branch B — the "account exists elsewhere" case: same observables.
    const takenUrl = await mint(ELSEWHERE_EMAIL);
    const taken = await consume(takenUrl);

    expect(taken.status).toBe(unused.status);
    expect(taken.location).toBe(unused.location);
    expect(taken.hasErrorParam).toBe(false);
    expect(unused.hasErrorParam).toBe(false);
    expect(taken.hasSessionCookie).toBe(unused.hasSessionCookie);
    expect(taken.hasSessionCookie).toBe(true);

    // The collision changed nothing: the member keeps the branch-A address,
    // and the elsewhere account keeps its own.
    expect(await memberEmail()).toBe('fresh@oracle.test');
    const { rows } = await app.db.pool.query(`SELECT 1 FROM "user" WHERE email = $1`, [ELSEWHERE_EMAIL]);
    expect(rows.length).toBe(1);
  });

  it('never answers 5xx on the consume path, and the collision-branch session authenticates the target', async () => {
    const url = await mint(ELSEWHERE_EMAIL);
    const res = await app.app.request(url, { headers: { 'x-forwarded-for': nextIp() } });
    expect(res.status).toBeLessThan(500);
    // The link is sign-in-equivalent by design (LESSONS M6) — on the uniform
    // branch too, and for the TARGET member, never the probed account.
    const cookie = extractCookie(res);
    const me = await readJson(await app.app.request('/api/v1/me', { headers: { cookie } }));
    expect(me.user.email).toBe(await memberEmail());
    expect(me.user.email).not.toBe(ELSEWHERE_EMAIL);
  });

  it('an invalid token keeps its ordinary error redirect (uniformity never hides real failures)', async () => {
    const res = await app.app.request('/api/v1/auth/verify-email?token=not-a-jwt&callbackURL=%2Faccount', {
      headers: { 'x-forwarded-for': nextIp() }
    });
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(res.headers.get('location')).toContain('error=');
  });
});
