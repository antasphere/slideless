import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { and, eq } from 'drizzle-orm';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { workspaceMembers } from '@slideless/db';
import { OauthJwtVerifier } from '../../src/identity/oauth-jwt.js';
import type { Auth } from '../../src/identity/better-auth.js';
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
 * Phase 6 — guest capability limits (D2, BOTH editions; this suite pins the
 * self-host/oss edition, the cloud journey lives in collaborators-cloud):
 *
 * A membership with origin='guest' exists so the platform can resolve an
 * external per-deck collaborator to a principal — it is NOT a workspace
 * actor. This suite proves the boundary from both sides:
 *
 *  - KEPT (ADR 013 unchanged): read + push + share tokens + annotations on
 *    the ONE deck the grant covers, with a session AND with the guest's own
 *    API key; other decks stay 404 (never 403).
 *  - REFUSED (403 guest_forbidden): deck creation in the host workspace,
 *    the generic /files surface (reads INCLUDED — it spans every workspace
 *    blob with no per-deck authz, a deck-content bypass for an outsider),
 *    the member roster, the workspace export.
 *  - LOCKED: an admin cannot promote a guest row (guest_role_locked) — the
 *    capability limits key on origin, which nothing upgrades; deactivation
 *    stays available.
 *  - Ordinary members are untouched: deck creation, files, roster all keep
 *    working (the guard keys on origin, not role).
 */

const OWNER = { email: 'owner@guest.test', name: 'Guest Host', password: 'guest-owner-pass-1' };
const GUEST = { email: 'guest@guest.test', name: 'The Guest', password: 'guest-guest-pass-1' };
const MEMBER = { email: 'member@guest.test', name: 'Plain Member', password: 'plain-member-pass-1' };

const HTML_V1 = Buffer.from('<!doctype html><html><body><h1>v1</h1></body></html>');
const HTML_V2 = Buffer.from('<!doctype html><html><body><h1>v2</h1></body></html>');
const shaOf = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const entryOf = (path: string, bytes: Buffer) => ({
  path,
  sha256: shaOf(bytes),
  sizeBytes: bytes.length,
  contentType: 'text/html'
});

let container: StartedPostgreSqlContainer;
let app: TestApp;
let mail: RecordingEmailDriver;
let ownerCookie: string;
let guestCookie: string;
let guestKey: string;
let guestUserId: string;
/** The guest's original claim token — kept to prove replaying it grants nothing new. */
let guestClaimToken: string;
/** The deck the guest is invited to. */
let grantedDeck: string;
/** A sibling deck in the same workspace the guest has NO grant on. */
let otherDeck: string;

// The public claim route shares the tight invitation-accept wall; the suite
// runs with TRUST_PROXY=true so each request brings a fresh forwarded IP.
let ipCounter = 0;
const nextIp = () => `10.98.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp(), ...headers },
  body: JSON.stringify(body)
});

async function uploadAsset(bytes: Buffer, auth: Record<string, string>): Promise<Response> {
  const form = new FormData();
  form.set('sha256', shaOf(bytes));
  form.set('file', new Blob([new Uint8Array(bytes)], { type: 'text/html' }), 'index.html');
  return app.app.request('/api/v1/presentations/assets', { method: 'POST', headers: auth, body: form });
}

async function createDeck(title: string, auth: Record<string, string>): Promise<string> {
  const reserveRes = await app.app.request('/api/v1/presentations/uploads', {
    method: 'POST',
    headers: auth
  });
  expect(reserveRes.status).toBe(201);
  const reserve = await readJson(reserveRes);
  const commit = await app.app.request(
    `/api/v1/presentations/uploads/${reserve.uploadSession.id}/commit`,
    json({ title, entryPath: 'index.html', manifest: [entryOf('index.html', HTML_V1)] }, auth)
  );
  expect(commit.status).toBe(201);
  return reserve.uploadSession.presentationId;
}

beforeAll(async () => {
  container = await startPostgres();
  mail = new RecordingEmailDriver();
  app = await createTestApp(await createDatabase(container, 'guest_caps'), {}, { email: mail });
  await app.app.request(
    '/api/v1/setup',
    json({ setupToken: 'integration-test-setup-token', instanceName: 'GuestCaps', owner: OWNER })
  );
  ownerCookie = extractCookie(
    await app.app.request(
      '/api/v1/auth/sign-in/email',
      json({ email: OWNER.email, password: OWNER.password })
    )
  );
  await uploadAsset(HTML_V1, { cookie: ownerCookie });
  grantedDeck = await createDeck('Granted Deck', { cookie: ownerCookie });
  otherDeck = await createDeck('Private Deck', { cookie: ownerCookie });

  // Invite + claim: the shipped oss journey (local-password account).
  const invited = await readJson(
    await app.app.request(
      `/api/v1/presentations/${grantedDeck}/collaborators`,
      json({ email: GUEST.email }, { cookie: ownerCookie })
    )
  );
  guestClaimToken = invited.claimUrl.split('/collab/')[1] as string;
  const claimed = await app.app.request(
    '/api/v1/collaborators/claim',
    json({ token: guestClaimToken, name: GUEST.name, password: GUEST.password })
  );
  expect(claimed.status).toBe(200);
  guestUserId = (await readJson(claimed)).userId;

  guestCookie = extractCookie(
    await app.app.request(
      '/api/v1/auth/sign-in/email',
      json({ email: GUEST.email, password: GUEST.password })
    )
  );
  const minted = await readJson(
    await app.app.request(
      '/api/v1/api-keys',
      json(
        { name: 'guest-key', scopes: ['presentations:read', 'presentations:write'] },
        { cookie: guestCookie }
      )
    )
  );
  guestKey = minted.key;
}, 120_000);

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

async function expectGuestForbidden(res: Response): Promise<void> {
  expect(res.status).toBe(403);
  expect((await readJson(res)).error.code).toBe('guest_forbidden');
}

describe('what the guest KEEPS (ADR 013 per-deck surfaces, unchanged)', () => {
  it('reads the granted deck, and the ungranted sibling stays 404 (never 403)', async () => {
    const granted = await app.app.request(`/api/v1/presentations/${grantedDeck}`, {
      headers: { cookie: guestCookie }
    });
    expect(granted.status).toBe(200);

    const other = await app.app.request(`/api/v1/presentations/${otherDeck}`, {
      headers: { cookie: guestCookie }
    });
    expect(other.status).toBe(404);

    // The list pages only the collaboration.
    const list = await readJson(
      await app.app.request('/api/v1/presentations', { headers: { cookie: guestCookie } })
    );
    expect(list.presentations.map((p: { id: string }) => p.id)).toEqual([grantedDeck]);
  });

  it('pushes a version with the session (asset staging included) and manages share tokens', async () => {
    expect((await uploadAsset(HTML_V2, { cookie: guestCookie })).status).toBe(201);
    const push = await app.app.request(
      `/api/v1/presentations/${grantedDeck}/versions`,
      json(
        { expectedBaseVersion: 1, entryPath: 'index.html', manifest: [entryOf('index.html', HTML_V2)] },
        { cookie: guestCookie }
      )
    );
    expect(push.status).toBe(201);
    expect((await readJson(push)).version.createdByRole).toBe('dev');

    const token = await app.app.request(
      `/api/v1/presentations/${grantedDeck}/tokens`,
      json({ name: 'Guest-made link' }, { cookie: guestCookie })
    );
    expect(token.status).toBe(201);

    const annotations = await app.app.request(`/api/v1/presentations/${grantedDeck}/annotations`, {
      headers: { cookie: guestCookie }
    });
    expect(annotations.status).toBe(200);
  });

  it("the guest's own API key pushes to the granted deck too", async () => {
    const push = await app.app.request(
      `/api/v1/presentations/${grantedDeck}/versions`,
      json(
        { expectedBaseVersion: 2, entryPath: 'index.html', manifest: [entryOf('index.html', HTML_V1)] },
        { authorization: `Bearer ${guestKey}` }
      )
    );
    expect(push.status).toBe(201);
  });
});

describe('what the guest is REFUSED (403 guest_forbidden — D2, capability of origin)', () => {
  it('cannot create decks in the host workspace — session and API key alike', async () => {
    await expectGuestForbidden(
      await app.app.request('/api/v1/presentations/uploads', {
        method: 'POST',
        headers: { cookie: guestCookie }
      })
    );
    await expectGuestForbidden(
      await app.app.request('/api/v1/presentations/uploads', {
        method: 'POST',
        headers: { authorization: `Bearer ${guestKey}` }
      })
    );
    // The commit leg is gated independently (defense in depth).
    await expectGuestForbidden(
      await app.app.request(
        `/api/v1/presentations/uploads/00000000-0000-4000-8000-000000000000/commit`,
        json(
          { title: 'X', entryPath: 'index.html', manifest: [entryOf('index.html', HTML_V1)] },
          { cookie: guestCookie }
        )
      )
    );
  });

  it('cannot touch the generic /files surface — reads INCLUDED (deck-content bypass)', async () => {
    await expectGuestForbidden(await app.app.request('/api/v1/files', { headers: { cookie: guestCookie } }));
    await expectGuestForbidden(
      await app.app.request('/api/v1/files?name=x.bin', {
        method: 'POST',
        headers: { cookie: guestCookie },
        body: 'zz'
      })
    );
    await expectGuestForbidden(
      await app.app.request('/api/v1/files/00000000-0000-4000-8000-000000000000/content', {
        headers: { cookie: guestCookie }
      })
    );
    await expectGuestForbidden(
      await app.app.request('/api/v1/files/00000000-0000-4000-8000-000000000000', {
        method: 'DELETE',
        headers: { cookie: guestCookie }
      })
    );
    // The API key path hits the same wall (scope opens the door, origin rules).
    await expectGuestForbidden(
      await app.app.request('/api/v1/files', { headers: { authorization: `Bearer ${guestKey}` } })
    );
  });

  it('cannot read the member roster or the workspace export', async () => {
    await expectGuestForbidden(
      await app.app.request('/api/v1/members', { headers: { cookie: guestCookie } })
    );
    await expectGuestForbidden(
      await app.app.request('/api/v1/workspace/export', {
        headers: { cookie: guestCookie, 'x-forwarded-for': nextIp() }
      })
    );
  });
});

describe('/me tells clients how to adapt (P7 additions, oss values)', () => {
  it("the guest's /me carries origin='guest' so the dashboard hides the guest-forbidden surfaces", async () => {
    const res = await app.app.request('/api/v1/me', { headers: { cookie: guestCookie } });
    expect(res.status).toBe(200);
    const me = await readJson(res);
    expect(me.origin).toBe('guest');
    // oss: nothing is a hub projection and there is no hub to link out to.
    expect(me.workspace.hubOrigin).toBe(false);
    expect(me.workspaces.every((w: { hubOrigin: boolean }) => w.hubOrigin === false)).toBe(true);
    expect(me.hubManageUrl).toBeNull();
  });

  it("a regular member's /me stays origin='local'", async () => {
    const res = await app.app.request('/api/v1/me', { headers: { cookie: ownerCookie } });
    const me = await readJson(res);
    expect(me.origin).toBe('local');
    expect(me.workspace.hubOrigin).toBe(false);
    expect(me.hubManageUrl).toBeNull();
  });
});

describe('the guest role-lock (origin is a capability axis nothing upgrades)', () => {
  let guestMembershipId: string;

  beforeAll(async () => {
    const [row] = await app.db.db
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.userId, guestUserId), eq(workspaceMembers.origin, 'guest')));
    guestMembershipId = row!.id;
  });

  it('an admin cannot promote a guest row (403 guest_role_locked)', async () => {
    const res = await app.app.request(`/api/v1/members/${guestMembershipId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ role: 'admin' })
    });
    expect(res.status).toBe(403);
    expect((await readJson(res)).error.code).toBe('guest_role_locked');
  });

  it('deactivating (and reactivating) a guest stays available', async () => {
    const off = await app.app.request(`/api/v1/members/${guestMembershipId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ isActive: false })
    });
    expect(off.status).toBe(200);
    // A deactivated guest resolves to no principal at all.
    const read = await app.app.request(`/api/v1/presentations/${grantedDeck}`, {
      headers: { cookie: guestCookie }
    });
    expect(read.status).toBe(401);

    const on = await app.app.request(`/api/v1/members/${guestMembershipId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ isActive: true })
    });
    expect(on.status).toBe(200);
    expect(
      (await app.app.request(`/api/v1/presentations/${grantedDeck}`, { headers: { cookie: guestCookie } }))
        .status
    ).toBe(200);
  });

  it('a deactivated guest cannot self-reactivate by replaying their claim token (G1 fallback stays a mint, not a switch)', async () => {
    // The admin cutoff…
    const off = await app.app.request(`/api/v1/members/${guestMembershipId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ isActive: false })
    });
    expect(off.status).toBe(200);

    // …must not be undone by the guest re-POSTing the (active, owned) grant
    // token: the fallback resolves it, but an inactive membership answers
    // the same 404 a dead token gets — only a FRESH invite (pending grant)
    // reactivates.
    const replay = await app.app.request(
      '/api/v1/collaborators/claim',
      json({ token: guestClaimToken }, { cookie: guestCookie })
    );
    expect(replay.status).toBe(404);

    const [row] = await app.db.db
      .select({ isActive: workspaceMembers.isActive })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.id, guestMembershipId));
    expect(row!.isActive).toBe(false);

    // Restore for the suites below (the admin act still works).
    const on = await app.app.request(`/api/v1/members/${guestMembershipId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ isActive: true })
    });
    expect(on.status).toBe(200);
  });
});

describe('the OAuth-bearer leg (the third credential kind — MCP rides this)', () => {
  it('a bearer JWT resolving the guest membership carries origin=guest from the LIVE row', async () => {
    // Verifier-direct, the oauth-workspace.test.ts pattern (the full
    // authorize/consent/token dance is exercised there): sign a JWT for the
    // guest bound to the host workspace against a fake JWKS and resolve it
    // through the REAL OauthJwtVerifier. The load-bearing link this pins is
    // that the oauth resolver reads origin from the membership row — the
    // token itself carries NO origin claim to spoof. requireNonGuest judges
    // the resolved principal identically for all three credential kinds
    // (proven above with sessions and API keys), so origin='guest' here is
    // exactly the 403 guest_forbidden wall for OAuth bearers and MCP.
    const [guestRow] = await app.db.db
      .select({ workspaceId: workspaceMembers.workspaceId })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.userId, guestUserId), eq(workspaceMembers.origin, 'guest')));
    const hostWorkspaceId = guestRow!.workspaceId;

    const base = 'http://guest-caps.test';
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), alg: 'RS256', kid: 'guest-caps' };
    const fakeAuth = { api: { getJwks: async () => ({ keys: [jwk] }) } } as unknown as Auth;
    const verifier = new OauthJwtVerifier(fakeAuth, app.db.db, base);

    const token = await new SignJWT({
      scope: 'presentations:read presentations:write'
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'guest-caps' })
      .setIssuer(base)
      .setAudience(`${base}/mcp`)
      .setSubject(guestUserId)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);

    // The workspace is a per-request SELECTOR now (user-scoped model), never
    // a token claim — the guest origin must ride the live membership either way.
    const principal = await verifier.resolve(token, hostWorkspaceId);
    expect(principal).toMatchObject({
      userId: guestUserId,
      workspaceId: hostWorkspaceId,
      role: 'member',
      origin: 'guest',
      via: 'oauth'
    });
  });
});

describe('ordinary members are untouched (the guard keys on origin, not role)', () => {
  let memberCookie: string;

  beforeAll(async () => {
    const invited = await readJson(
      await app.app.request(
        '/api/v1/invitations',
        json({ email: MEMBER.email, role: 'member' }, { cookie: ownerCookie })
      )
    );
    await app.app.request(
      '/api/v1/invitations/accept',
      json({ token: invited.acceptUrl.split('/invite/')[1], name: MEMBER.name, password: MEMBER.password })
    );
    memberCookie = extractCookie(
      await app.app.request(
        '/api/v1/auth/sign-in/email',
        json({ email: MEMBER.email, password: MEMBER.password })
      )
    );
  });

  it('a plain member still creates decks, uses /files, and reads the roster', async () => {
    await uploadAsset(HTML_V1, { cookie: memberCookie });
    const deck = await createDeck('Member Deck', { cookie: memberCookie });
    expect(deck).toBeTruthy();

    const files = await app.app.request('/api/v1/files', { headers: { cookie: memberCookie } });
    expect(files.status).toBe(200);

    const roster = await app.app.request('/api/v1/members', { headers: { cookie: memberCookie } });
    expect(roster.status).toBe(200);
  });

  it("a member's role change still works (the lock is guest-only)", async () => {
    const { rows } = await app.db.pool.query(
      `SELECT m.id FROM workspace_members m JOIN "user" u ON u.id = m.user_id WHERE u.email = $1`,
      [MEMBER.email]
    );
    const res = await app.app.request(`/api/v1/members/${rows[0].id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ role: 'admin' })
    });
    expect(res.status).toBe(200);
    expect((await readJson(res)).role).toBe('admin');
  });
});
