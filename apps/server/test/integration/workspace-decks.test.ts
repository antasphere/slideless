import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { and, eq } from 'drizzle-orm';
import { workspaceMembers } from '@slideless/db';
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
 * The Slideless-specific workspace-scoping surface (ADR 014 × ADR 013):
 *
 *  - X-Workspace-Id switches DECK listings, not just platform data;
 *  - a collaborator claimed into TWO different customer workspaces holds two
 *    memberships, resolves DETERMINISTICALLY (oldest first), and reaches
 *    BOTH decks through the switcher path (header per workspace);
 *  - the ADR-013 deck-read privacy invariant is UNCHANGED under
 *    workspace-scoped principals: workspace membership alone is never a
 *    deck read grant, whatever header the request carries; failed reads
 *    answer 404, never 403; the list WHERE scope stays owner/collab for
 *    plain members and workspace-wide for admins — per ACTIVE workspace.
 */

const OWNER1 = { email: 'owner1@wsdeck.test', name: 'W1 Owner', password: 'w1-owner-password-123' };
const OWNER2 = { email: 'owner2@wsdeck.test', name: 'W2 Owner', password: 'w2-owner-password-123' };
const GUEST = { email: 'guest@wsdeck.test', name: 'Guest Dev', password: 'guest-dev-password-123' };
const MALLORY = { email: 'mallory@wsdeck.test', name: 'Mallory Member', password: 'mallory-password-123' };

const WS_HEADER = 'x-workspace-id';
const HTML = Buffer.from('<!doctype html><html><body><h1>ws</h1></body></html>');
const shaOf = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

let container: StartedPostgreSqlContainer;
let app: TestApp;
let mail: RecordingEmailDriver;
let owner1Cookie = '';
let owner2Cookie = '';
let w1 = '';
let w2 = '';
let deckA = ''; // lives in W1, owned by OWNER1
let deckB = ''; // lives in W2, owned by OWNER2

// The public claim routes ride the tight invitation-accept wall (10/h/IP);
// TRUST_PROXY=true in tests, so rotate forwarded addresses.
let ipCounter = 0;
const nextIp = () => `10.77.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

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

async function uploadAsset(cookie: string, workspace?: string): Promise<void> {
  const form = new FormData();
  form.set('sha256', shaOf(HTML));
  form.set('file', new Blob([new Uint8Array(HTML)], { type: 'text/html' }), 'index.html');
  const res = await app.app.request('/api/v1/presentations/assets', {
    method: 'POST',
    headers: { cookie, ...(workspace ? { [WS_HEADER]: workspace } : {}) },
    body: form
  });
  expect(res.status).toBe(201);
}

async function createDeck(cookie: string, title: string, workspace?: string): Promise<string> {
  const wsHeader = workspace ? { [WS_HEADER]: workspace } : {};
  const reserve = await readJson(
    await app.app.request('/api/v1/presentations/uploads', {
      method: 'POST',
      headers: { cookie, ...wsHeader }
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
      { cookie, ...wsHeader }
    )
  );
  expect(commit.status).toBe(201);
  return reserve.uploadSession.presentationId;
}

/** Invite GUEST to a deck and return the copyable claim token. */
async function inviteGuest(deck: string, cookie: string): Promise<string> {
  const res = await app.app.request(
    `/api/v1/presentations/${deck}/collaborators`,
    json({ email: GUEST.email }, { cookie })
  );
  expect(res.status).toBe(201);
  const body = await readJson(res);
  return body.claimUrl.split('/collab/')[1] as string;
}

beforeAll(async () => {
  container = await startPostgres();
  mail = new RecordingEmailDriver();
  app = await createTestApp(await createDatabase(container, 'ws_decks'), {}, { email: mail });

  const setup = await app.app.request(
    '/api/v1/setup',
    json({ setupToken: 'integration-test-setup-token', instanceName: 'Deck W1', owner: OWNER1 })
  );
  expect(setup.status).toBe(201);
  w1 = (await readJson(setup)).workspaceId;
  owner1Cookie = await signIn(OWNER1.email, OWNER1.password);

  // Second customer workspace, owned by a different account.
  const owner2 = await app.auth.api.signUpEmail({
    body: { email: OWNER2.email, password: OWNER2.password, name: OWNER2.name }
  });
  w2 = (await app.registry.workspaces.create('Deck W2', owner2.user.id)).workspaceId;
  owner2Cookie = await signIn(OWNER2.email, OWNER2.password);

  // One deck per workspace, each owned by its workspace's owner.
  await uploadAsset(owner1Cookie);
  deckA = await createDeck(owner1Cookie, 'Deck A (W1)');
  await uploadAsset(owner2Cookie); // owner2's sole membership resolves to W2
  deckB = await createDeck(owner2Cookie, 'Deck B (W2)');
}, 240_000);

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

describe('X-Workspace-Id switches deck listings', () => {
  it('an admin of two workspaces pages each workspace’s decks per header', async () => {
    // OWNER1 joins W2 as an ADMIN (workspace-wide read under ADR 013).
    const me1 = await readJson(await app.app.request('/api/v1/me', { headers: { cookie: owner1Cookie } }));
    await app.db.db.insert(workspaceMembers).values({ workspaceId: w2, userId: me1.user.id, role: 'admin' });

    // No header: the OLDEST membership (W1) — deck A only.
    const listW1 = await readJson(
      await app.app.request('/api/v1/presentations', { headers: { cookie: owner1Cookie } })
    );
    expect(listW1.presentations.map((p: { id: string }) => p.id)).toEqual([deckA]);

    // Header W2: deck B only (admin sees the whole workspace).
    const listW2 = await readJson(
      await app.app.request('/api/v1/presentations', {
        headers: { cookie: owner1Cookie, [WS_HEADER]: w2 }
      })
    );
    expect(listW2.presentations.map((p: { id: string }) => p.id)).toEqual([deckB]);

    // A deck id from W2 is NOT reachable in the W1 context — 404, no leak.
    const cross = await app.app.request(`/api/v1/presentations/${deckB}`, {
      headers: { cookie: owner1Cookie }
    });
    expect(cross.status).toBe(404);
    // And reachable with the right header (admin read).
    const scoped = await app.app.request(`/api/v1/presentations/${deckB}`, {
      headers: { cookie: owner1Cookie, [WS_HEADER]: w2 }
    });
    expect(scoped.status).toBe(200);
  });
});

describe('a collaborator claimed into TWO customer workspaces (the switcher path)', () => {
  let guestCookie = '';

  it('claims deck A (new account) then deck B (signed in) — two guest memberships', async () => {
    const tokenA = await inviteGuest(deckA, owner1Cookie);
    const claimA = await app.app.request(
      '/api/v1/collaborators/claim',
      json({ token: tokenA, name: GUEST.name, password: GUEST.password })
    );
    expect(claimA.status).toBe(200);
    const guestId = (await readJson(claimA)).userId as string;

    guestCookie = await signIn(GUEST.email, GUEST.password);

    const tokenB = await inviteGuest(deckB, owner2Cookie);
    const claimB = await app.app.request(
      '/api/v1/collaborators/claim',
      json({ token: tokenB }, { cookie: guestCookie })
    );
    expect(claimB.status).toBe(200);

    // Two memberships, both guest-origin (G2), one per customer workspace.
    const rows = await app.db.db
      .select({
        workspaceId: workspaceMembers.workspaceId,
        origin: workspaceMembers.origin,
        role: workspaceMembers.role
      })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, guestId));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.origin === 'guest' && r.role === 'member')).toBe(true);
    expect(rows.map((r) => r.workspaceId).sort()).toEqual([w1, w2].sort());
  });

  it('resolves deterministically without the header: the OLDEST membership (W1)', async () => {
    const me = await readJson(await app.app.request('/api/v1/me', { headers: { cookie: guestCookie } }));
    expect(me.activeWorkspaceId).toBe(w1);
    expect(me.workspaces.map((w: { id: string }) => w.id)).toEqual([w1, w2]);
  });

  it('reaches BOTH decks — each through its workspace context', async () => {
    // Deck A in the default (W1) context.
    const a = await app.app.request(`/api/v1/presentations/${deckA}`, {
      headers: { cookie: guestCookie }
    });
    expect(a.status).toBe(200);
    // Deck B needs the W2 header — the switcher path.
    const bWrongCtx = await app.app.request(`/api/v1/presentations/${deckB}`, {
      headers: { cookie: guestCookie }
    });
    expect(bWrongCtx.status).toBe(404); // W1 context: deck B does not exist here
    const b = await app.app.request(`/api/v1/presentations/${deckB}`, {
      headers: { cookie: guestCookie, [WS_HEADER]: w2 }
    });
    expect(b.status).toBe(200);

    // Each workspace's listing shows exactly the deck they collaborate on.
    const listW1 = await readJson(
      await app.app.request('/api/v1/presentations', { headers: { cookie: guestCookie } })
    );
    expect(listW1.presentations.map((p: { id: string }) => p.id)).toEqual([deckA]);
    const listW2 = await readJson(
      await app.app.request('/api/v1/presentations', {
        headers: { cookie: guestCookie, [WS_HEADER]: w2 }
      })
    );
    expect(listW2.presentations.map((p: { id: string }) => p.id)).toEqual([deckB]);
  });
});

describe('ADR-013 deck privacy is UNCHANGED under workspace-scoped principals', () => {
  let malloryCookie = '';

  beforeAll(async () => {
    // Mallory: an ordinary W1 member via workspace invitation — NO grant on
    // deck A, not an admin.
    const inv = await readJson(
      await app.app.request(
        '/api/v1/invitations',
        json({ email: MALLORY.email, role: 'member' }, { cookie: owner1Cookie })
      )
    );
    const accept = await app.app.request(
      '/api/v1/invitations/accept',
      json({
        token: inv.acceptUrl.split('/invite/')[1],
        name: MALLORY.name,
        password: MALLORY.password
      })
    );
    expect(accept.status).toBe(200);
    malloryCookie = await signIn(MALLORY.email, MALLORY.password);
  });

  it('workspace membership alone is not a read grant — 404, never 403, header or not', async () => {
    const plain = await app.app.request(`/api/v1/presentations/${deckA}`, {
      headers: { cookie: malloryCookie }
    });
    expect(plain.status).toBe(404);
    // An explicit header naming her OWN workspace changes nothing.
    const withHeader = await app.app.request(`/api/v1/presentations/${deckA}`, {
      headers: { cookie: malloryCookie, [WS_HEADER]: w1 }
    });
    expect(withHeader.status).toBe(404);
    // Version list + asset bytes are equally invisible.
    const versions = await app.app.request(`/api/v1/presentations/${deckA}/versions`, {
      headers: { cookie: malloryCookie, [WS_HEADER]: w1 }
    });
    expect(versions.status).toBe(404);
    const asset = await app.app.request(`/api/v1/presentations/${deckA}/assets/${shaOf(HTML)}`, {
      headers: { cookie: malloryCookie, [WS_HEADER]: w1 }
    });
    expect(asset.status).toBe(404);
  });

  it('the list WHERE scope stays owner/collab for plain members', async () => {
    const list = await readJson(
      await app.app.request('/api/v1/presentations', {
        headers: { cookie: malloryCookie, [WS_HEADER]: w1 }
      })
    );
    expect(list.presentations).toEqual([]);
  });

  it('revoking a guest grant cuts deck access immediately — membership stays, reads die', async () => {
    // Owner2 revokes the guest's grant on deck B.
    const roster = await readJson(
      await app.app.request(`/api/v1/presentations/${deckB}/collaborators`, {
        headers: { cookie: owner2Cookie }
      })
    );
    const grant = roster.collaborators.find((c: { email: string }) => c.email === GUEST.email);
    expect(grant).toBeTruthy();
    const revoke = await app.app.request(`/api/v1/presentations/${deckB}/collaborators/${grant.id}`, {
      method: 'DELETE',
      headers: { cookie: owner2Cookie }
    });
    expect(revoke.status).toBe(200);

    // The guest's W2 membership row is untouched…
    const guestCookie = await signIn(GUEST.email, GUEST.password);
    const [row] = await app.db.db
      .select({ isActive: workspaceMembers.isActive })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, w2), eq(workspaceMembers.role, 'member')));
    expect(row?.isActive).toBe(true);
    // …but deck B is gone for them: 404 in the W2 context too.
    const read = await app.app.request(`/api/v1/presentations/${deckB}`, {
      headers: { cookie: guestCookie, [WS_HEADER]: w2 }
    });
    expect(read.status).toBe(404);
    const list = await readJson(
      await app.app.request('/api/v1/presentations', {
        headers: { cookie: guestCookie, [WS_HEADER]: w2 }
      })
    );
    expect(list.presentations).toEqual([]);
  });
});
