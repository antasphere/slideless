import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { user as userTable } from '@antasphere/chassis-db';
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
 * ADR 013 — deck reads are PRIVATE, not workspace-wide. Regression suite for
 * the Phase 5 adversarial findings:
 *
 *  1. (HIGH) A collaborator granted deck A could list and DOWNLOAD the
 *     content of every deck in the workspace (reads authorized on
 *     workspace_id alone), and revoking the grant did not cut reads off.
 *     Now: get / versions / version detail / asset download require
 *     canReadDeck (owner, workspace admin/owner, or an ACTIVE grant on THAT
 *     deck) and answer 404 — never 403 — otherwise; the list is scoped the
 *     same way while admins/owners keep the operator view.
 *  2. (LOW) Two concurrent claims of one invite both reached
 *     auth.api.signUpEmail; the loser's duplicate-email error escaped as a
 *     500. Now it maps to the same clean 409 account_exists the
 *     account-exists branch answers.
 */

const OWNER = { email: 'owner@privacy.test', name: 'Privacy Owner', password: 'privacy-owner-pass-1' };
const COLLAB = { email: 'reviewer@privacy.test', name: 'External Reviewer', password: 'reviewer-pass-1234' };
const MEMBER = { email: 'member@privacy.test', name: 'Plain Member', password: 'plain-member-pass-1' };
const ADMIN = { email: 'admin@privacy.test', name: 'Workspace Admin', password: 'ws-admin-pass-12345' };

const HTML_A = Buffer.from(
  '<!doctype html><html><body><h1>deck A — shared with the reviewer</h1></body></html>'
);
const HTML_B = Buffer.from(
  '<!doctype html><html><body><h1>deck B — the owner’s PRIVATE deck</h1></body></html>'
);
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
let adminCookie: string;
let memberCookie: string;
let collabCookie: string;
let collabKey: string;
let collaboratorId: string;
let deckA: string;
let deckB: string;

// The public claim/lookup routes share the tight invitation-accept wall
// (10/h per IP); TRUST_PROXY=true in tests, so requests carry unique
// forwarded addresses (the collaborators-suite pattern).
let ipCounter = 0;
const nextIp = () => `10.98.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp(), ...headers },
  body: JSON.stringify(body)
});

async function uploadAsset(bytes: Buffer, cookie: string): Promise<void> {
  const form = new FormData();
  form.set('sha256', shaOf(bytes));
  form.set('file', new Blob([new Uint8Array(bytes)], { type: 'text/html' }), 'index.html');
  const res = await app.app.request('/api/v1/presentations/assets', {
    method: 'POST',
    headers: { cookie },
    body: form
  });
  expect(res.status).toBe(201);
}

async function createDeck(title: string, bytes: Buffer): Promise<string> {
  const reserve = await readJson(
    await app.app.request('/api/v1/presentations/uploads', {
      method: 'POST',
      headers: { cookie: ownerCookie }
    })
  );
  const commit = await app.app.request(
    `/api/v1/presentations/uploads/${reserve.uploadSession.id}/commit`,
    json(
      { title, entryPath: 'index.html', manifest: [entryOf('index.html', bytes)] },
      { cookie: ownerCookie }
    )
  );
  expect(commit.status).toBe(201);
  return reserve.uploadSession.presentationId;
}

/** Join the workspace through an ordinary invitation; returns a session cookie. */
async function joinWorkspace(who: typeof MEMBER, role: 'member' | 'admin'): Promise<string> {
  const invited = await readJson(
    await app.app.request('/api/v1/invitations', json({ email: who.email, role }, { cookie: ownerCookie }))
  );
  const accept = await app.app.request(
    '/api/v1/invitations/accept',
    json({ token: invited.acceptUrl.split('/invite/')[1], name: who.name, password: who.password })
  );
  expect(accept.status).toBe(200);
  return extractCookie(
    await app.app.request('/api/v1/auth/sign-in/email', json({ email: who.email, password: who.password }))
  );
}

const signIn = async (who: typeof OWNER) =>
  extractCookie(
    await app.app.request('/api/v1/auth/sign-in/email', json({ email: who.email, password: who.password }))
  );

/** The four read endpoints of one deck, as one status snapshot. */
async function readStatuses(
  deck: string,
  headers: Record<string, string>,
  sha: string
): Promise<{ get: number; versions: number; versionDetail: number; asset: number }> {
  const [get, versions, versionDetail, asset] = await Promise.all([
    app.app.request(`/api/v1/presentations/${deck}`, { headers }),
    app.app.request(`/api/v1/presentations/${deck}/versions`, { headers }),
    app.app.request(`/api/v1/presentations/${deck}/versions/1`, { headers }),
    app.app.request(`/api/v1/presentations/${deck}/assets/${sha}`, { headers })
  ]);
  return {
    get: get.status,
    versions: versions.status,
    versionDetail: versionDetail.status,
    asset: asset.status
  };
}

const listIds = async (headers: Record<string, string>): Promise<string[]> => {
  const res = await app.app.request('/api/v1/presentations', { headers });
  expect(res.status).toBe(200);
  return ((await readJson(res)).presentations as Array<{ id: string }>).map((p) => p.id);
};

beforeAll(async () => {
  container = await startPostgres();
  mail = new RecordingEmailDriver();
  app = await createTestApp(await createDatabase(container, 'deck_read_privacy'), {}, { email: mail });
  await app.app.request(
    '/api/v1/setup',
    json({ setupToken: 'integration-test-setup-token', instanceName: 'Privacy', owner: OWNER })
  );
  ownerCookie = await signIn(OWNER);

  await uploadAsset(HTML_A, ownerCookie);
  await uploadAsset(HTML_B, ownerCookie);
  deckA = await createDeck('Deck A (reviewed)', HTML_A);
  deckB = await createDeck('Deck B (private)', HTML_B);

  // Invite + claim the external reviewer on deck A ONLY.
  const invited = await readJson(
    await app.app.request(
      `/api/v1/presentations/${deckA}/collaborators`,
      json({ email: COLLAB.email }, { cookie: ownerCookie })
    )
  );
  collaboratorId = invited.collaborator.id;
  const claim = await app.app.request(
    '/api/v1/collaborators/claim',
    json({ token: invited.claimUrl.split('/collab/')[1], name: COLLAB.name, password: COLLAB.password })
  );
  expect(claim.status).toBe(200);
  collabCookie = await signIn(COLLAB);
  collabKey = (
    await readJson(
      await app.app.request(
        '/api/v1/api-keys',
        json(
          { name: 'reviewer-key', scopes: ['presentations:read', 'presentations:write'] },
          { cookie: collabCookie }
        )
      )
    )
  ).key as string;

  memberCookie = await joinWorkspace(MEMBER, 'member');
  adminCookie = await joinWorkspace(ADMIN, 'admin');
}, 180_000);

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

describe('deck read privacy (ADR 013) — the original exploit is closed', () => {
  it('a deck-A collaborator 404s on EVERY deck-B read — session and their own API key', async () => {
    const denied = { get: 404, versions: 404, versionDetail: 404, asset: 404 };
    expect(await readStatuses(deckB, { cookie: collabCookie }, shaOf(HTML_B))).toEqual(denied);
    expect(await readStatuses(deckB, { authorization: `Bearer ${collabKey}` }, shaOf(HTML_B))).toEqual(
      denied
    );
  });

  it('the collaborator still reads deck A in full (grant honored)', async () => {
    const allowed = { get: 200, versions: 200, versionDetail: 200, asset: 200 };
    expect(await readStatuses(deckA, { cookie: collabCookie }, shaOf(HTML_A))).toEqual(allowed);
    expect(await readStatuses(deckA, { authorization: `Bearer ${collabKey}` }, shaOf(HTML_A))).toEqual(
      allowed
    );
    // The bytes really flow — and they are deck A's, not deck B's.
    const body = await (
      await app.app.request(`/api/v1/presentations/${deckA}/assets/${shaOf(HTML_A)}`, {
        headers: { cookie: collabCookie }
      })
    ).text();
    expect(body).toContain('deck A');
  });

  it('GET /presentations is scoped: collaborator sees A not B; plain member sees neither; admin and owner see both', async () => {
    const collabIds = await listIds({ cookie: collabCookie });
    expect(collabIds).toContain(deckA);
    expect(collabIds).not.toContain(deckB);
    expect(await listIds({ authorization: `Bearer ${collabKey}` })).toEqual(collabIds);

    expect(await listIds({ cookie: memberCookie })).toHaveLength(0);

    for (const cookie of [adminCookie, ownerCookie]) {
      const ids = await listIds({ cookie });
      expect(ids).toContain(deckA);
      expect(ids).toContain(deckB);
    }
  });

  it('a plain workspace member 404s on both decks (never a 403 — existence stays hidden)', async () => {
    for (const deck of [deckA, deckB]) {
      const bytes = deck === deckA ? HTML_A : HTML_B;
      expect(await readStatuses(deck, { cookie: memberCookie }, shaOf(bytes))).toEqual({
        get: 404,
        versions: 404,
        versionDetail: 404,
        asset: 404
      });
    }
  });

  it('a workspace admin reads any deck (the operator view)', async () => {
    expect(await readStatuses(deckB, { cookie: adminCookie }, shaOf(HTML_B))).toEqual({
      get: 200,
      versions: 200,
      versionDetail: 200,
      asset: 200
    });
  });

  it('revoking the deck-A grant cuts reads immediately: 404 everywhere, list drops A', async () => {
    const revoke = await app.app.request(`/api/v1/presentations/${deckA}/collaborators/${collaboratorId}`, {
      method: 'DELETE',
      headers: { cookie: ownerCookie }
    });
    expect(revoke.status).toBe(200);

    const denied = { get: 404, versions: 404, versionDetail: 404, asset: 404 };
    expect(await readStatuses(deckA, { cookie: collabCookie }, shaOf(HTML_A))).toEqual(denied);
    expect(await readStatuses(deckA, { authorization: `Bearer ${collabKey}` }, shaOf(HTML_A))).toEqual(
      denied
    );
    expect(await listIds({ cookie: collabCookie })).toHaveLength(0);
  });
});

describe('concurrent claim race (finding 2)', () => {
  it('two simultaneous first-claims of one invite: one 200, the loser a clean 409 — never 500; exactly one account', async () => {
    const email = 'racer@privacy.test';
    const invited = await readJson(
      await app.app.request(
        `/api/v1/presentations/${deckB}/collaborators`,
        json({ email }, { cookie: ownerCookie })
      )
    );
    const token = invited.claimUrl.split('/collab/')[1] as string;

    // Both requests pass the account lookup before either signUpEmail's
    // password hashing (tens of ms) finishes its INSERT — the loser hits the
    // unique-email violation inside Better Auth, which must map to 409.
    const claims = await Promise.all(
      [1, 2].map((i) =>
        app.app.request(
          '/api/v1/collaborators/claim',
          json({ token, name: `Racer ${i}`, password: 'racer-password-1234' })
        )
      )
    );
    const statuses = claims.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409]);
    const loser = claims.find((r) => r.status === 409)!;
    expect((await readJson(loser)).error.code).toBe('account_exists');

    // The DB unique constraint kept account creation exactly-once.
    const accounts = await app.db.db
      .select({ id: userTable.id })
      .from(userTable)
      .where(eq(userTable.email, email));
    expect(accounts).toHaveLength(1);
  });
});
