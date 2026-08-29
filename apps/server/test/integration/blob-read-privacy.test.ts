import { createHash } from 'node:crypto';
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
 * SL-B1 — per-deck authorization on the generic `/files` surface.
 *
 * The hole: `/files`, `GET /files/{id}` and `GET /files/{id}/content`
 * authorized on `principal.workspaceId` alone. Any plain member — and any
 * `presentations:read` API key — could list and stream the BYTES of every
 * deck in the workspace, one layer below the ADR 013 deck ACL that exists
 * precisely to stop that. A version commit then re-bound a foreign sha into
 * a deck of the attacker's own, so the stolen content could be re-published
 * anonymously through a share link.
 *
 * Now: blob reads carry the ADR 013 policy (`blobReadScope`) — uploaded by
 * you, or referenced by a live version of a deck you can read; workspace
 * admins/owners keep the operator view. Refusals are 404, never 403 (AUTH-5:
 * a blob you cannot read must not be probeable). `lockAndResolveBlobs`
 * resolves only readable shas, so a commit cannot bind what it cannot read,
 * and `precheckMissing` no longer answers as a workspace-wide existence
 * oracle.
 */

const OWNER = { email: 'owner@blobs.test', name: 'Blob Owner', password: 'blob-owner-password-1' };
const MEMBER = { email: 'member@blobs.test', name: 'Plain Member', password: 'blob-member-password-1' };
const ADMIN = { email: 'admin@blobs.test', name: 'Workspace Admin', password: 'blob-admin-password-11' };

/** The owner's private deck content — the bytes a member must never reach. */
const SECRET = Buffer.from('<!doctype html><h1>SL-B1 SECRET — the private deck of the owner</h1>');
/** A second private deck, used for the grant/revoke half of the suite. */
const SECRET_2 = Buffer.from('<!doctype html><h1>SL-B1 SECOND — the deck the member gets granted</h1>');
/** The member's own content — must stay fully readable to them. */
const MINE = Buffer.from('<!doctype html><h1>the plain member owns these bytes</h1>');

const shaOf = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const entryOf = (path: string, bytes: Buffer) => ({
  path,
  sha256: shaOf(bytes),
  sizeBytes: bytes.length,
  contentType: 'text/html'
});

let container: StartedPostgreSqlContainer;
let app: TestApp;
let ownerCookie: string;
let memberCookie: string;
let adminCookie: string;
let memberReadKey: string;
let secretFileId: string;
let secret2FileId: string;
let deckTwo: string;
let grantId: string;

// The claim/lookup routes share the tight invitation-accept wall (10/h per
// IP); TRUST_PROXY=true in tests, so give every request its own address.
let ipCounter = 0;
const nextIp = () => `10.77.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp(), ...headers },
  body: JSON.stringify(body)
});

const signIn = async (who: typeof OWNER) =>
  extractCookie(
    await app.app.request('/api/v1/auth/sign-in/email', json({ email: who.email, password: who.password }))
  );

async function uploadAsset(bytes: Buffer, cookie: string): Promise<Response> {
  const form = new FormData();
  form.set('sha256', shaOf(bytes));
  form.set('file', new Blob([new Uint8Array(bytes)], { type: 'text/html' }), 'index.html');
  return app.app.request('/api/v1/presentations/assets', { method: 'POST', headers: { cookie }, body: form });
}

/** Reserve a session and commit it — the deck-creation push protocol. */
async function createDeck(title: string, bytes: Buffer, cookie: string) {
  const reserve = await readJson(
    await app.app.request('/api/v1/presentations/uploads', { method: 'POST', headers: { cookie } })
  );
  const commit = await app.app.request(
    `/api/v1/presentations/uploads/${reserve.uploadSession.id}/commit`,
    json({ title, entryPath: 'index.html', manifest: [entryOf('index.html', bytes)] }, { cookie })
  );
  return {
    sessionId: reserve.uploadSession.id as string,
    deckId: reserve.uploadSession.presentationId as string,
    commit
  };
}

/** Join the workspace through an ordinary invitation (origin != guest). */
async function joinWorkspace(who: typeof MEMBER, role: 'member' | 'admin'): Promise<string> {
  const invited = await readJson(
    await app.app.request('/api/v1/invitations', json({ email: who.email, role }, { cookie: ownerCookie }))
  );
  const accept = await app.app.request(
    '/api/v1/invitations/accept',
    json({ token: invited.acceptUrl.split('/invite/')[1], name: who.name, password: who.password })
  );
  expect(accept.status).toBe(200);
  return signIn(who);
}

const fileIdOf = async (sha: string): Promise<string> => {
  const { rows } = await app.db.pool.query<{ id: string }>('SELECT id FROM files WHERE sha256 = $1', [sha]);
  expect(rows).toHaveLength(1);
  return rows[0]!.id;
};

const listFileIds = async (headers: Record<string, string>): Promise<string[]> => {
  const res = await app.app.request('/api/v1/files?limit=100', { headers });
  expect(res.status).toBe(200);
  return ((await readJson(res)).files as Array<{ id: string }>).map((f) => f.id);
};

/** Every read shape of one blob on the generic surface, as one snapshot. */
async function blobStatuses(
  id: string,
  headers: Record<string, string>
): Promise<{ meta: number; content: number; head: number }> {
  const [meta, content, head] = await Promise.all([
    app.app.request(`/api/v1/files/${id}`, { headers }),
    app.app.request(`/api/v1/files/${id}/content`, { headers }),
    app.app.request(`/api/v1/files/${id}/content`, { method: 'HEAD', headers })
  ]);
  return { meta: meta.status, content: content.status, head: head.status };
}

beforeAll(async () => {
  container = await startPostgres();
  app = await createTestApp(await createDatabase(container, 'blob_read_privacy'));
  await app.app.request(
    '/api/v1/setup',
    json({ setupToken: 'integration-test-setup-token', instanceName: 'Blobs', owner: OWNER })
  );
  ownerCookie = await signIn(OWNER);

  expect((await uploadAsset(SECRET, ownerCookie)).status).toBe(201);
  expect((await uploadAsset(SECRET_2, ownerCookie)).status).toBe(201);
  expect((await createDeck('Owner private deck', SECRET, ownerCookie)).commit.status).toBe(201);
  const two = await createDeck('Owner second deck', SECRET_2, ownerCookie);
  expect(two.commit.status).toBe(201);
  deckTwo = two.deckId;

  secretFileId = await fileIdOf(shaOf(SECRET));
  secret2FileId = await fileIdOf(shaOf(SECRET_2));

  memberCookie = await joinWorkspace(MEMBER, 'member');
  adminCookie = await joinWorkspace(ADMIN, 'admin');
  memberReadKey = (
    await readJson(
      await app.app.request(
        '/api/v1/api-keys',
        json({ name: 'member-ro', scopes: ['presentations:read'] }, { cookie: memberCookie })
      )
    )
  ).key as string;
}, 180_000);

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

describe('the whole-tenant blob read on /files is closed', () => {
  it('a plain member never sees another deck’s blob in the listing; admins and the owner do', async () => {
    const memberIds = await listFileIds({ cookie: memberCookie });
    expect(memberIds).not.toContain(secretFileId);
    expect(memberIds).not.toContain(secret2FileId);
    // Their own key is no wider than their session.
    expect(await listFileIds({ authorization: `Bearer ${memberReadKey}` })).toEqual(memberIds);

    for (const cookie of [ownerCookie, adminCookie]) {
      const ids = await listFileIds({ cookie });
      expect(ids).toContain(secretFileId);
      expect(ids).toContain(secret2FileId);
    }
  });

  it('a plain member 404s — never 403 — on the metadata, content and HEAD of a foreign blob', async () => {
    const denied = { meta: 404, content: 404, head: 404 };
    expect(await blobStatuses(secretFileId, { cookie: memberCookie })).toEqual(denied);
    expect(await blobStatuses(secretFileId, { authorization: `Bearer ${memberReadKey}` })).toEqual(denied);

    // Not one byte of the deck leaks, on any of the streaming shapes.
    for (const headers of [{ cookie: memberCookie }, { authorization: `Bearer ${memberReadKey}` }]) {
      for (const init of [{ headers }, { headers: { ...headers, range: 'bytes=0-10' } }]) {
        const res = await app.app.request(`/api/v1/files/${secretFileId}/content`, init);
        expect(res.status).toBe(404);
        expect(await res.text()).not.toContain('SECRET');
      }
    }
  });

  it('DELETE of a foreign blob 404s and leaves the row and the bytes untouched', async () => {
    const del = await app.app.request(`/api/v1/files/${secretFileId}`, {
      method: 'DELETE',
      headers: { cookie: memberCookie }
    });
    expect(del.status).toBe(404);

    // The side effect is absent: the row is still live…
    const { rows } = await app.db.pool.query<{ deleted_at: Date | null }>(
      'SELECT deleted_at FROM files WHERE id = $1',
      [secretFileId]
    );
    expect(rows[0]!.deleted_at).toBeNull();
    // …and the blob still streams for the operator.
    const still = await app.app.request(`/api/v1/files/${secretFileId}/content`, {
      headers: { cookie: ownerCookie }
    });
    expect(still.status).toBe(200);
    expect(await still.text()).toContain('SL-B1 SECRET');
  });

  it('the operator view is intact: owner and admin stream any workspace blob', async () => {
    for (const cookie of [ownerCookie, adminCookie]) {
      expect(await blobStatuses(secretFileId, { cookie })).toEqual({ meta: 200, content: 200, head: 200 });
    }
  });

  it('a member keeps full access to the blobs they uploaded themselves', async () => {
    const up = await app.app.request('/api/v1/files?name=mine.html', {
      method: 'POST',
      headers: { 'content-type': 'text/html', cookie: memberCookie },
      body: MINE.toString()
    });
    expect(up.status).toBe(201);
    const mineId = (await readJson(up)).file.id as string;

    expect(await blobStatuses(mineId, { cookie: memberCookie })).toEqual({
      meta: 200,
      content: 200,
      head: 200
    });
    expect(await listFileIds({ cookie: memberCookie })).toContain(mineId);
  });
});

describe('the commit guard: a manifest cannot bind a sha the caller cannot read', () => {
  it('an upload-session commit naming a foreign sha is refused and creates nothing', async () => {
    const reserve = await readJson(
      await app.app.request('/api/v1/presentations/uploads', {
        method: 'POST',
        headers: { cookie: memberCookie }
      })
    );
    const res = await app.app.request(
      `/api/v1/presentations/uploads/${reserve.uploadSession.id}/commit`,
      json(
        {
          title: 'Stolen deck',
          entryPath: 'index.html',
          manifest: [entryOf('index.html', SECRET)]
        },
        { cookie: memberCookie }
      )
    );
    expect(res.status).toBe(400);
    const body = await readJson(res);
    // Refused as MISSING, so the answer never confirms the workspace holds it.
    expect(body.error.code).toBe('missing_blobs');
    expect(body.error.details.missing).toContain(shaOf(SECRET));

    // The side effects are absent: no deck at the reserved id, and the
    // session is still unconsumed (a legitimate retry stays possible).
    const decks = await app.db.pool.query('SELECT 1 FROM presentations WHERE id = $1', [
      reserve.uploadSession.presentationId
    ]);
    expect(decks.rowCount).toBe(0);
    const session = await app.db.pool.query<{ consumed_at: Date | null }>(
      'SELECT consumed_at FROM upload_sessions WHERE id = $1',
      [reserve.uploadSession.id]
    );
    expect(session.rows[0]!.consumed_at).toBeNull();
  });

  it('a version commit cannot smuggle a foreign sha into the member’s OWN deck', async () => {
    expect((await uploadAsset(MINE, memberCookie)).status).toBe(201);
    const own = await createDeck('Member deck', MINE, memberCookie);
    expect(own.commit.status).toBe(201);

    const res = await app.app.request(
      `/api/v1/presentations/${own.deckId}/versions`,
      json(
        {
          expectedBaseVersion: 1,
          entryPath: 'index.html',
          manifest: [entryOf('index.html', MINE), entryOf('stolen.html', SECRET)]
        },
        { cookie: memberCookie }
      )
    );
    expect(res.status).toBe(400);
    expect((await readJson(res)).error.code).toBe('missing_blobs');

    // No version 2 was written and the counter did not move — so no share
    // link of this deck can ever serve the owner's bytes.
    const versions = await app.db.pool.query(
      'SELECT 1 FROM presentation_versions WHERE presentation_id = $1',
      [own.deckId]
    );
    expect(versions.rowCount).toBe(1);
    const deck = await app.db.pool.query<{ current_version: number }>(
      'SELECT current_version FROM presentations WHERE id = $1',
      [own.deckId]
    );
    expect(deck.rows[0]!.current_version).toBe(1);
  });

  it('precheck stopped answering as a workspace-wide existence oracle', async () => {
    const ask = async (cookie: string) =>
      (
        await readJson(
          await app.app.request(
            '/api/v1/presentations/precheck',
            json({ sha256: [shaOf(SECRET)] }, { cookie })
          )
        )
      ).missing as string[];

    // The member is told to upload it — the answer carries no information
    // about what the workspace already holds.
    expect(await ask(memberCookie)).toEqual([shaOf(SECRET)]);
    // The operator's dedupe is unchanged.
    expect(await ask(ownerCookie)).toEqual([]);
  });
});

describe('an ACTIVE per-deck grant opens that deck’s blobs, and revoking closes them', () => {
  it('claiming a grant on the second deck makes its blob readable through /files', async () => {
    const invited = await readJson(
      await app.app.request(
        `/api/v1/presentations/${deckTwo}/collaborators`,
        json({ email: MEMBER.email }, { cookie: ownerCookie })
      )
    );
    grantId = invited.collaborator.id as string;
    const claim = await app.app.request(
      '/api/v1/collaborators/claim',
      json({ token: invited.claimUrl.split('/collab/')[1] }, { cookie: memberCookie })
    );
    expect(claim.status).toBe(200);

    expect(await blobStatuses(secret2FileId, { cookie: memberCookie })).toEqual({
      meta: 200,
      content: 200,
      head: 200
    });
    expect(await listFileIds({ cookie: memberCookie })).toContain(secret2FileId);
    // The grant is per DECK: the first deck's blob stays out of reach.
    expect(await blobStatuses(secretFileId, { cookie: memberCookie })).toEqual({
      meta: 404,
      content: 404,
      head: 404
    });
  });

  it('revoking the grant cuts the blob off immediately', async () => {
    const revoke = await app.app.request(`/api/v1/presentations/${deckTwo}/collaborators/${grantId}`, {
      method: 'DELETE',
      headers: { cookie: ownerCookie }
    });
    expect(revoke.status).toBe(200);

    expect(await blobStatuses(secret2FileId, { cookie: memberCookie })).toEqual({
      meta: 404,
      content: 404,
      head: 404
    });
    expect(await listFileIds({ cookie: memberCookie })).not.toContain(secret2FileId);
  });
});

describe('possession survives content-addressed dedupe', () => {
  it('a member who pushes bytes another member uploaded first can read and commit them', async () => {
    // Content addressing means this upload deduplicates onto the OWNER's
    // row — `files.created_by` still names the owner. Attribution must not
    // depend on who got there first, or a member would be locked out of
    // bytes they demonstrably hold and their commit would be refused.
    const up = await uploadAsset(SECRET, memberCookie);
    expect(up.status).toBe(201);
    expect((await readJson(up)).deduplicated).toBe(true);

    expect(await blobStatuses(secretFileId, { cookie: memberCookie })).toEqual({
      meta: 200,
      content: 200,
      head: 200
    });

    const own = await createDeck('Member deck from shared bytes', SECRET, memberCookie);
    expect(own.commit.status).toBe(201);
  });
});
