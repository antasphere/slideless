import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { and, eq } from 'drizzle-orm';
import { collaborators, presentationVersions, user as userTable, workspaceMembers } from '@slideless/db';
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
 * Phase 5 — per-deck collaborators, end-to-end:
 *
 *  - owner invites by email (copyable claim link + a DIFFERENT email-only
 *    token in the mail), duplicate/cap/TTL rules;
 *  - claim-at-signup through the public claim endpoint (account + workspace
 *    membership + active grant in one act) and the ADR 009 email-verified
 *    honesty split between the two tokens;
 *  - what an ACTIVE dev can do (push v2 as createdByRole 'dev', with a
 *    session AND with their own API key; manage share tokens; read the
 *    deck's annotations surface) and what they cannot (delete the deck,
 *    invite/revoke collaborators);
 *  - revocation bites immediately; the user.created hook claims pending
 *    grants when the invitee arrives through a WORKSPACE invitation instead.
 */

const OWNER = { email: 'owner@collab.test', name: 'Collab Owner', password: 'collab-owner-pass-1' };
const DEV = { email: 'dev@collab.test', name: 'Dev Person', password: 'collab-dev-password-1' };

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
let deckId: string;

// The public claim/lookup routes share the tight invitation-accept wall
// (10/h per IP); TRUST_PROXY=true in tests, so every request carries a
// unique forwarded address to stay off one shared bucket (the break-glass
// suite's pattern).
let ipCounter = 0;
const nextIp = () => `10.99.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp(), ...headers },
  body: JSON.stringify(body)
});

/** GET with a fresh forwarded IP (lookup rides the same public wall). */
const getFresh = (path: string, headers: Record<string, string> = {}) =>
  app.app.request(path, { headers: { 'x-forwarded-for': nextIp(), ...headers } });

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

async function createDeck(title: string): Promise<string> {
  const reserve = await readJson(
    await app.app.request('/api/v1/presentations/uploads', { method: 'POST', headers: { cookie: ownerCookie } })
  );
  const commit = await app.app.request(
    `/api/v1/presentations/uploads/${reserve.uploadSession.id}/commit`,
    json(
      { title, entryPath: 'index.html', manifest: [entryOf('index.html', HTML_V1)] },
      { cookie: ownerCookie }
    )
  );
  expect(commit.status).toBe(201);
  return reserve.uploadSession.presentationId;
}

const invite = (deck: string, email: string, cookie = ownerCookie) =>
  app.app.request(`/api/v1/presentations/${deck}/collaborators`, json({ email }, { cookie }));

/** The email-only claim token, fished out of the recorded invite mail. */
function emailTokenFromMail(to: string): string {
  const msg = [...mail.sent].reverse().find((m) => m.to === to);
  expect(msg).toBeDefined();
  const match = /\/collab\/([A-Za-z0-9_-]+)/.exec(msg!.text ?? '');
  expect(match).not.toBeNull();
  return match![1]!;
}

beforeAll(async () => {
  container = await startPostgres();
  mail = new RecordingEmailDriver();
  app = await createTestApp(await createDatabase(container, 'collaborators_p5'), {}, { email: mail });
  await app.app.request('/api/v1/setup', json({ instanceName: 'Collab', owner: OWNER }));
  const signIn = await app.app.request(
    '/api/v1/auth/sign-in/email',
    json({ email: OWNER.email, password: OWNER.password })
  );
  ownerCookie = extractCookie(signIn);
  await uploadAsset(HTML_V1, ownerCookie);
  deckId = await createDeck('Collab Deck');
}, 120_000);

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

describe('invite', () => {
  it('creates a pending grant: copyable claim link + a DIFFERENT email-only token in the mail', async () => {
    const res = await invite(deckId, DEV.email);
    expect(res.status).toBe(201);
    const body = await readJson(res);
    expect(body.collaborator).toMatchObject({ email: DEV.email, role: 'dev', status: 'pending', userId: null });
    expect(body.claimUrl).toMatch(/\/collab\/[A-Za-z0-9_-]+$/);
    expect(body.emailSent).toBe(true);

    const copyableToken = body.claimUrl.split('/collab/')[1] as string;
    const emailToken = emailTokenFromMail(DEV.email);
    expect(emailToken).not.toBe(copyableToken); // two-token pattern (ADR 009)

    // Listing shows the grant and never leaks tokens or hashes.
    const listed = await readJson(
      await app.app.request(`/api/v1/presentations/${deckId}/collaborators`, { headers: { cookie: ownerCookie } })
    );
    const raw = JSON.stringify(listed);
    expect(listed.collaborators).toHaveLength(1);
    expect(raw).not.toContain(copyableToken);
    expect(raw).not.toContain(emailToken);
    expect(raw.toLowerCase()).not.toContain('hash');
  });

  it('refuses a duplicate open invite (409 already_invited) and the deck owner email (409)', async () => {
    const dup = await invite(deckId, DEV.email);
    expect(dup.status).toBe(409);
    expect((await readJson(dup)).error.code).toBe('already_invited');

    const self = await invite(deckId, OWNER.email);
    expect(self.status).toBe(409);
    expect((await readJson(self)).error.code).toBe('already_owner');
  });

  it('lookup resolves a live token (deck title, accountExists=false), 404 for junk', async () => {
    const token = emailTokenFromMail(DEV.email);
    const ok = await readJson(await getFresh(`/api/v1/collaborators/lookup?token=${token}`));
    expect(ok).toMatchObject({
      email: DEV.email,
      presentationTitle: 'Collab Deck',
      role: 'dev',
      accountExists: false
    });
    const junk = await getFresh(`/api/v1/collaborators/lookup?token=${'x'.repeat(43)}`);
    expect(junk.status).toBe(404);
  });

  it('caps live grants at 10 per deck (409 collaborator_limit)', async () => {
    const capDeck = await createDeck('Cap Deck');
    for (let i = 0; i < 10; i++) {
      const res = await invite(capDeck, `cap-${i}@collab.test`);
      expect(res.status).toBe(201);
    }
    const over = await invite(capDeck, 'cap-overflow@collab.test');
    expect(over.status).toBe(409);
    expect((await readJson(over)).error.code).toBe('collaborator_limit');
  });

  it('pending TTL: an expired grant stops resolving and re-inviting re-mints it in place', async () => {
    const ttlDeck = await createDeck('TTL Deck');
    const created = await readJson(await invite(ttlDeck, 'ttl@collab.test'));
    const oldToken = created.claimUrl.split('/collab/')[1] as string;

    // Force-expire the pending grant.
    await app.db.db
      .update(collaborators)
      .set({ claimExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(collaborators.id, created.collaborator.id));

    const dead = await getFresh(`/api/v1/collaborators/lookup?token=${oldToken}`);
    expect(dead.status).toBe(404);
    const claimDead = await app.app.request(
      '/api/v1/collaborators/claim',
      json({ token: oldToken, name: 'X', password: 'x'.repeat(16) })
    );
    expect(claimDead.status).toBe(404);

    // Re-invite: same row, fresh pending grant, old token stays dead.
    const again = await readJson(await invite(ttlDeck, 'ttl@collab.test'));
    expect(again.collaborator.id).toBe(created.collaborator.id);
    expect(again.collaborator.status).toBe('pending');
    const newToken = again.claimUrl.split('/collab/')[1] as string;
    expect(newToken).not.toBe(oldToken);
    expect((await getFresh(`/api/v1/collaborators/lookup?token=${oldToken}`)).status).toBe(404);
    expect((await getFresh(`/api/v1/collaborators/lookup?token=${newToken}`)).status).toBe(200);
  });
});

describe('claim-at-signup → active dev', () => {
  let devCookie: string;
  let devKey: string;
  let collaboratorId: string;

  it('claiming with the EMAIL token creates account + membership + active grant, emailVerified=true', async () => {
    const token = emailTokenFromMail(DEV.email);
    const res = await app.app.request(
      '/api/v1/collaborators/claim',
      json({ token, name: DEV.name, password: DEV.password })
    );
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.collaborator.status).toBe('active');
    expect(body.collaborator.userId).toBe(body.userId);
    collaboratorId = body.collaborator.id;

    // Mailbox control demonstrated (email-only token) → honestly verified.
    const [devUser] = await app.db.db
      .select({ id: userTable.id, emailVerified: userTable.emailVerified })
      .from(userTable)
      .where(eq(userTable.email, DEV.email));
    expect(devUser!.emailVerified).toBe(true);

    // The platform requires a membership to authenticate: created as member.
    const [membership] = await app.db.db
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, body.userId));
    expect(membership).toMatchObject({ role: 'member', isActive: true });

    // The claim link is one-shot.
    const replay = await app.app.request(
      '/api/v1/collaborators/claim',
      json({ token, name: DEV.name, password: DEV.password })
    );
    expect([404, 410]).toContain(replay.status);

    const devSignIn = await app.app.request(
      '/api/v1/auth/sign-in/email',
      json({ email: DEV.email, password: DEV.password })
    );
    devCookie = extractCookie(devSignIn);
    const minted = await readJson(
      await app.app.request(
        '/api/v1/api-keys',
        json({ name: 'dev-key', scopes: ['presentations:read', 'presentations:write'] }, { cookie: devCookie })
      )
    );
    devKey = minted.key;
  });

  it('the dev pushes v2 with their session — committed as createdByRole dev', async () => {
    await uploadAsset(HTML_V2, devCookie);
    const res = await app.app.request(
      `/api/v1/presentations/${deckId}/versions`,
      json(
        { expectedBaseVersion: 1, entryPath: 'index.html', manifest: [entryOf('index.html', HTML_V2)] },
        { cookie: devCookie }
      )
    );
    expect(res.status).toBe(201);
    const body = await readJson(res);
    expect(body.version.version).toBe(2);
    expect(body.version.createdByRole).toBe('dev');

    const [row] = await app.db.db
      .select({ role: presentationVersions.createdByRole })
      .from(presentationVersions)
      .where(and(eq(presentationVersions.presentationId, deckId), eq(presentationVersions.version, 2)));
    expect(row!.role).toBe('dev');
  });

  it("the dev's own API key pushes v3 too (still createdByRole dev)", async () => {
    const res = await app.app.request(
      `/api/v1/presentations/${deckId}/versions`,
      json(
        { expectedBaseVersion: 2, entryPath: 'index.html', manifest: [entryOf('index.html', HTML_V1)] },
        { authorization: `Bearer ${devKey}` }
      )
    );
    expect(res.status).toBe(201);
    expect((await readJson(res)).version.createdByRole).toBe('dev');
  });

  it('the dev can pull and manage share tokens', async () => {
    const versions = await app.app.request(`/api/v1/presentations/${deckId}/versions`, {
      headers: { cookie: devCookie }
    });
    expect(versions.status).toBe(200);

    const tokenRes = await app.app.request(
      `/api/v1/presentations/${deckId}/tokens`,
      json({ name: 'Dev-made link' }, { cookie: devCookie })
    );
    expect(tokenRes.status).toBe(201);

    const list = await app.app.request(`/api/v1/presentations/${deckId}/tokens`, {
      headers: { cookie: devCookie }
    });
    expect(list.status).toBe(200);
  });

  it('the dev CANNOT delete the deck, invite, or revoke collaborators (403)', async () => {
    const del = await app.app.request(`/api/v1/presentations/${deckId}`, {
      method: 'DELETE',
      headers: { cookie: devCookie }
    });
    expect(del.status).toBe(403);

    const inv = await invite(deckId, 'friend-of-dev@collab.test', devCookie);
    expect(inv.status).toBe(403);

    const rm = await app.app.request(`/api/v1/presentations/${deckId}/collaborators/${collaboratorId}`, {
      method: 'DELETE',
      headers: { cookie: devCookie }
    });
    expect(rm.status).toBe(403);
  });

  it('a plain member (not a collaborator) cannot push to the deck', async () => {
    // The owner invites a workspace member the normal way; that member has
    // no per-deck grant, so the deck stays read-only to them.
    const invited = await readJson(
      await app.app.request(
        '/api/v1/invitations',
        json({ email: 'bystander@collab.test', role: 'member' }, { cookie: ownerCookie })
      )
    );
    await app.app.request(
      '/api/v1/invitations/accept',
      json({ token: invited.acceptUrl.split('/invite/')[1], name: 'Bystander', password: 'bystander-pass-123' })
    );
    const memberCookie = extractCookie(
      await app.app.request(
        '/api/v1/auth/sign-in/email',
        json({ email: 'bystander@collab.test', password: 'bystander-pass-123' })
      )
    );
    const res = await app.app.request(
      `/api/v1/presentations/${deckId}/versions`,
      json(
        { expectedBaseVersion: 3, entryPath: 'index.html', manifest: [entryOf('index.html', HTML_V2)] },
        { cookie: memberCookie }
      )
    );
    expect(res.status).toBe(403);
    // And the collaborator roster is hidden from them (contract has no 403 on list).
    const roster = await app.app.request(`/api/v1/presentations/${deckId}/collaborators`, {
      headers: { cookie: memberCookie }
    });
    expect(roster.status).toBe(404);
  });

  it('owner revokes the dev → grant revoked, pushes 403 immediately', async () => {
    const res = await app.app.request(`/api/v1/presentations/${deckId}/collaborators/${collaboratorId}`, {
      method: 'DELETE',
      headers: { cookie: ownerCookie }
    });
    expect(res.status).toBe(200);
    expect((await readJson(res)).status).toBe('revoked');

    const push = await app.app.request(
      `/api/v1/presentations/${deckId}/versions`,
      json(
        { expectedBaseVersion: 3, entryPath: 'index.html', manifest: [entryOf('index.html', HTML_V2)] },
        { cookie: devCookie }
      )
    );
    expect(push.status).toBe(403);
  });
});

describe('claim-at-signup via a WORKSPACE invitation (the user.created hook)', () => {
  it('a pending grant activates when its email joins through an ordinary invitation', async () => {
    const email = 'late-joiner@collab.test';
    const granted = await readJson(await invite(deckId, email));
    expect(granted.collaborator.status).toBe('pending');

    const invited = await readJson(
      await app.app.request('/api/v1/invitations', json({ email, role: 'member' }, { cookie: ownerCookie }))
    );
    const accept = await app.app.request(
      '/api/v1/invitations/accept',
      json({ token: invited.acceptUrl.split('/invite/')[1], name: 'Late Joiner', password: 'late-joiner-pass-1' })
    );
    expect(accept.status).toBe(200);

    // The user.created hook fires async on the event bus — poll briefly.
    let status = 'pending';
    for (let i = 0; i < 20 && status !== 'active'; i++) {
      const [row] = await app.db.db
        .select({ status: collaborators.status })
        .from(collaborators)
        .where(eq(collaborators.id, granted.collaborator.id));
      status = row!.status;
      if (status !== 'active') await new Promise((r) => setTimeout(r, 50));
    }
    expect(status).toBe('active');
  });
});

describe('claim by an EXISTING account (template invitation semantics: explicit claim, never auto-activate)', () => {
  it('unauthenticated claim for an existing email → 409 account_exists; signed-in claim succeeds (no verified flip on the copyable token)', async () => {
    const secondDeck = await createDeck('Second Deck');
    const created = await readJson(await invite(secondDeck, DEV.email));
    expect(created.collaborator.status).toBe('pending'); // existing user, still pending
    const copyable = created.claimUrl.split('/collab/')[1] as string;

    const anon = await app.app.request('/api/v1/collaborators/claim', json({ token: copyable }));
    expect(anon.status).toBe(409);
    expect((await readJson(anon)).error.code).toBe('account_exists');

    const devCookie = extractCookie(
      await app.app.request('/api/v1/auth/sign-in/email', json({ email: DEV.email, password: DEV.password }))
    );
    const claimed = await app.app.request(
      '/api/v1/collaborators/claim',
      json({ token: copyable }, { cookie: devCookie })
    );
    expect(claimed.status).toBe(200);
    expect((await readJson(claimed)).collaborator.status).toBe('active');
  });
});
