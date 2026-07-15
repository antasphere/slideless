import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { collaborators } from '@slideless/db';
import {
  createDatabase,
  createTestApp,
  extractCookie,
  readJson,
  startPostgres,
  type TestApp
} from './helpers.js';
import { FakeHub, type HubUserFixture } from '../fake-hub.js';
import * as sso from './sso-helpers.js';

/**
 * Phase 6 — the cloud SSO-first collaborator claim journey (docs/federation.md;
 * binding plan §5), against the FakeHub:
 *
 *  - On EDITION=cloud the claim endpoint's account-creation branch is CLOSED
 *    (409 sso_required): identity is hub-only (D1), so a brand-new invitee
 *    goes through "Sign in with Antasphere" — the SAME P3 entrance as any
 *    cloud login (JIT + the deliberate fourth signup switch), opening no new
 *    signup hole. No local-password account is ever minted for a guest.
 *  - The JIT login's user.created sweep flips the grant to ACTIVE before the
 *    claim POST arrives — the exact G1 cross-request sequence. The claim
 *    still answers success for the grant's owner and mints the origin='guest'
 *    membership in the DECK's workspace; the public lookup stays pending-only
 *    (no deck metadata for used tokens), and other users stay at 404.
 *  - No hub org membership is created anywhere in this path: the guest ends
 *    with exactly two local memberships — their OWN projected workspace
 *    (origin='hub') and the deck workspace guest row — and the deck
 *    workspace remains unprojected (centralAccountId NULL).
 *  - The D2 capability limits hold per-workspace on cloud: deck creation is
 *    refused in the HOST workspace (403 guest_forbidden) but works in the
 *    guest's own projected workspace — the capability keys on the origin of
 *    the membership backing the request's workspace.
 */

const OWNER = { email: 'owner@cloudcollab.test', name: 'Cloud Host', password: 'cloud-owner-pass-1' };
const GUEST_EMAIL = 'guest@cloudcollab.test';
const ORG_GUEST = '22222222-bbbb-4ccc-8ddd-000000000001';
const ORG_OTHER = '22222222-bbbb-4ccc-8ddd-000000000002';

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
let hub: FakeHub;
let app: TestApp;
let ownerCookie: string;
/** The deck's (setup) workspace — where the guest row lands. */
let hostWorkspaceId: string;
let deckId: string;
let claimToken: string;
let guestCookie: string;
let guestUserId: string;
/** The guest's OWN projected workspace (origin='hub'). */
let projectedWorkspaceId: string;

// Public claim/lookup ride the tight invitation-accept wall; TRUST_PROXY is
// on in tests so every request brings a fresh forwarded address.
let ipCounter = 0;
const nextIp = () => `10.97.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp(), ...headers },
  body: JSON.stringify(body)
});

const guest: HubUserFixture = {
  sub: 'hub-guest-1',
  email: GUEST_EMAIL,
  name: 'Guest One',
  workspaceId: ORG_GUEST,
  role: 'owner', // owner of their OWN personal org — irrelevant to the deck workspace
  workspaceName: 'Guest Personal'
};

async function uploadAsset(bytes: Buffer, headers: Record<string, string>): Promise<void> {
  const form = new FormData();
  form.set('sha256', shaOf(bytes));
  form.set('file', new Blob([new Uint8Array(bytes)], { type: 'text/html' }), 'index.html');
  const res = await app.app.request('/api/v1/presentations/assets', { method: 'POST', headers, body: form });
  expect(res.status).toBe(201);
}

async function grantStatus(grantId: string): Promise<string> {
  const [row] = await app.db.db
    .select({ status: collaborators.status })
    .from(collaborators)
    .where(eq(collaborators.id, grantId));
  return row!.status;
}

/** The user.created sweep fires async on the event bus — poll briefly. */
async function waitActive(grantId: string): Promise<void> {
  let status = 'pending';
  for (let i = 0; i < 40 && status !== 'active'; i++) {
    status = await grantStatus(grantId);
    if (status !== 'active') await new Promise((r) => setTimeout(r, 50));
  }
  expect(status).toBe('active');
}

let grantId: string;

beforeAll(async () => {
  [container, hub] = await Promise.all([startPostgres(), FakeHub.start()]);
  app = await createTestApp(await createDatabase(container, 'collab_cloud'), {
    EDITION: 'cloud',
    HUB_ISSUER_URL: hub.issuer,
    HUB_CLIENT_ID: 'tool-slideless-cloud',
    HUB_CLIENT_SECRET: 'integration-test-hub-secret-0001'
  });
  const setup = await readJson(
    await app.app.request('/api/v1/setup', json({ instanceName: 'CloudCollab', owner: OWNER }))
  );
  hostWorkspaceId = setup.workspaceId;
  // D1 hides the password entrance but keeps it WIRED (break-glass posture,
  // platform/edition.ts) — the operator session for the fixture rides it.
  ownerCookie = extractCookie(
    await app.app.request(
      '/api/v1/auth/sign-in/email',
      json({ email: OWNER.email, password: OWNER.password })
    )
  );
  await uploadAsset(HTML_V1, { cookie: ownerCookie });
  const reserve = await readJson(
    await app.app.request('/api/v1/presentations/uploads', {
      method: 'POST',
      headers: { cookie: ownerCookie }
    })
  );
  deckId = reserve.uploadSession.presentationId;
  const commit = await app.app.request(
    `/api/v1/presentations/uploads/${reserve.uploadSession.id}/commit`,
    json(
      { title: 'Cloud Deck', entryPath: 'index.html', manifest: [entryOf('index.html', HTML_V1)] },
      { cookie: ownerCookie }
    )
  );
  expect(commit.status).toBe(201);

  const invited = await readJson(
    await app.app.request(
      `/api/v1/presentations/${deckId}/collaborators`,
      json({ email: GUEST_EMAIL }, { cookie: ownerCookie })
    )
  );
  grantId = invited.collaborator.id;
  claimToken = invited.claimUrl.split('/collab/')[1] as string;
}, 180_000);

afterAll(async () => {
  await app?.stop();
  await Promise.all([container?.stop(), hub?.stop()]);
});

describe('the SSO-first claim journey (new invitee, cloud)', () => {
  it('the local-password entrance is CLOSED on cloud: anonymous claim answers 409 sso_required', async () => {
    // With credentials in the body (the oss create-account shape)…
    const withCreds = await app.app.request(
      '/api/v1/collaborators/claim',
      json({ token: claimToken, name: 'Guest One', password: 'a-perfectly-fine-password' })
    );
    expect(withCreds.status).toBe(409);
    expect((await readJson(withCreds)).error.code).toBe('sso_required');
    // …and without — the answer never depends on the body shape.
    const bare = await app.app.request('/api/v1/collaborators/claim', json({ token: claimToken }));
    expect(bare.status).toBe(409);
    expect((await readJson(bare)).error.code).toBe('sso_required');
    // Nothing was minted.
    expect(await grantStatus(grantId)).toBe('pending');
    const { rows } = await app.db.pool.query(`SELECT 1 FROM "user" WHERE email = $1`, [GUEST_EMAIL]);
    expect(rows).toHaveLength(0);
  });

  it('SSO login (the P3 entrance) JIT-creates the user and the sweep flips the grant — the G1 sequence', async () => {
    guestCookie = await sso.ssoLogin(app, hub, guest);
    await waitActive(grantId);

    const { rows: users } = await app.db.pool.query(`SELECT id FROM "user" WHERE email = $1`, [GUEST_EMAIL]);
    expect(users).toHaveLength(1);
    guestUserId = users[0].id;

    // Hub identity only — NO local-password (credential) account exists.
    const { rows: accounts } = await app.db.pool.query(`SELECT provider_id FROM account WHERE user_id = $1`, [
      guestUserId
    ]);
    expect(accounts.map((a: { provider_id: string }) => a.provider_id)).toEqual(['antasphere']);

    const { rows: ws } = await app.db.pool.query(`SELECT id FROM workspaces WHERE central_account_id = $1`, [
      ORG_GUEST
    ]);
    expect(ws).toHaveLength(1);
    projectedWorkspaceId = ws[0].id;
  });

  it('the public lookup stays pending-only: the swept token resolves nothing there', async () => {
    const res = await app.app.request(`/api/v1/collaborators/lookup?token=${claimToken}`, {
      headers: { 'x-forwarded-for': nextIp() }
    });
    expect(res.status).toBe(404);
  });

  it('the claim POST (signed in via SSO) reads as success and mints ONLY the guest row in the deck workspace', async () => {
    const res = await app.app.request(
      '/api/v1/collaborators/claim',
      json({ token: claimToken }, { cookie: guestCookie })
    );
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.workspaceId).toBe(hostWorkspaceId);
    expect(body.userId).toBe(guestUserId);
    expect(body.collaborator.status).toBe('active');

    // Exactly two memberships: the projected personal workspace (hub) and
    // the deck workspace guest row. No hub org membership anywhere — the
    // deck workspace stays unprojected.
    const { rows: memberships } = await app.db.pool.query(
      `SELECT m.workspace_id, m.role, m.origin, m.is_active, w.central_account_id
         FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
        WHERE m.user_id = $1 ORDER BY m.created_at`,
      [guestUserId]
    );
    expect(memberships).toHaveLength(2);
    expect(memberships[0]).toMatchObject({
      workspace_id: projectedWorkspaceId,
      role: 'owner',
      origin: 'hub',
      is_active: true,
      central_account_id: ORG_GUEST
    });
    expect(memberships[1]).toMatchObject({
      workspace_id: hostWorkspaceId,
      role: 'member',
      origin: 'guest',
      is_active: true,
      central_account_id: null
    });

    // Still no local-password account after the claim.
    const { rows: accounts } = await app.db.pool.query(`SELECT provider_id FROM account WHERE user_id = $1`, [
      guestUserId
    ]);
    expect(accounts.map((a: { provider_id: string }) => a.provider_id)).toEqual(['antasphere']);
  });

  it('a DIFFERENT hub user presenting the used token stays at 404 (no leak, no theft)', async () => {
    const otherCookie = await sso.ssoLogin(app, hub, {
      sub: 'hub-other-1',
      email: 'other@cloudcollab.test',
      name: 'Other One',
      workspaceId: ORG_OTHER,
      role: 'owner',
      workspaceName: 'Other Org'
    });
    const res = await app.app.request(
      '/api/v1/collaborators/claim',
      json({ token: claimToken }, { cookie: otherCookie })
    );
    expect(res.status).toBe(404);
  });
});

describe('the cloud guest journey (D2 limits hold per-workspace)', () => {
  it('reads and pushes the granted deck in the HOST workspace', async () => {
    const read = await app.app.request(`/api/v1/presentations/${deckId}`, {
      headers: { cookie: guestCookie, 'x-workspace-id': hostWorkspaceId }
    });
    expect(read.status).toBe(200);

    await uploadAsset(HTML_V2, { cookie: guestCookie, 'x-workspace-id': hostWorkspaceId });
    const push = await app.app.request(
      `/api/v1/presentations/${deckId}/versions`,
      json(
        { expectedBaseVersion: 1, entryPath: 'index.html', manifest: [entryOf('index.html', HTML_V2)] },
        { cookie: guestCookie, 'x-workspace-id': hostWorkspaceId }
      )
    );
    expect(push.status).toBe(201);
    expect((await readJson(push)).version.createdByRole).toBe('dev');
  });

  it('deck creation: 403 guest_forbidden in the host workspace, 201 in their OWN projected workspace', async () => {
    const inHost = await app.app.request('/api/v1/presentations/uploads', {
      method: 'POST',
      headers: { cookie: guestCookie, 'x-workspace-id': hostWorkspaceId }
    });
    expect(inHost.status).toBe(403);
    expect((await readJson(inHost)).error.code).toBe('guest_forbidden');

    const inOwn = await app.app.request('/api/v1/presentations/uploads', {
      method: 'POST',
      headers: { cookie: guestCookie, 'x-workspace-id': projectedWorkspaceId }
    });
    expect(inOwn.status).toBe(201);
  });

  it('the /files surface and member roster of the host workspace stay closed to the guest', async () => {
    const files = await app.app.request('/api/v1/files', {
      headers: { cookie: guestCookie, 'x-workspace-id': hostWorkspaceId }
    });
    expect(files.status).toBe(403);
    expect((await readJson(files)).error.code).toBe('guest_forbidden');

    const roster = await app.app.request('/api/v1/members', {
      headers: { cookie: guestCookie, 'x-workspace-id': hostWorkspaceId }
    });
    expect(roster.status).toBe(403);
    expect((await readJson(roster)).error.code).toBe('guest_forbidden');
  });

  it('guest rows stay OUT of the hub enforcement (separation intact): the hub never lists the deck workspace', async () => {
    // The guest's own hub org list (their /orgs) does NOT contain the deck
    // workspace's org — a reconcile sweep that touched guest rows would
    // deactivate this grant. The guest keeps working because the sweep and
    // the live gate key on origin='hub' rows only.
    const read = await app.app.request(`/api/v1/presentations/${deckId}`, {
      headers: { cookie: guestCookie, 'x-workspace-id': hostWorkspaceId }
    });
    expect(read.status).toBe(200);
  });
});
