import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { auditLog, session as sessionTable, user as userTable } from '@slideless/db';
import {
  createDatabase,
  createTestApp,
  extractCookie,
  readJson,
  RecordingEmailDriver,
  startPostgres,
  type TestApp
} from './helpers.js';

/**
 * The CLI email-OTP → API-key flow (api/cli-auth.ts):
 *  - request → OTP mail → complete mints a working slk_ key (scoped
 *    presentations:read+write, NEVER data:export), audited, with the
 *    throwaway sign-in session deleted;
 *  - a consumed code cannot be replayed; a wrong code answers one uniform
 *    401 and better-auth's attempt limit (3) turns further guesses into 429;
 *  - the closed-signup invariant holds: an unknown email gets a generic
 *    success with NO mail and NO user row, and complete fails like a wrong
 *    code;
 *  - the OTP request wall rate-limits per IP;
 *  - a 2FA-enrolled user is refused (403 two_factor_required) — the
 *    browserless flow must never bypass the second factor;
 *  - an instance without an email driver answers 400 otp_unavailable.
 */

const OWNER = { email: 'owner@cliauth.test', name: 'Cli Owner', password: 'cli-auth-password-123' };

let container: StartedPostgreSqlContainer;
let app: TestApp;
let mailer: RecordingEmailDriver;

// Distinct per-call IPs keep the per-IP walls out of each other's way; the
// rate-limit test pins one IP on purpose.
let ipCounter = 0;
const nextIp = () => `10.88.0.${++ipCounter}`;

const json = (body: unknown, ip?: string, cookie?: string) => ({
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-forwarded-for': ip ?? nextIp(),
    ...(cookie ? { cookie } : {})
  },
  body: JSON.stringify(body)
});

/** The OTP travels in the subject: `123456 is your Slideless code`. */
function lastOtpFor(email: string): string {
  const mail = [...mailer.sent].reverse().find((m) => m.to === email);
  expect(mail, `an OTP mail to ${email}`).toBeTruthy();
  const otp = /^(\d{6}) /.exec(mail!.subject)?.[1];
  expect(otp, `a 6-digit code in "${mail!.subject}"`).toBeTruthy();
  return otp!;
}

async function requestOtp(email: string, ip?: string): Promise<Response> {
  return app.app.request('/api/v1/cli/auth/request', json({ email }, ip));
}

async function completeOtp(body: Record<string, unknown>, ip?: string): Promise<Response> {
  return app.app.request('/api/v1/cli/auth/complete', json(body, ip));
}

// ── In-test TOTP (RFC 6238), copied from two-factor.test.ts ─────────────────

function base32Decode(encoded: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of encoded.replace(/=+$/, '').toUpperCase()) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) throw new Error(`invalid base32 character: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function totpNow(base32Secret: string, digits = 6, periodSeconds = 30): string {
  const counter = Math.floor(Date.now() / 1000 / periodSeconds);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', base32Decode(base32Secret)).update(msg).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const code =
    ((digest[offset]! & 0x7f) << 24) |
    (digest[offset + 1]! << 16) |
    (digest[offset + 2]! << 8) |
    digest[offset + 3]!;
  return String(code % 10 ** digits).padStart(digits, '0');
}

beforeAll(async () => {
  container = await startPostgres();
  const dbUrl = await createDatabase(container, 'cliauth');
  mailer = new RecordingEmailDriver();
  app = await createTestApp(dbUrl, {}, { email: mailer });
  const setup = await app.app.request('/api/v1/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      setupToken: 'integration-test-setup-token',
      instanceName: 'CliAuth Instance',
      owner: OWNER
    })
  });
  expect(setup.status).toBe(201);
}, 240_000);

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

describe('CLI auth: OTP request → key mint', () => {
  it('mints a working slk_ key, audits it, and leaves no session behind', async () => {
    // Baseline: /setup's server-side signUpEmail already auto-created one
    // owner session — the CLI flow must not add to whatever exists.
    const sessionsBefore = await app.db.db.select({ id: sessionTable.id }).from(sessionTable);

    const requested = await requestOtp(OWNER.email);
    expect(requested.status).toBe(200);
    expect(await readJson(requested)).toEqual({ sent: true });

    const otp = lastOtpFor(OWNER.email);
    const completed = await completeOtp({ email: OWNER.email, otp, keyName: 'test key' });
    expect(completed.status).toBe(201);
    const body = await readJson(completed);
    expect(body.key).toMatch(/^slk_/);
    expect(body.apiKey.name).toBe('test key');
    expect(body.apiKey.scopes.sort()).toEqual(['presentations:read', 'presentations:write']);
    expect(body.apiKey.expiresAt).toBeNull();
    expect(body.user.email).toBe(OWNER.email);

    // The key works as a machine principal on the agent surface...
    const me = await app.app.request('/api/v1/me', {
      headers: { authorization: `Bearer ${body.key}` }
    });
    expect(me.status).toBe(200);
    const meBody = await readJson(me);
    expect(meBody.via).toBe('api_key');
    expect(meBody.user.email).toBe(OWNER.email);
    const decks = await app.app.request('/api/v1/presentations', {
      headers: { authorization: `Bearer ${body.key}` }
    });
    expect(decks.status).toBe(200);

    // ...but was never granted data:export.
    const exportRes = await app.app.request('/api/v1/workspace/export', {
      headers: { authorization: `Bearer ${body.key}` }
    });
    expect(exportRes.status).toBe(403);

    // The throwaway sign-in session was deleted (no NET new session dangles).
    const sessionsAfter = await app.db.db.select({ id: sessionTable.id }).from(sessionTable);
    expect(sessionsAfter.map((s) => s.id).sort()).toEqual(sessionsBefore.map((s) => s.id).sort());

    // The mint landed in the audit log with the CLI marker.
    const audits = await app.db.db
      .select({ action: auditLog.action, metadata: auditLog.metadata })
      .from(auditLog)
      .where(eq(auditLog.resourceId, body.apiKey.id));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.action).toBe('apikey.create');
    expect((audits[0]!.metadata as { via?: string }).via).toBe('cli_otp');

    // A consumed code cannot be replayed.
    const replay = await completeOtp({ email: OWNER.email, otp });
    expect(replay.status).toBe(401);
    expect((await readJson(replay)).error.code).toBe('invalid_otp');
  });

  it('honors expiresInDays', async () => {
    await requestOtp(OWNER.email);
    const otp = lastOtpFor(OWNER.email);
    const completed = await completeOtp({ email: OWNER.email, otp, expiresInDays: 30 });
    expect(completed.status).toBe(201);
    const body = await readJson(completed);
    expect(body.apiKey.expiresAt).toBeTruthy();
    const days = (Date.parse(body.apiKey.expiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThan(31);
  });

  it('rejects wrong codes 401 and attempt-limits to 429', async () => {
    // NOTE this suite shares ONE per-email login-wall bucket (10/15min) for
    // OWNER.email across every complete + password sign-in — keep the total
    // under 10 when adding calls.
    await requestOtp(OWNER.email);
    const otp = lastOtpFor(OWNER.email);
    const wrong = otp === '000000' ? '000001' : '000000';
    for (let i = 0; i < 3; i++) {
      const res = await completeOtp({ email: OWNER.email, otp: wrong });
      expect(res.status).toBe(401);
      expect((await readJson(res)).error.code).toBe('invalid_otp');
    }
    // better-auth's per-code attempt limit (3) trips next — even the RIGHT
    // code is dead now (it burned with the attempts).
    const right = await completeOtp({ email: OWNER.email, otp });
    expect(right.status).toBe(429);
    expect((await readJson(right)).error.code).toBe('too_many_attempts');
  });

  it('keeps sign-up closed: unknown email → generic success, no mail, no user, dead complete', async () => {
    const before = mailer.sent.length;
    const res = await requestOtp('stranger@cliauth.test');
    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual({ sent: true }); // indistinguishable from success
    expect(mailer.sent.length).toBe(before); // nothing was sent

    const completed = await completeOtp({ email: 'stranger@cliauth.test', otp: '123456' });
    expect(completed.status).toBe(401); // same failure as a wrong code

    const users = await app.db.db
      .select({ id: userTable.id })
      .from(userTable)
      .where(eq(userTable.email, 'stranger@cliauth.test'));
    expect(users).toEqual([]); // no account minted, ever
  });

  it('rate-limits OTP requests per IP (the OTP wall)', async () => {
    const ip = '10.77.0.1';
    for (let i = 0; i < 5; i++) {
      const res = await requestOtp(`rl-${i}@cliauth.test`, ip);
      expect(res.status).toBe(200);
    }
    const sixth = await requestOtp('rl-5@cliauth.test', ip);
    expect(sixth.status).toBe(429);
  });

  it('refuses a 2FA-enrolled user with two_factor_required (never bypasses the second factor)', async () => {
    // Enroll the owner: password sign-in → enable → activate via TOTP.
    const signIn = await app.app.request(
      '/api/v1/auth/sign-in/email',
      json({ email: OWNER.email, password: OWNER.password })
    );
    expect(signIn.status).toBe(200);
    const cookie = extractCookie(signIn);
    const enable = await app.app.request(
      '/api/v1/auth/two-factor/enable',
      json({ password: OWNER.password }, undefined, cookie)
    );
    expect(enable.status).toBe(200);
    const totpURI = (await readJson(enable)).totpURI as string;
    const secret = new URL(totpURI).searchParams.get('secret')!;
    const verify = await app.app.request(
      '/api/v1/auth/two-factor/verify-totp',
      json({ code: totpNow(secret) }, undefined, cookie)
    );
    expect(verify.status).toBe(200);

    // The CLI flow now refuses at complete (and mints nothing).
    await requestOtp(OWNER.email);
    const otp = lastOtpFor(OWNER.email);
    const completed = await completeOtp({ email: OWNER.email, otp });
    expect(completed.status).toBe(403);
    expect((await readJson(completed)).error.code).toBe('two_factor_required');
  });

  it('machine principals cannot reach the CLI-auth surface with a key (fail-closed gate is moot — public paths skip credentials)', async () => {
    // The endpoints are PUBLIC: presenting a bearer changes nothing — the
    // request is served pre-auth (documented posture; a key here is useless
    // since the flow's entire product IS a key).
    const res = await app.app.request('/api/v1/cli/auth/request', {
      ...json({ email: OWNER.email }),
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': nextIp(),
        authorization: 'Bearer slk_bogus_bogusbogusbogusbogus'
      }
    });
    expect(res.status).toBe(200);
  });
});

describe('CLI auth without an email driver', () => {
  let bare: TestApp;

  beforeAll(async () => {
    const dbUrl = await createDatabase(container, 'cliauth_nodriver');
    bare = await createTestApp(dbUrl); // EMAIL_DRIVER defaults to none
  }, 240_000);

  afterAll(async () => {
    await bare?.stop();
  });

  it('answers 400 otp_unavailable on both endpoints', async () => {
    const request = await bare.app.request('/api/v1/cli/auth/request', json({ email: 'a@b.test' }));
    expect(request.status).toBe(400);
    expect((await readJson(request)).error.code).toBe('otp_unavailable');

    const complete = await bare.app.request(
      '/api/v1/cli/auth/complete',
      json({ email: 'a@b.test', otp: '123456' })
    );
    expect(complete.status).toBe(400);
    expect((await readJson(complete)).error.code).toBe('otp_unavailable');
  });
});

describe('DELETE /cli/auth/key — the logout self-revoke', () => {
  // The `slideless logout` counterpart of the mint above: a presenting key
  // revokes exactly ITSELF. The route names no key, so the machine-allowlist
  // opening (presentations:write, method-keyed to DELETE) can never touch a
  // foreign credential; sessions keep the dashboard as their key surface.
  // Fresh app: the shared suite's owner ends up 2FA-enrolled, which would
  // park the password sign-in this suite needs behind the TOTP step.
  let revokeApp: TestApp;
  let revokeMailer: RecordingEmailDriver;
  let cookie: string;

  const jsonR = (body: unknown, extra: Record<string, string> = {}) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp(), ...extra },
    body: JSON.stringify(body)
  });

  const otpFor = (email: string): string => {
    const mail = [...revokeMailer.sent].reverse().find((m) => m.to === email);
    expect(mail, `an OTP mail to ${email}`).toBeTruthy();
    return /^(\d{6}) /.exec(mail!.subject)![1]!;
  };

  beforeAll(async () => {
    const dbUrl = await createDatabase(container, 'cliauth_revoke');
    revokeMailer = new RecordingEmailDriver();
    revokeApp = await createTestApp(dbUrl, {}, { email: revokeMailer });
    const setup = await revokeApp.app.request(
      '/api/v1/setup',
      jsonR({ setupToken: 'integration-test-setup-token', instanceName: 'Revoke Instance', owner: OWNER })
    );
    expect(setup.status).toBe(201);
    const signIn = await revokeApp.app.request(
      '/api/v1/auth/sign-in/email',
      jsonR({ email: OWNER.email, password: OWNER.password })
    );
    expect(signIn.status).toBe(200);
    cookie = extractCookie(signIn);
  }, 240_000);

  afterAll(async () => {
    await revokeApp?.stop();
  });

  const revokeWith = (key: string) =>
    revokeApp.app.request('/api/v1/cli/auth/key', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${key}`, 'x-forwarded-for': nextIp() }
    });

  it('a CLI-minted key revokes ITSELF (audited via cli_logout) — and nothing else', async () => {
    // Two keys through the real OTP mint; only the presenting one may die.
    const mintViaOtp = async (keyName: string) => {
      const req = await revokeApp.app.request('/api/v1/cli/auth/request', jsonR({ email: OWNER.email }));
      expect(req.status).toBe(200);
      const res = await revokeApp.app.request(
        '/api/v1/cli/auth/complete',
        jsonR({ email: OWNER.email, otp: otpFor(OWNER.email), keyName })
      );
      expect(res.status).toBe(201);
      return readJson(res);
    };
    const keyA = await mintViaOtp('logout-a');
    const keyB = await mintViaOtp('logout-b');

    const revoked = await revokeWith(keyA.key);
    expect(revoked.status).toBe(200);
    expect(await readJson(revoked)).toEqual({ revoked: true, id: keyA.apiKey.id });

    // Presenting key: dead (fail-closed 401 at resolution). Foreign key: alive.
    const deadMe = await revokeApp.app.request('/api/v1/me', {
      headers: { authorization: `Bearer ${keyA.key}` }
    });
    expect(deadMe.status).toBe(401);
    const liveMe = await revokeApp.app.request('/api/v1/me', {
      headers: { authorization: `Bearer ${keyB.key}` }
    });
    expect(liveMe.status).toBe(200);

    // A dead key cannot even reach the route again (no zombie self-revokes).
    const again = await revokeWith(keyA.key);
    expect(again.status).toBe(401);

    // The audit trail: the middleware attributed the machine mutation.
    const audits = await revokeApp.db.db
      .select({ action: auditLog.action, metadata: auditLog.metadata })
      .from(auditLog)
      .where(eq(auditLog.resourceId, keyA.apiKey.id));
    const actions = audits.map((a) => a.action).sort();
    expect(actions).toEqual(['apikey.create', 'apikey.revoke']);
    const revokeRow = audits.find((a) => a.action === 'apikey.revoke')!;
    expect((revokeRow.metadata as { via?: string }).via).toBe('cli_logout');
  });

  it('a session is refused — the dashboard (DELETE /api-keys/{id}) owns session key management', async () => {
    const res = await revokeApp.app.request('/api/v1/cli/auth/key', {
      method: 'DELETE',
      headers: { cookie, 'x-forwarded-for': nextIp() }
    });
    expect(res.status).toBe(403);
    expect((await readJson(res)).error.code).toBe('forbidden');
  });

  it('the allowlist opened exactly DELETE under presentations:write — nothing wider', async () => {
    const mintScoped = async (scopes: string[]) => {
      const res = await revokeApp.app.request('/api/v1/api-keys', {
        ...jsonR({ name: `scoped-${scopes.join('+')}`, scopes }),
        headers: { 'content-type': 'application/json', cookie }
      });
      expect(res.status).toBe(201);
      return readJson(res);
    };
    // A read-only key lacks the write scope: 403 insufficient_scope.
    const readOnly = await mintScoped(['presentations:read']);
    const refused = await revokeWith(readOnly.key);
    expect(refused.status).toBe(403);
    expect((await readJson(refused)).error.code).toBe('insufficient_scope');

    // Any OTHER method on the path stays fail-closed (method-keyed entry).
    const writable = await mintScoped(['presentations:read', 'presentations:write']);
    const wrongMethod = await revokeApp.app.request('/api/v1/cli/auth/key', {
      headers: { authorization: `Bearer ${writable.key}`, 'x-forwarded-for': nextIp() }
    });
    expect(wrongMethod.status).toBe(403);
    expect((await readJson(wrongMethod)).error.code).toBe('endpoint_not_allowed');

    // The read-only key survived its refused attempt — refusal never revokes.
    const stillLive = await revokeApp.app.request('/api/v1/me', {
      headers: { authorization: `Bearer ${readOnly.key}` }
    });
    expect(stillLive.status).toBe(200);
  });
});
