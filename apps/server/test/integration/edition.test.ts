import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  createDatabase,
  createTestApp,
  readJson,
  RecordingEmailDriver,
  startPostgres,
  type TestApp
} from './helpers.js';

/**
 * The edition split, Phase 2 (docs/federation.md):
 *  - setup stamps the instance's edition; the R7 boot guard refuses an env
 *    EDITION that differs on an already-set-up instance, and
 *    EDITION_CHANGE_ALLOWED=true is the one-boot acknowledgement that
 *    re-stamps it;
 *  - a fresh database boots under any edition (cloud starts from a fresh DB);
 *  - EDITION=oss keeps today's behavior byte-identical — no hub config read.
 *
 * The SSO wiring itself is Phase 3; these tests pin the scaffolding only.
 */

const OWNER = { email: 'owner@edition.test', name: 'Ed Owner', password: 'ed-owner-password-123' };

/** The full hub block a cloud boot requires (dev-shaped values). */
const HUB_ENV = {
  EDITION: 'cloud',
  HUB_ISSUER_URL: 'http://hub.localhost:3300',
  HUB_CLIENT_ID: 'tool-slideless-cloud',
  HUB_CLIENT_SECRET: 'integration-test-hub-secret-0001',
  HUB_SERVICE_KEY: 'ant_integration_test_key'
};

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body)
});

let container: StartedPostgreSqlContainer;

beforeAll(async () => {
  container = await startPostgres();
});

afterAll(async () => {
  await container?.stop();
});

describe('R7 edition-flip boot guard', () => {
  let connectionString: string;

  beforeAll(async () => {
    connectionString = await createDatabase(container, 'edition_guard');
    const app = await createTestApp(connectionString);
    const res = await app.app.request('/api/v1/setup', json({ instanceName: 'Ed', owner: OWNER }));
    expect(res.status).toBe(201);
    await app.stop();
  });

  it('setup stamped the instance as oss (the test boot default)', async () => {
    const app = await createTestApp(connectionString);
    const { rows } = await app.db.pool.query<{ edition: string }>(`SELECT edition FROM instance_settings`);
    expect(rows).toEqual([{ edition: 'oss' }]);
    await app.stop();
  });

  it('refuses to boot EDITION=cloud on the populated oss instance', async () => {
    await expect(createTestApp(connectionString, HUB_ENV)).rejects.toThrow(
      /refusing to boot: EDITION=cloud but this instance was set up as 'oss'/
    );
  });

  it('EDITION_CHANGE_ALLOWED=true re-stamps and boots; the flip then holds without the flag', async () => {
    const flipped = await createTestApp(connectionString, { ...HUB_ENV, EDITION_CHANGE_ALLOWED: 'true' });
    const { rows } = await flipped.db.pool.query<{ edition: string }>(
      `SELECT edition FROM instance_settings`
    );
    expect(rows).toEqual([{ edition: 'cloud' }]);
    await flipped.stop();

    // The stamp moved: a plain cloud boot now succeeds, and an oss boot is
    // now the refused flip (the guard is symmetric).
    const cloudAgain = await createTestApp(connectionString, HUB_ENV);
    await cloudAgain.stop();
    await expect(createTestApp(connectionString)).rejects.toThrow(
      /refusing to boot: EDITION=oss but this instance was set up as 'cloud'/
    );
  });
});

describe('cloud edition on a fresh database', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp(await createDatabase(container, 'edition_cloud'), HUB_ENV);
  });

  afterAll(async () => {
    await app.stop();
  });

  it('boots (fresh DB — nothing to guard) and setup stamps edition=cloud', async () => {
    const res = await app.app.request('/api/v1/setup', json({ instanceName: 'EdCloud', owner: OWNER }));
    expect(res.status).toBe(201);
    const { rows } = await app.db.pool.query<{ edition: string }>(`SELECT edition FROM instance_settings`);
    expect(rows).toEqual([{ edition: 'cloud' }]);
  });

  it('reports edition=cloud in discovery', async () => {
    const info = await readJson(await app.app.request('/api/v1/instance'));
    expect(info.edition).toBe('cloud');
  });

  it('setup minted the operator emailVerified=true (D9 — the trusted-link bootstrap)', async () => {
    // Under hub-only login (D1, Phase 3) the operator can only enter via the
    // hub trusted-link, which Better Auth refuses onto an unverified local
    // email. An unverified operator = a bricked cloud instance. Pinned here
    // so no auth refactor can silently reopen the trap.
    const { rows } = await app.db.pool.query<{ email_verified: boolean }>(
      `SELECT email_verified FROM "user" WHERE email = $1`,
      [OWNER.email]
    );
    expect(rows).toEqual([{ email_verified: true }]);
  });

  it('advertises the hub-only human entrance (D1): antasphere + machine methods, no password/OTP', async () => {
    const info = await readJson(await app.app.request('/api/v1/instance'));
    expect(info.auth.methods).toContain('antasphere');
    // Hub-only posture (Phase 3): the login page renders ONLY the SSO
    // button; password/OTP/google are hidden (the machinery stays wired for
    // the break-glass CLI, verified in the next test). Machine entrances
    // are edition-independent.
    expect(info.auth.methods).not.toContain('password');
    expect(info.auth.methods).not.toContain('email-otp');
    expect(info.auth.methods).not.toContain('google');
    expect(info.auth.methods).toContain('api-key');
    expect(info.auth.methods).toContain('oauth');
    // Credentials and email are the hub's to manage; local 2FA guards
    // sign-in surfaces the cloud page no longer offers.
    expect(info.auth.passwordReset).toBe(false);
    expect(info.auth.emailChange).toBe(false);
    expect(info.auth.twoFactor).toBe(false);
  });

  it('local password sign-in stays WIRED though hidden (the break-glass door, D1)', async () => {
    const signIn = await app.app.request(
      '/api/v1/auth/sign-in/email',
      json({ email: OWNER.email, password: OWNER.password })
    );
    expect(signIn.status).toBe(200);
    const cookie = signIn.headers.get('set-cookie')!.split(';')[0]!;
    const me = await app.app.request('/api/v1/me', { headers: { cookie } });
    expect(me.status).toBe(200);
    expect((await readJson(me)).user.email).toBe(OWNER.email);
  });
});

describe('cloud edition closes the local password-reset surface (P8, ADR 017)', () => {
  // The P3 residual: on cloud, a hub-JIT user (no credential account) could
  // use the reset surface to SET a local password, then /sign-in/email to
  // mint sessions that skip the per-login SSO re-sync. D1's hub-only posture
  // closes the WHOLE reset class (core + emailOTP alias routes) while the
  // break-glass operator door — /sign-in/email with the SETUP password plus
  // the break-glass endpoints — stays fully independent of it.
  let app: TestApp;
  let email: RecordingEmailDriver;

  // The reset wall is 5/10min per IP (rate-limit.ts) and several reset paths
  // share one limiter — a unique forwarded address per request (TRUST_PROXY
  // is on in tests) keeps this suite off one shared 'unknown' bucket, so it
  // pins the 403 REFUSAL, never a 429.
  let ipCounter = 0;
  const jsonIp = (body: unknown, headers: Record<string, string> = {}) => ({
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': `198.51.100.${++ipCounter % 250}`,
      ...headers
    },
    body: JSON.stringify(body)
  });

  beforeAll(async () => {
    email = new RecordingEmailDriver();
    // A DELIVERING mailer + superadmin: the strongest configuration — on oss
    // this would open self-serve reset; on cloud every reset door must still
    // refuse while break-glass keeps working.
    app = await createTestApp(
      await createDatabase(container, 'edition_cloud_reset'),
      { ...HUB_ENV, SUPERADMIN_EMAILS: OWNER.email },
      { email }
    );
    const res = await app.app.request('/api/v1/setup', jsonIp({ instanceName: 'EdReset', owner: OWNER }));
    expect(res.status).toBe(201);
  });

  afterAll(async () => {
    await app.stop();
  });

  async function resetTokenCount(): Promise<number> {
    const { rows } = await app.db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM verification WHERE identifier LIKE 'reset-password:%'`
    );
    return rows[0]!.n;
  }

  it('refuses every reset-shaped route (core + emailOTP) despite the delivering mailer', async () => {
    const attempts: Array<[string, Record<string, unknown>]> = [
      [
        '/api/v1/auth/request-password-reset',
        { email: OWNER.email, redirectTo: 'http://localhost:3000/reset-password' }
      ],
      ['/api/v1/auth/reset-password', { newPassword: 'sso-bypass-password-99', token: 'whatever' }],
      ['/api/v1/auth/email-otp/request-password-reset', { email: OWNER.email }],
      ['/api/v1/auth/forget-password/email-otp', { email: OWNER.email }],
      [
        '/api/v1/auth/email-otp/reset-password',
        { email: OWNER.email, otp: '123456', password: 'sso-bypass-password-99' }
      ]
    ];
    for (const [path, body] of attempts) {
      const res = await app.app.request(path, jsonIp(body));
      expect(res.status, path).toBe(403);
    }
    // The tokened GET callback (the mailed-link landing) refuses too.
    const cb = await app.app.request('/api/v1/auth/reset-password/some-token', {
      headers: { 'x-forwarded-for': `198.51.100.${++ipCounter % 250}` }
    });
    expect(cb.status).toBe(403);
    // Nothing was mailed and no reset token was minted.
    expect(email.sent).toHaveLength(0);
    expect(await resetTokenCount()).toBe(0);
  });

  it('refuses to CONSUME a valid reset token — even one minted straight into the store', async () => {
    // An attacker (or a leftover admin link) holding a well-formed token in
    // Better Auth's own verification table still cannot set a password: the
    // refusal is on the route, not on token acquisition.
    const { rows } = await app.db.pool.query<{ id: string }>(`SELECT id FROM "user" WHERE email = $1`, [
      OWNER.email
    ]);
    await app.db.pool.query(
      `INSERT INTO verification (id, identifier, value, expires_at) VALUES ($1, $2, $3, $4)`,
      [crypto.randomUUID(), 'reset-password:direct-mint-token', rows[0]!.id, new Date(Date.now() + 3600_000)]
    );
    const res = await app.app.request(
      '/api/v1/auth/reset-password',
      jsonIp({ newPassword: 'sso-bypass-password-99', token: 'direct-mint-token' })
    );
    expect(res.status).toBe(403);
    // The password did not change: the setup password still signs in, the
    // attempted one does not.
    const bypass = await app.app.request(
      '/api/v1/auth/sign-in/email',
      jsonIp({ email: OWNER.email, password: 'sso-bypass-password-99' })
    );
    expect(bypass.status).toBe(401);
    // Remove the hand-minted row so the next test's "the mint added nothing"
    // count starts from zero again.
    await app.db.pool.query(`DELETE FROM verification WHERE identifier = 'reset-password:direct-mint-token'`);
  });

  it('refuses the admin reset-link mint on a cloud-LOCAL workspace (password_reset_disabled)', async () => {
    // Hub-origin workspaces already refuse at the P7 subtree gate
    // (hub_managed); this pins the cloud-LOCAL half — otherwise an admin
    // would mint links that dead-end on the refused /reset-password.
    const signIn = await app.app.request(
      '/api/v1/auth/sign-in/email',
      jsonIp({ email: OWNER.email, password: OWNER.password })
    );
    expect(signIn.status).toBe(200);
    const cookie = signIn.headers.get('set-cookie')!.split(';')[0]!;
    const { members } = await readJson(await app.app.request('/api/v1/members', { headers: { cookie } }));
    const minted = await app.app.request(`/api/v1/members/${members[0].id}/reset-link`, {
      method: 'POST',
      headers: { cookie }
    });
    expect(minted.status).toBe(403);
    expect((await readJson(minted)).error.code).toBe('password_reset_disabled');
    expect(await resetTokenCount()).toBe(0);
  });

  it('the operator door survives the closure: /sign-in/email + break-glass need no reset route', async () => {
    // The full recovery chain, reset-free: sign in with the SETUP password
    // (D9 minted the operator emailVerified=true), then claim-ownership and
    // reset-2fa — the ADR 010 surface — both work.
    const signIn = await app.app.request(
      '/api/v1/auth/sign-in/email',
      jsonIp({ email: OWNER.email, password: OWNER.password })
    );
    expect(signIn.status).toBe(200);
    const cookie = signIn.headers.get('set-cookie')!.split(';')[0]!;

    const claim = await app.app.request('/api/v1/admin/break-glass/claim-ownership', {
      ...jsonIp({}),
      headers: { 'content-type': 'application/json', cookie }
    });
    expect(claim.status).toBe(200);
    expect((await readJson(claim)).role).toBe('owner');

    const { rows } = await app.db.pool.query<{ id: string }>(`SELECT id FROM "user" WHERE email = $1`, [
      OWNER.email
    ]);
    const reset2fa = await app.app.request('/api/v1/admin/break-glass/reset-2fa', {
      ...jsonIp({ userId: rows[0]!.id }),
      headers: { 'content-type': 'application/json', cookie }
    });
    expect(reset2fa.status).toBe(200);
  });
});

describe('oss edition discovery (unchanged)', () => {
  it('never advertises the hub SSO method', async () => {
    const app = await createTestApp(await createDatabase(container, 'edition_oss_disc'));
    const info = await readJson(await app.app.request('/api/v1/instance'));
    expect(info.edition).toBe('oss');
    expect(info.auth.methods).not.toContain('antasphere');
    expect(info.auth.methods).toContain('password');
    await app.stop();
  });
});
