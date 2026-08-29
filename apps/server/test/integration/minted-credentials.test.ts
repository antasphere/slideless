import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { workspaceMembers } from '@slideless/db';
import {
  createDatabase,
  createTestApp,
  extractCookie,
  readJson,
  startPostgres,
  type TestApp
} from './helpers.js';

/**
 * PRDCT-1354 — the minted-credential cross-tenant account-takeover chain.
 *
 * The proven chain the audit walked, end to end:
 *
 *   1. AUTH-6 — any PLAIN MEMBER of workspace A creates a deck and invites an
 *      arbitrary outside email as a per-deck collaborator. The claim path
 *      mints that outsider a real, instance-GLOBAL `user` row plus an
 *      `origin='guest'` membership of A.
 *   2. AUTH-1/AUTH-2 — an admin of A then mints
 *      `POST /members/{id}/change-email-link` (or `reset-link`) against that
 *      membership. Both links are SIGN-IN-EQUIVALENT (LESSONS.md M6:
 *      consuming a change-email JWT while logged out CREATES a session for
 *      the target). The `user` row is global, so the credential works
 *      everywhere the victim belongs — including workspace B, which A has no
 *      relationship with at all.
 *   3. AUTH-8 — the only guards on either route fired when
 *      `target.role === 'owner'`, so the step above also worked
 *      admin-against-admin inside A.
 *   4. AUTH-3/AUTH-7 — orthogonal, same theme: `/api/v1/auth/get-access-token`
 *      and `/api/v1/auth/refresh-token` hand any session-bearing caller their
 *      own provider grant in plaintext, outside the scope gate / quota /
 *      idempotency / audit (the `/auth/*` mount precedes `authContext`), and
 *      the refresh leg rotates the hub grant outside ADR 019's single-flight.
 *
 * Each `it` below fails on the pre-fix tree and passes after. The negative
 * cases assert the STATUS *and* that no credential material was produced —
 * a 403 that still wrote a verification row would be no fix at all.
 */

const OWNER = { email: 'owner@mint.test', name: 'A Owner', password: 'mint-owner-password-123' };
const ADMIN = { email: 'admin@mint.test', name: 'A Admin', password: 'mint-admin-password-123' };
const ADMIN2 = { email: 'admin2@mint.test', name: 'A Admin Two', password: 'mint-admin2-password-12' };
const PLAIN = { email: 'plain@mint.test', name: 'A Plain', password: 'mint-plain-password-123' };
const SOLO = { email: 'solo@mint.test', name: 'A Solo', password: 'mint-solo-password-1234' };
const DUAL = { email: 'dual@mint.test', name: 'Dual Tenant', password: 'mint-dual-password-1234' };
const GUEST = { email: 'guest@outsider.test', name: 'Outside Guest', password: 'mint-guest-password-12' };
const OUTSIDER = 'stranger@outsider.test';
const FOREIGN = 'foreign@other-tenant.test';

const HTML = Buffer.from('<!doctype html><html><body><h1>mint</h1></body></html>');
const shaOf = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

let container: StartedPostgreSqlContainer;
let app: TestApp;

let ownerCookie = '';
let adminCookie = '';
let plainCookie = '';

let wA = '';
let wB = ''; // DUAL's second, unrelated tenant
let ownerDeck = ''; // owned by OWNER, in wA
let plainDeck = ''; // owned by PLAIN (a plain member), in wA

// Member row ids inside wA, by email.
const rowId: Record<string, string> = {};

// The public claim + invitation-accept routes ride a tight per-IP wall and
// TRUST_PROXY is on in tests — rotate the forwarded address every request.
let ipCounter = 0;
const nextIp = () => `10.88.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp(), ...headers },
  body: JSON.stringify(body)
});

async function signIn(email: string, password: string): Promise<string> {
  const res = await app.app.request('/api/v1/auth/sign-in/email', json({ email, password }));
  expect(res.status).toBe(200);
  return extractCookie(res);
}

/** Invite + accept a workspace member of wA, then sign them in. */
async function addMember(person: { email: string; name: string; password: string }): Promise<string> {
  const invited = await readJson(
    await app.app.request(
      '/api/v1/invitations',
      json({ email: person.email, role: 'member' }, { cookie: ownerCookie })
    )
  );
  const accept = await app.app.request(
    '/api/v1/invitations/accept',
    json({ token: invited.acceptUrl.split('/invite/')[1], name: person.name, password: person.password })
  );
  expect(accept.status).toBe(200);
  return signIn(person.email, person.password);
}

async function uploadAsset(cookie: string): Promise<void> {
  const form = new FormData();
  form.set('sha256', shaOf(HTML));
  form.set('file', new Blob([new Uint8Array(HTML)], { type: 'text/html' }), 'index.html');
  const res = await app.app.request('/api/v1/presentations/assets', {
    method: 'POST',
    headers: { cookie, 'x-forwarded-for': nextIp() },
    body: form
  });
  expect(res.status).toBe(201);
}

async function createDeck(cookie: string, title: string): Promise<string> {
  const reserve = await readJson(
    await app.app.request('/api/v1/presentations/uploads', {
      method: 'POST',
      headers: { cookie, 'x-forwarded-for': nextIp() }
    })
  );
  const commit = await app.app.request(
    `/api/v1/presentations/uploads/${reserve.uploadSession.id}/commit`,
    json(
      {
        title,
        entryPath: 'index.html',
        manifest: [
          { path: 'index.html', sha256: shaOf(HTML), sizeBytes: HTML.length, contentType: 'text/html' }
        ]
      },
      { cookie }
    )
  );
  expect(commit.status).toBe(201);
  return reserve.uploadSession.presentationId;
}

async function refreshRowIds(): Promise<void> {
  const { members } = await readJson(
    await app.app.request('/api/v1/members', { headers: { cookie: ownerCookie } })
  );
  for (const m of members as Array<{ id: string; email: string }>) rowId[m.email] = m.id;
}

/** Every reset token currently live in Better Auth's own verification table. */
async function resetTokenCount(): Promise<number> {
  const { rows } = await app.db.pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM verification WHERE identifier LIKE 'reset-password:%'`
  );
  return rows[0]!.n;
}

const mintReset = (memberId: string, cookie: string) =>
  app.app.request(`/api/v1/members/${memberId}/reset-link`, {
    method: 'POST',
    headers: { cookie, 'x-forwarded-for': nextIp() }
  });

const mintChangeEmail = (memberId: string, cookie: string, newEmail: string) =>
  app.app.request(`/api/v1/members/${memberId}/change-email-link`, json({ newEmail }, { cookie }));

beforeAll(async () => {
  container = await startPostgres();
  app = await createTestApp(await createDatabase(container, 'minted_creds'));

  const setup = await app.app.request(
    '/api/v1/setup',
    json({ setupToken: 'integration-test-setup-token', instanceName: 'Mint A', owner: OWNER })
  );
  expect(setup.status).toBe(201);
  wA = (await readJson(setup)).workspaceId;
  ownerCookie = await signIn(OWNER.email, OWNER.password);

  adminCookie = await addMember(ADMIN);
  await addMember(ADMIN2);
  plainCookie = await addMember(PLAIN);
  await addMember(SOLO);
  await addMember(DUAL);
  await refreshRowIds();

  // Promote the two admins.
  for (const person of [ADMIN, ADMIN2]) {
    const res = await app.app.request(`/api/v1/members/${rowId[person.email]}`, {
      ...json({ role: 'admin' }, { cookie: ownerCookie }),
      method: 'PATCH'
    });
    expect(res.status).toBe(200);
  }

  // DUAL also belongs to a SECOND, unrelated tenant — the cross-tenant blast
  // radius the mint routes must refuse to touch. (Seeded directly, exactly
  // like the workspace-scoping suite: the platform has no "create workspace"
  // HTTP surface on oss.)
  const dualUser = await app.db.db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.id, rowId[DUAL.email]!))
    .limit(1);
  wB = (await app.registry.workspaces.create('Mint B', dualUser[0]!.userId)).workspaceId;
  expect(wB).not.toBe(wA);

  // Decks: one owned by the workspace owner, one owned by a PLAIN member
  // (the AUTH-6 entry point — any member can create a deck and thereby
  // satisfy `canAdministerDeck` on it).
  await uploadAsset(ownerCookie);
  ownerDeck = await createDeck(ownerCookie, 'Owner deck');
  // PRDCT-1343 scoped the commit guard: a principal may only bind a sha it can
  // READ, so the plain member re-uploads the same bytes rather than riding the
  // owner's upload. Content-addressed dedupe means this stores nothing new; it
  // registers the uploader, which is what the scope check reads.
  await uploadAsset(plainCookie);
  plainDeck = await createDeck(plainCookie, 'Plain-member deck');
}, 240_000);

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

// ═══ AUTH-6 — the entry step: onboarding an outsider ═════════════════════════

describe('AUTH-6: a plain member cannot pull an outsider into the tenant', () => {
  it('refuses an EXTERNAL email on a deck the plain member owns (403 external_invite_forbidden)', async () => {
    const res = await app.app.request(
      `/api/v1/presentations/${plainDeck}/collaborators`,
      json({ email: OUTSIDER }, { cookie: plainCookie })
    );
    expect(res.status).toBe(403);
    expect((await readJson(res)).error.code).toBe('external_invite_forbidden');

    // Nothing was written — no grant, and above all no future guest row.
    const { rows } = await app.db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM collaborators WHERE email = $1`,
      [OUTSIDER]
    );
    expect(rows[0]!.n).toBe(0);
  });

  it('still lets that plain member invite an existing COLLEAGUE (no new principal)', async () => {
    const res = await app.app.request(
      `/api/v1/presentations/${plainDeck}/collaborators`,
      json({ email: SOLO.email }, { cookie: plainCookie })
    );
    expect(res.status).toBe(201);
  });

  it('lets a workspace ADMIN invite the outsider — the authority moved, it did not vanish', async () => {
    const res = await app.app.request(
      `/api/v1/presentations/${plainDeck}/collaborators`,
      json({ email: OUTSIDER }, { cookie: adminCookie })
    );
    expect(res.status).toBe(201);
  });

  it('refuses an email that EXISTS on the instance but only in ANOTHER tenant (403, no grant)', async () => {
    // The colleague lookup's workspace scope is the load-bearing filter: an
    // account living only in wB must read as an OUTSIDER to wA. Dropping the
    // scope (the AUTH-6 mutation the PRDCT-1354 verifier found survives the
    // suite) turns "exists anywhere on the instance" into "colleague here"
    // and reopens cross-tenant onboarding to every plain member.
    const foreign = await app.auth.api.signUpEmail({
      body: { email: FOREIGN, password: 'mint-foreign-pass-123', name: 'Foreign Tenant' }
    });
    await app.db.db
      .insert(workspaceMembers)
      .values({ workspaceId: wB, userId: foreign.user.id, role: 'member' });

    const res = await app.app.request(
      `/api/v1/presentations/${plainDeck}/collaborators`,
      json({ email: FOREIGN }, { cookie: plainCookie })
    );
    expect(res.status).toBe(403);
    expect((await readJson(res)).error.code).toBe('external_invite_forbidden');

    // Nothing was written — no grant, so no future claim, no guest row.
    const { rows } = await app.db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM collaborators WHERE email = $1`,
      [FOREIGN]
    );
    expect(rows[0]!.n).toBe(0);
  });

  it('refuses a DEACTIVATED colleague — a member must not reverse an admin cutoff (403)', async () => {
    // The isActive filter is the OTHER load-bearing half of the colleague
    // lookup: a deactivated member's grant claim REACTIVATES their
    // membership (the claim path's rejoin branch), so treating them as a
    // colleague would let any plain member undo an admin's cutoff. Only
    // admin/owner authority may re-onboard them.
    const PAUSED = { email: 'paused@mint.test', name: 'A Paused', password: 'mint-paused-password-1' };
    await addMember(PAUSED);
    await refreshRowIds();
    const off = await app.app.request(`/api/v1/members/${rowId[PAUSED.email]}`, {
      ...json({ isActive: false }, { cookie: ownerCookie }),
      method: 'PATCH'
    });
    expect(off.status).toBe(200);

    const res = await app.app.request(
      `/api/v1/presentations/${plainDeck}/collaborators`,
      json({ email: PAUSED.email }, { cookie: plainCookie })
    );
    expect(res.status).toBe(403);
    expect((await readJson(res)).error.code).toBe('external_invite_forbidden');
    const { rows } = await app.db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM collaborators WHERE email = $1`,
      [PAUSED.email]
    );
    expect(rows[0]!.n).toBe(0);
  });
});

// ═══ AUTH-1 / AUTH-2 — the mint routes ═══════════════════════════════════════

describe('AUTH-1/AUTH-2: no mint against a target who belongs to another workspace', () => {
  it('reset-link refuses (403 cross_workspace_target) and writes NO verification row', async () => {
    const before = await resetTokenCount();
    const res = await mintReset(rowId[DUAL.email]!, ownerCookie);
    expect(res.status).toBe(403);
    const body = await readJson(res);
    expect(body.error.code).toBe('cross_workspace_target');
    expect(body.resetUrl).toBeUndefined();
    expect(await resetTokenCount()).toBe(before);
  });

  it('change-email-link refuses (403 cross_workspace_target) and returns no verifyUrl', async () => {
    const res = await mintChangeEmail(rowId[DUAL.email]!, ownerCookie, 'dual-hijacked@mint.test');
    expect(res.status).toBe(403);
    const body = await readJson(res);
    expect(body.error.code).toBe('cross_workspace_target');
    expect(body.verifyUrl).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('verify-email');
  });

  it('the sanctioned recovery still works for a single-workspace member (control)', async () => {
    const reset = await mintReset(rowId[SOLO.email]!, ownerCookie);
    expect(reset.status).toBe(200);
    expect((await readJson(reset)).resetUrl).toContain('/reset-password?token=');

    const change = await mintChangeEmail(rowId[SOLO.email]!, ownerCookie, 'solo-renamed@mint.test');
    expect(change.status).toBe(200);
    expect((await readJson(change)).verifyUrl).toContain('/api/v1/auth/verify-email?token=');
  });
});

describe('AUTH-1/AUTH-2: no mint against an origin=guest membership', () => {
  let guestRowId = '';

  beforeAll(async () => {
    // The real chain: an admin invites an outsider to one deck; the outsider
    // claims and gets a guest membership carrying their GLOBAL user id.
    const invited = await readJson(
      await app.app.request(
        `/api/v1/presentations/${ownerDeck}/collaborators`,
        json({ email: GUEST.email }, { cookie: ownerCookie })
      )
    );
    const claim = await app.app.request(
      '/api/v1/collaborators/claim',
      json({
        token: invited.claimUrl.split('/collab/')[1],
        name: GUEST.name,
        password: GUEST.password
      })
    );
    expect(claim.status).toBe(200);
    const guestUserId = (await readJson(claim)).userId as string;
    const [row] = await app.db.db
      .select({ id: workspaceMembers.id, origin: workspaceMembers.origin })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, guestUserId))
      .limit(1);
    expect(row!.origin).toBe('guest');
    guestRowId = row!.id;
  }, 60_000);

  it('reset-link refuses (403 guest_target) and writes NO verification row', async () => {
    const before = await resetTokenCount();
    const res = await mintReset(guestRowId, ownerCookie);
    expect(res.status).toBe(403);
    expect((await readJson(res)).error.code).toBe('guest_target');
    expect(await resetTokenCount()).toBe(before);
  });

  it('change-email-link refuses (403 guest_target) — the sign-in-equivalent leg', async () => {
    const res = await mintChangeEmail(guestRowId, ownerCookie, 'guest-hijacked@mint.test');
    expect(res.status).toBe(403);
    const body = await readJson(res);
    expect(body.error.code).toBe('guest_target');
    expect(body.verifyUrl).toBeUndefined();
  });
});

describe('AUTH-8: minting is an OWNER act, not an admin one', () => {
  it('an admin cannot mint a reset link against another admin, nor against a plain member', async () => {
    const before = await resetTokenCount();
    for (const victim of [ADMIN2.email, PLAIN.email]) {
      const res = await mintReset(rowId[victim]!, adminCookie);
      expect(res.status).toBe(403);
      expect((await readJson(res)).resetUrl).toBeUndefined();
    }
    expect(await resetTokenCount()).toBe(before);
  });

  it('an admin cannot mint a change-email link against another admin, nor against a plain member', async () => {
    for (const victim of [ADMIN2.email, PLAIN.email]) {
      const res = await mintChangeEmail(rowId[victim]!, adminCookie, `taken-${victim}`);
      expect(res.status).toBe(403);
      expect((await readJson(res)).verifyUrl).toBeUndefined();
    }
  });
});

// ═══ FUZZ-7 — the second mint route joins the idempotency claim ══════════════

/**
 * `reset-link` has always been an idempotency target; `change-email-link`
 * never was, even though its contract declared `Idempotency-Key` and a 409
 * for it. So a retried mint — a network blip, a double-clicked dialog, a
 * deliberate replay — produced a SECOND, independently live
 * sign-in-equivalent JWT for the same target, and change-email tokens are
 * stateless (LESSONS.md M6): they cannot be revoked, only waited out for an
 * hour. Two secret-minting routes, one claim list.
 */
describe('FUZZ-7: a replayed change-email mint replays, it does not mint twice', () => {
  it('answers the SAME verifyUrl, flagged as a replay', async () => {
    const key = 'K-change-email-replay';
    const target = rowId[PLAIN.email]!;
    const first = await app.app.request(
      `/api/v1/members/${target}/change-email-link`,
      json({ newEmail: 'fuzz7-target@mint.test' }, { cookie: ownerCookie, 'idempotency-key': key })
    );
    expect(first.status).toBe(200);
    const firstUrl = (await readJson(first)).verifyUrl as string;
    expect(firstUrl).toContain('/api/v1/auth/verify-email?token=');

    const replay = await app.app.request(
      `/api/v1/members/${target}/change-email-link`,
      json({ newEmail: 'fuzz7-target@mint.test' }, { cookie: ownerCookie, 'idempotency-key': key })
    );
    expect(replay.status).toBe(200);
    // The claim header is the assertion that NAMES the fix: the JWT itself
    // can coincide across two mints inside the same second, so URL equality
    // alone would pass on the unclaimed tree too.
    expect(replay.headers.get('idempotency-replayed')).toBe('true');
    expect((await readJson(replay)).verifyUrl).toBe(firstUrl);
  });

  it('409s when the same key comes back with a different target email', async () => {
    const key = 'K-change-email-conflict';
    const target = rowId[PLAIN.email]!;
    const first = await app.app.request(
      `/api/v1/members/${target}/change-email-link`,
      json({ newEmail: 'fuzz7-first@mint.test' }, { cookie: ownerCookie, 'idempotency-key': key })
    );
    expect(first.status).toBe(200);
    const conflicting = await app.app.request(
      `/api/v1/members/${target}/change-email-link`,
      json({ newEmail: 'fuzz7-second@mint.test' }, { cookie: ownerCookie, 'idempotency-key': key })
    );
    expect(conflicting.status).toBe(409);
    expect((await readJson(conflicting)).verifyUrl).toBeUndefined();
  });
});

// ═══ AUTH-3 / AUTH-7 — the provider-grant endpoints ══════════════════════════

describe('AUTH-3/AUTH-7: the provider-grant endpoints are closed', () => {
  const GRANT_PATHS = ['/api/v1/auth/get-access-token', '/api/v1/auth/refresh-token'];

  it('answers 403 to a session-bearing caller and leaks no token material', async () => {
    for (const path of GRANT_PATHS) {
      const res = await app.app.request(path, json({ providerId: 'antasphere' }, { cookie: ownerCookie }));
      expect(res.status, path).toBe(403);
      const raw = await res.text();
      for (const leak of ['accessToken', 'idToken', 'refreshToken', 'tokenType', 'access_token']) {
        expect(raw, `${path} must not carry ${leak}`).not.toContain(leak);
      }
    }
  });

  it('answers 403 to an anonymous caller too — the closure precedes session resolution', async () => {
    for (const path of GRANT_PATHS) {
      const res = await app.app.request(path, json({ providerId: 'google' }));
      expect(res.status, path).toBe(403);
    }
  });
});

// ═══ AUTH-5 — the write-surface existence oracle ═════════════════════════════

describe('AUTH-5: the share-token surface never confirms a deck exists', () => {
  it('answers 404, not 403, to a workspace member who does not hold the deck', async () => {
    const unknownDeck = '00000000-0000-4000-8000-000000000000';
    for (const [label, deck] of [
      ['a real deck they cannot manage', ownerDeck],
      ['a deck that does not exist', unknownDeck]
    ] as const) {
      const list = await app.app.request(`/api/v1/presentations/${deck}/tokens`, {
        headers: { cookie: plainCookie, 'x-forwarded-for': nextIp() }
      });
      expect(list.status, `list: ${label}`).toBe(404);
      const create = await app.app.request(
        `/api/v1/presentations/${deck}/tokens`,
        json({ name: 'Nope' }, { cookie: plainCookie })
      );
      expect(create.status, `create: ${label}`).toBe(404);
    }
  });
});

// ═══ AUTH-5, second wave (PRDCT-1393) — the leftover per-deck WRITE routes ═══

describe('AUTH-5 (PRDCT-1393): no per-deck WRITE route confirms a deck exists', () => {
  const unknownDeck = '00000000-0000-4000-8000-000000000000';
  const unknownChild = '11111111-1111-4111-8111-111111111111';

  /**
   * Both halves of the oracle, per route: to a plain member holding no
   * grant, a real deck and a missing one must be indistinguishable — 404
   * with the same error code, and the probe is free (nothing written).
   */
  const bothWays = (probe: (deck: string) => Response | Promise<Response>) => async () => {
    for (const [label, deck] of [
      ['a real deck they cannot read', ownerDeck],
      ['a deck that does not exist', unknownDeck]
    ] as const) {
      const res = await probe(deck);
      expect(res.status, label).toBe(404);
      expect((await readJson(res)).error.code, label).toBe('not_found');
    }
  };

  it(
    'DELETE /presentations/{id}',
    bothWays((deck) =>
      app.app.request(`/api/v1/presentations/${deck}`, {
        method: 'DELETE',
        headers: { cookie: plainCookie, 'x-forwarded-for': nextIp() }
      })
    )
  );

  it('…and the probed deck was NOT soft-deleted by the refused DELETE', async () => {
    const res = await app.app.request(`/api/v1/presentations/${ownerDeck}`, {
      headers: { cookie: ownerCookie, 'x-forwarded-for': nextIp() }
    });
    expect(res.status).toBe(200);
  });

  it(
    'PATCH /presentations/{id}/annotations/{annotationId}',
    bothWays((deck) =>
      app.app.request(`/api/v1/presentations/${deck}/annotations/${unknownChild}`, {
        ...json({ status: 'resolved' }, { cookie: plainCookie }),
        method: 'PATCH'
      })
    )
  );

  it(
    'DELETE /presentations/{id}/annotations/{annotationId}',
    bothWays((deck) =>
      app.app.request(`/api/v1/presentations/${deck}/annotations/${unknownChild}`, {
        method: 'DELETE',
        headers: { cookie: plainCookie, 'x-forwarded-for': nextIp() }
      })
    )
  );

  it(
    'DELETE /presentations/{id}/responses/{responseId}',
    bothWays((deck) =>
      app.app.request(`/api/v1/presentations/${deck}/responses/${unknownChild}`, {
        method: 'DELETE',
        headers: { cookie: plainCookie, 'x-forwarded-for': nextIp() }
      })
    )
  );

  it('POST /presentations/{id}/collaborators — and no grant row appears', async () => {
    await bothWays((deck) =>
      app.app.request(
        `/api/v1/presentations/${deck}/collaborators`,
        json({ email: SOLO.email }, { cookie: plainCookie })
      )
    )();
    // SOLO's only grant stays the one PLAIN minted on their OWN deck above —
    // the refused probe on the owner's deck wrote nothing.
    const { rows } = await app.db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM collaborators WHERE email = $1 AND presentation_id = $2`,
      [SOLO.email, ownerDeck]
    );
    expect(rows[0]!.n).toBe(0);
  });

  it(
    'DELETE /presentations/{id}/collaborators/{collaboratorId}',
    bothWays((deck) =>
      app.app.request(`/api/v1/presentations/${deck}/collaborators/${unknownChild}`, {
        method: 'DELETE',
        headers: { cookie: plainCookie, 'x-forwarded-for': nextIp() }
      })
    )
  );

  it(
    'POST /presentations/{id}/versions — the push probe (aligned with the routes above)',
    bothWays((deck) =>
      app.app.request(
        `/api/v1/presentations/${deck}/versions`,
        json(
          {
            expectedBaseVersion: 1,
            entryPath: 'index.html',
            manifest: [
              { path: 'index.html', sha256: shaOf(HTML), sizeBytes: HTML.length, contentType: 'text/html' }
            ]
          },
          { cookie: plainCookie }
        )
      )
    )
  );

  it(
    'POST /presentations/{id}/preview-token',
    bothWays((deck) =>
      app.app.request(`/api/v1/presentations/${deck}/preview-token`, json({}, { cookie: plainCookie }))
    )
  );
});

// ═══ RACE-7 — the email_taken pre-check is advisory, the UNIQUE index is not ══

/**
 * The `email_taken` pre-check in the change-email-link handler cannot be a
 * uniqueness boundary and must never be treated as one: it is a read taken
 * outside any lock, the mint writes NOTHING (the token is a stateless JWT —
 * LESSONS.md M6), and the link then stays live for an hour, so even a
 * perfectly serialized mint could not stop a second one from passing.
 *
 * The boundary that actually holds is the `user_email_unique` index at
 * CONSUMPTION time. This test pins both halves of that sentence.
 *
 * KNOWN RESIDUAL (pre-existing, unchanged by PRDCT-1354): the LOSING
 * consumption surfaces as a sanitized 500 rather than a clean error
 * redirect — the 23505 escapes Better Auth's own `/verify-email` handler,
 * whose try/catch does not cover `updateUserByEmail`. Data integrity is
 * intact (exactly one account holds the address, no session is minted for
 * the loser); only the error shape is wrong, and fixing it means
 * intercepting the pinned Better Auth route. Asserted below so a future
 * Better Auth bump that changes it is noticed rather than silently
 * absorbed.
 */
describe('RACE-7: concurrent change-email mints for one address', () => {
  it('both links mint (the pre-check is NOT the boundary) but only one lands', async () => {
    const contested = 'contested@mint.test';
    const [a, b] = await Promise.all([
      mintChangeEmail(rowId[ADMIN2.email]!, ownerCookie, contested),
      mintChangeEmail(rowId[SOLO.email]!, ownerCookie, contested)
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);

    const outcomes: number[] = [];
    for (const res of [a, b]) {
      const { verifyUrl } = await readJson(res);
      const consumed = await app.app.request(verifyUrl, { headers: { 'x-forwarded-for': nextIp() } });
      outcomes.push(consumed.status);
    }
    // Winner: a 3xx redirect to the callback (and a session for that user).
    expect(outcomes[0]).toBeGreaterThanOrEqual(300);
    expect(outcomes[0]).toBeLessThan(400);
    // Loser: refused. 500 today (the known residual above); a clean 4xx
    // after any fix — both are acceptable, a 3xx would mean it LANDED.
    expect(outcomes[1]).toBeGreaterThanOrEqual(400);

    // The unique index did the work: exactly one account, and the loser
    // still holds its original address.
    const { rows } = await app.db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "user" WHERE email = $1`,
      [contested]
    );
    expect(rows[0]!.n).toBe(1);
    const survivors = await app.db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "user" WHERE email = $1`,
      [SOLO.email]
    );
    expect(survivors.rows[0]!.n).toBe(1);
  });
});
