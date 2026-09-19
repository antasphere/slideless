import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { and, eq } from 'drizzle-orm';
import { user as userTable, workspaceMembers } from '@antasphere/chassis-db';
import { collaborators, presentationVersions } from '@slideless/db';
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
    await app.app.request('/api/v1/presentations/uploads', {
      method: 'POST',
      headers: { cookie: ownerCookie }
    })
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
  await app.app.request(
    '/api/v1/setup',
    json({ setupToken: 'integration-test-setup-token', instanceName: 'Collab', owner: OWNER })
  );
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
    expect(body.collaborator).toMatchObject({
      email: DEV.email,
      role: 'dev',
      status: 'pending',
      userId: null
    });
    expect(body.claimUrl).toMatch(/\/collab\/[A-Za-z0-9_-]+$/);
    expect(body.emailSent).toBe(true);

    const copyableToken = body.claimUrl.split('/collab/')[1] as string;
    const emailToken = emailTokenFromMail(DEV.email);
    expect(emailToken).not.toBe(copyableToken); // two-token pattern (ADR 009)

    // Listing shows the grant and never leaks tokens or hashes.
    const listed = await readJson(
      await app.app.request(`/api/v1/presentations/${deckId}/collaborators`, {
        headers: { cookie: ownerCookie }
      })
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

  it('lookup resolves a live token (deck title, no account signal), 404 for junk', async () => {
    const token = emailTokenFromMail(DEV.email);
    const ok = await readJson(await getFresh(`/api/v1/collaborators/lookup?token=${token}`));
    expect(ok).toMatchObject({
      email: DEV.email,
      presentationTitle: 'Collab Deck',
      role: 'dev'
    });
    // No account-existence signal on the public lookup (PRDCT-1437): the
    // admin holds the claim URL, so the field was an instance-global oracle.
    expect(ok).not.toHaveProperty('accountExists');
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

    // The platform requires a membership to authenticate: created as member,
    // stamped origin='guest' (G2 — external per-deck party, not team).
    const [membership] = await app.db.db
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, body.userId));
    expect(membership).toMatchObject({ role: 'member', isActive: true, origin: 'guest' });

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
        json(
          { name: 'dev-key', scopes: ['presentations:read', 'presentations:write'] },
          { cookie: devCookie }
        )
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
      json({
        token: invited.acceptUrl.split('/invite/')[1],
        name: 'Bystander',
        password: 'bystander-pass-123'
      })
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
    // 404, not 403 (AUTH-5, PRDCT-1393): a member without the deck must not
    // learn the deck id resolves at all.
    expect(res.status).toBe(404);
    // And the collaborator roster is hidden from them (contract has no 403 on list).
    const roster = await app.app.request(`/api/v1/presentations/${deckId}/collaborators`, {
      headers: { cookie: memberCookie }
    });
    expect(roster.status).toBe(404);
  });

  it('owner revokes the dev → grant revoked, pushes 404 immediately (the deck vanishes for them)', async () => {
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
    // Revocation drops them to outsider status: 404, never 403 (AUTH-5).
    expect(push.status).toBe(404);
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
      json({
        token: invited.acceptUrl.split('/invite/')[1],
        name: 'Late Joiner',
        password: 'late-joiner-pass-1'
      })
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

describe('G1 regression — the user.created hook races the claim endpoint (idempotent same-user claim)', () => {
  it('a brand-new invitee claims end-to-end even when the boot sweep activates the grant first', async () => {
    // The claim endpoint's signUpEmail fires databaseHooks.user.create.after
    // → the boot sweep flips THIS grant to active before the endpoint's own
    // claim() runs (the sweep's UPDATE is dispatched before signUpEmail's
    // remaining round-trips finish). Without the idempotent same-user claim,
    // the endpoint 410s and the membership insert never runs — an invitee
    // with an active grant but an unreachable deck.
    const invitee = { email: 'g1-invitee@collab.test', name: 'G1 Invitee', password: 'g1-invitee-pass-1' };
    const deck = await createDeck('G1 Deck');
    const created = await readJson(await invite(deck, invitee.email));
    const token = created.claimUrl.split('/collab/')[1] as string;

    const res = await app.app.request(
      '/api/v1/collaborators/claim',
      json({ token, name: invitee.name, password: invitee.password })
    );
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.collaborator.status).toBe('active');
    expect(body.collaborator.userId).toBe(body.userId);

    // The membership block ran: without it the grant would be active but
    // the deck unreachable (no principal in the deck's workspace). Claim
    // rows are stamped origin='guest' (G2).
    const [membership] = await app.db.db
      .select({
        role: workspaceMembers.role,
        isActive: workspaceMembers.isActive,
        origin: workspaceMembers.origin
      })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, body.userId));
    expect(membership).toMatchObject({ role: 'member', isActive: true, origin: 'guest' });

    // And the deck IS reachable for the fresh invitee.
    const cookie = extractCookie(
      await app.app.request(
        '/api/v1/auth/sign-in/email',
        json({ email: invitee.email, password: invitee.password })
      )
    );
    const read = await app.app.request(`/api/v1/presentations/${deck}`, { headers: { cookie } });
    expect(read.status).toBe(200);
  });

  it('claim() is idempotent for the SAME user and still refuses a DIFFERENT user', async () => {
    const email = 'g1-sweep-first@collab.test';
    const deck = await createDeck('G1 Sweep Deck');
    const created = await readJson(await invite(deck, email));
    const grantId = created.collaborator.id as string;

    // Create the account server-side (the hook fires; the sweep activates
    // the grant) — the deterministic "sweep won" ordering.
    const signedUp = await app.auth.api.signUpEmail({
      body: { email, name: 'Sweep First', password: 'sweep-first-pass-1' }
    });
    const userId = signedUp.user.id;
    let status = 'pending';
    for (let i = 0; i < 20 && status !== 'active'; i++) {
      const [row] = await app.db.db
        .select({ status: collaborators.status })
        .from(collaborators)
        .where(eq(collaborators.id, grantId));
      status = row!.status;
      if (status !== 'active') await new Promise((r) => setTimeout(r, 50));
    }
    expect(status).toBe('active');

    // Same user: claim-success (the endpoint's membership block proceeds).
    const service = new (await import('../../src/collaborators/service.js')).CollaboratorService(app.db.db);
    const sameUser = await service.claim(grantId, userId);
    expect(sameUser).not.toBeNull();
    expect(sameUser!.status).toBe('active');
    expect(sameUser!.userId).toBe(userId);

    // Different user: still a hard null (a token cannot be redeemed twice
    // by different people).
    const other = await service.claim(grantId, 'someone-else');
    expect(other).toBeNull();
  });
});

describe('G1 CROSS-REQUEST regression — a grant swept active in an EARLIER request still claims (Phase 6)', () => {
  it('a sibling grant in ANOTHER workspace, swept at signup, is claimable later and mints the membership', async () => {
    // The residual bounded at findLiveByClaimToken (commit a9f98f1): the
    // sweep flips grants but never mints memberships, so a grant swept in
    // an earlier request left the invitee with an active grant and an
    // unreachable deck — the claim link 404ed at the pending-only lookup.
    const email = 'g1-cross-request@collab.test';
    const password = 'g1-cross-req-pass-1';

    // A SECOND workspace with its own owner and deck: only there does the
    // swept sibling lack the membership that makes the deck reachable.
    const o2 = await app.auth.api.signUpEmail({
      body: { email: 'owner-two@collab.test', name: 'Owner Two', password: 'owner-two-pass-123' }
    });
    const { workspaceId: w2 } = await app.registry.workspaces.create('Second WS', o2.user.id);
    const o2Cookie = extractCookie(
      await app.app.request(
        '/api/v1/auth/sign-in/email',
        json({ email: 'owner-two@collab.test', password: 'owner-two-pass-123' })
      )
    );
    // O2's sole membership is W2 — asset + deck land there by default.
    await uploadAsset(HTML_V1, o2Cookie);
    const reserve = await readJson(
      await app.app.request('/api/v1/presentations/uploads', {
        method: 'POST',
        headers: { cookie: o2Cookie }
      })
    );
    const commit = await app.app.request(
      `/api/v1/presentations/uploads/${reserve.uploadSession.id}/commit`,
      json(
        { title: 'W2 Deck', entryPath: 'index.html', manifest: [entryOf('index.html', HTML_V1)] },
        { cookie: o2Cookie }
      )
    );
    expect(commit.status).toBe(201);
    const w2Deck = reserve.uploadSession.presentationId as string;

    // Both workspaces invite the same address.
    const w1Deck = await createDeck('G1 W1 Deck');
    const w1Invite = await readJson(await invite(w1Deck, email));
    const w2Invite = await readJson(await invite(w2Deck, email, o2Cookie));
    const w1Token = w1Invite.claimUrl.split('/collab/')[1] as string;
    const w2Token = w2Invite.claimUrl.split('/collab/')[1] as string;

    // Claiming W1's grant creates the account; the endpoint's sibling sweep
    // (and the user.created hook) flips W2's grant in the SAME request —
    // an earlier request from the W2 token's point of view.
    const first = await app.app.request(
      '/api/v1/collaborators/claim',
      json({ token: w1Token, name: 'G1 Cross', password })
    );
    expect(first.status).toBe(200);
    const { userId } = await readJson(first);

    const [w2Grant] = await app.db.db
      .select({ status: collaborators.status, userId: collaborators.userId })
      .from(collaborators)
      .where(eq(collaborators.id, w2Invite.collaborator.id));
    expect(w2Grant).toMatchObject({ status: 'active', userId });

    // No W2 membership yet — the W2 deck is unreachable (the bug's symptom).
    const cookie = extractCookie(
      await app.app.request('/api/v1/auth/sign-in/email', json({ email, password }))
    );
    const before = await app.app.request(`/api/v1/presentations/${w2Deck}`, {
      headers: { cookie, 'x-workspace-id': w2 }
    });
    expect(before.status).toBe(401); // no membership → no principal in W2

    // The public lookup stays pending-only: the swept token resolves nothing
    // there (no deck metadata for used tokens)…
    expect((await getFresh(`/api/v1/collaborators/lookup?token=${w2Token}`)).status).toBe(404);

    // …and an anonymous claim, or another user's claim, stays 404 too.
    expect((await app.app.request('/api/v1/collaborators/claim', json({ token: w2Token }))).status).toBe(404);
    const strangerClaim = await app.app.request(
      '/api/v1/collaborators/claim',
      json({ token: w2Token }, { cookie: ownerCookie })
    );
    expect(strangerClaim.status).toBe(404);

    // The owning user's claim reads as SUCCESS and mints the membership.
    const second = await app.app.request('/api/v1/collaborators/claim', json({ token: w2Token }, { cookie }));
    expect(second.status).toBe(200);
    const body = await readJson(second);
    expect(body.workspaceId).toBe(w2);
    expect(body.collaborator.status).toBe('active');

    const [w2Membership] = await app.db.db
      .select({
        role: workspaceMembers.role,
        origin: workspaceMembers.origin,
        isActive: workspaceMembers.isActive
      })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.userId, userId), eq(workspaceMembers.workspaceId, w2)));
    expect(w2Membership).toMatchObject({ role: 'member', origin: 'guest', isActive: true });

    // The deck is reachable now.
    const after = await app.app.request(`/api/v1/presentations/${w2Deck}`, {
      headers: { cookie, 'x-workspace-id': w2 }
    });
    expect(after.status).toBe(200);

    // A REVOKED swept grant does not resurrect through this path.
    await app.app.request(`/api/v1/presentations/${w2Deck}/collaborators/${w2Invite.collaborator.id}`, {
      method: 'DELETE',
      headers: { cookie: o2Cookie }
    });
    const revokedClaim = await app.app.request(
      '/api/v1/collaborators/claim',
      json({ token: w2Token }, { cookie })
    );
    expect(revokedClaim.status).toBe(404);
  });
});

describe('claim by an EXISTING account (template invitation semantics: explicit claim, never auto-activate)', () => {
  it('credential-less claim answers credentials_required regardless of existence; a committed create reveals the collision; signed-in claim succeeds', async () => {
    const secondDeck = await createDeck('Second Deck');
    const created = await readJson(await invite(secondDeck, DEV.email));
    expect(created.collaborator.status).toBe('pending'); // existing user, still pending
    const copyable = created.claimUrl.split('/collab/')[1] as string;

    // PRDCT-1437 door 2: an anonymous, credential-less claim of an EXISTING
    // email answers the SAME 400 credentials_required that a non-existent
    // email would — the account-existence bit is not readable for free.
    const anonNoCreds = await app.app.request('/api/v1/collaborators/claim', json({ token: copyable }));
    expect(anonNoCreds.status).toBe(400);
    expect((await readJson(anonNoCreds)).error.code).toBe('credentials_required');

    // Existence surfaces ONLY after real credentials are committed (the
    // inherent signup collision), never before.
    const anonWithCreds = await app.app.request(
      '/api/v1/collaborators/claim',
      json({ token: copyable, name: 'Probe', password: 'a-probe-password-123' })
    );
    expect(anonWithCreds.status).toBe(409);
    expect((await readJson(anonWithCreds)).error.code).toBe('account_exists');

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
