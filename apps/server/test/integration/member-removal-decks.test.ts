import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { and, eq } from 'drizzle-orm';
import { workspaceMembers } from '@antasphere/chassis-db';
import { collaborators } from '@slideless/db';
import { FakeHub, type HubUserFixture } from '@antasphere/chassis-server/testing';
import {
  createDatabase,
  createTestApp,
  extractCookie,
  readJson,
  startPostgres,
  type TestApp
} from './helpers.js';
import * as sso from './sso-helpers.js';
import { endDeckAccessOnRemoval } from '../../src/collaborators/removal.js';

/**
 * A member's removal ends what Slideless hangs on them in the workspace
 * (PRDCT-2816, the chassis's `membershipRemoval` slot filled by
 * `collaborators/removal.ts`): every deck invite waiting for the person and
 * every deck grant they hold there is revoked in the removal's transaction,
 * on both editions (the route here, the hub reconcile's sweep on cloud).
 *
 * Pinned: a pending deck invite made before the removal can no longer switch
 * the row back on (F1-A); a fresh invite made after the removal brings the
 * person back as a plain member, never at the owner role they held (F1-A2);
 * a PAUSED admin claiming an invite made before the pause comes back as a
 * member; a removed member's deck grant ends with the membership and does
 * not come back with a workspace invitation (F3); the boundaries (another
 * workspace's invite for the same address, another person's grant on the
 * same deck, an address stored with other letter case); the counts on the
 * `member.remove` record; and the hub's sweep on cloud.
 */
const PASSWORD = 'a-long-removal-decks-password-1';
const OWNER = { email: 'owner@removal-decks.test', name: 'Olive Owner', password: PASSWORD };

const HTML = Buffer.from('<!doctype html><html><body><h1>removal</h1></body></html>');
const SHA = createHash('sha256').update(HTML).digest('hex');
const MANIFEST = [{ path: 'index.html', sha256: SHA, sizeBytes: HTML.length, contentType: 'text/html' }];

type Actor = { email: string; cookie: string; userId: string; memberId: string };

let container: StartedPostgreSqlContainer;

let ipCounter = 0;
const nextIp = () => `10.83.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

/** One app's request helpers: the oss app and the cloud app each get their own. */
function client(getApp: () => TestApp) {
  const send = (
    method: string,
    path: string,
    who: { cookie?: string },
    body?: unknown,
    headers: Record<string, string> = {}
  ) =>
    getApp().app.request(`/api/v1${path}`, {
      method,
      headers: {
        'x-forwarded-for': nextIp(),
        ...(who.cookie ? { cookie: who.cookie } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });

  /** The asset with its declared size (a metered account refuses an undeclared one, PRDCT-2652). */
  async function uploadAsset(who: { cookie?: string }, headers: Record<string, string>): Promise<void> {
    const form = new FormData();
    form.set('sha256', SHA);
    form.set('file', new Blob([new Uint8Array(HTML)], { type: 'text/html' }), 'index.html');
    const encoded = new Response(form);
    const body = await encoded.arrayBuffer();
    const res = await getApp().app.request('/api/v1/presentations/assets', {
      method: 'POST',
      headers: {
        'x-forwarded-for': nextIp(),
        'content-type': encoded.headers.get('content-type')!,
        'content-length': String(body.byteLength),
        ...(who.cookie ? { cookie: who.cookie } : {}),
        ...headers
      },
      body
    });
    expect(res.status).toBe(201);
  }

  async function createDeck(
    who: { cookie?: string },
    title: string,
    headers: Record<string, string> = {}
  ): Promise<string> {
    await uploadAsset(who, headers);
    const reserve = await send('POST', '/presentations/uploads', who, undefined, headers);
    expect(reserve.status).toBe(201);
    const { uploadSession } = await readJson(reserve);
    const commit = await send(
      'POST',
      `/presentations/uploads/${uploadSession.id}/commit`,
      who,
      { title, entryPath: 'index.html', manifest: MANIFEST },
      headers
    );
    expect(commit.status).toBe(201);
    return uploadSession.presentationId;
  }

  /** Invite an address on a deck: the grant's id and the claim token of its copyable link. */
  async function inviteOnDeck(
    deckId: string,
    by: { cookie?: string },
    email: string,
    headers: Record<string, string> = {}
  ): Promise<{ grantId: string; token: string }> {
    const res = await send('POST', `/presentations/${deckId}/collaborators`, by, { email }, headers);
    expect(res.status).toBe(201);
    const body = await readJson(res);
    return { grantId: body.collaborator.id, token: (body.claimUrl as string).split('/collab/')[1]! };
  }

  const claim = (token: string, who: { cookie?: string }) =>
    send('POST', '/collaborators/claim', who, { token });

  const grantRow = async (grantId: string) =>
    (await getApp().db.db.select().from(collaborators).where(eq(collaborators.id, grantId)))[0]!;

  const memberRowOf = async (userId: string, workspaceId: string) =>
    (
      await getApp()
        .db.db.select()
        .from(workspaceMembers)
        .where(and(eq(workspaceMembers.userId, userId), eq(workspaceMembers.workspaceId, workspaceId)))
    )[0];

  return { send, createDeck, inviteOnDeck, claim, grantRow, memberRowOf };
}

// ─────────────────────────────── self-hosted ───────────────────────────────

let app: TestApp;
let workspaceId = '';
const actors: Record<string, Actor> = {};
const oss = client(() => app);

async function signIn(email: string): Promise<string> {
  const res = await oss.send('POST', '/auth/sign-in/email', {}, { email, password: PASSWORD });
  expect(res.status).toBe(200);
  return extractCookie(res);
}

async function addActor(
  name: string,
  opts: { role?: 'owner' | 'admin' | 'member'; email?: string } = {}
): Promise<Actor> {
  const email = opts.email ?? `${name}@removal-decks.test`;
  const created = await app.auth.api.signUpEmail({ body: { email, password: PASSWORD, name } });
  const [row] = await app.db.db
    .insert(workspaceMembers)
    .values({ workspaceId, userId: created.user.id, role: opts.role ?? 'member', origin: 'local' })
    .returning({ id: workspaceMembers.id });
  const actor = { email, cookie: await signIn(email), userId: created.user.id, memberId: row!.id };
  actors[name] = actor;
  return actor;
}

const remove = (memberId: string, by: Actor) => oss.send('POST', `/members/${memberId}/remove`, by);

async function removalRecord(memberId: string): Promise<Record<string, unknown>> {
  const res = await oss.send('GET', '/audit?action=member.remove&limit=100', actors.owner!);
  expect(res.status).toBe(200);
  const entries = (await readJson(res)).entries as Array<{
    resourceId: string;
    metadata: Record<string, unknown>;
  }>;
  const mine = entries.filter((e) => e.resourceId === memberId);
  expect(mine).toHaveLength(1);
  return mine[0]!.metadata;
}

beforeAll(async () => {
  container = await startPostgres();
  app = await createTestApp(await createDatabase(container, 'removal_decks'));
  const setup = await oss.send(
    'POST',
    '/setup',
    {},
    { setupToken: 'integration-test-setup-token', instanceName: 'Removal decks', owner: OWNER }
  );
  expect(setup.status).toBe(201);
  workspaceId = (await readJson(setup)).workspaceId;
  const cookie = await signIn(OWNER.email);
  const me = await readJson(await oss.send('GET', '/me', { cookie }));
  const ownerRow = await oss.memberRowOf(me.user.id, workspaceId);
  actors.owner = { email: OWNER.email, cookie, userId: me.user.id, memberId: ownerRow!.id };
  await addActor('admin', { role: 'admin' });
}, 180_000);

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

describe('a removal ends the deck invites and grants in the workspace (self-hosted)', () => {
  it('F1-A: an invite made before the removal is revoked, and its token opens nothing', async () => {
    const xavier = await addActor('xavier', { role: 'admin' });
    const mina = await addActor('mina');
    const deck = await oss.createDeck(mina, 'Mina’s deck');
    const invite = await oss.inviteOnDeck(deck, mina, xavier.email);
    expect(await oss.grantRow(invite.grantId)).toMatchObject({ status: 'pending', revokedAt: null });

    expect((await remove(xavier.memberId, actors.owner!)).status).toBe(200);
    const row = await oss.grantRow(invite.grantId);
    expect(row.status).toBe('revoked');
    expect(row.revokedAt).not.toBeNull();

    // Signed in, with the token he was given: refused, pinned as observed.
    const claimed = await oss.claim(invite.token, xavier);
    const body = await readJson(claimed);
    expect({ status: claimed.status, code: body?.error?.code }).toEqual({ status: 404, code: 'not_found' });
    expect(await oss.memberRowOf(xavier.userId, workspaceId)).toMatchObject({
      isActive: false,
      role: 'member'
    });
    const roster = await oss.send('GET', '/members', xavier, undefined, { 'x-workspace-id': workspaceId });
    expect(roster.status).not.toBe(200);
    expect(roster.status).toBe(401);
  });

  it('F1-A2: a removed owner claiming a fresh invite comes back as a member, never an owner', async () => {
    const second = await addActor('second-owner', { role: 'owner' });
    const deck = await oss.createDeck(actors.owner!, 'Owner’s deck for the second owner');
    expect((await remove(second.memberId, actors.owner!)).status).toBe(200);

    // The workspace's own act, after the removal.
    const invite = await oss.inviteOnDeck(deck, actors.admin!, second.email);
    const claimed = await oss.claim(invite.token, second);
    expect(claimed.status).toBe(200);
    expect(await oss.memberRowOf(second.userId, workspaceId)).toMatchObject({
      isActive: true,
      role: 'member'
    });
  });

  it('a paused admin claiming an invite made before the pause: pinned as observed, back as a member', async () => {
    const paused = await addActor('paused-admin', { role: 'admin' });
    const owner = actors.owner!;
    const mina = actors.mina!;
    const deck = await oss.createDeck(mina, 'Mina’s deck for the paused admin');
    const invite = await oss.inviteOnDeck(deck, mina, paused.email);
    const pause = await oss.send('PATCH', `/members/${paused.memberId}`, owner, { isActive: false });
    expect(pause.status).toBe(200);
    // A pause keeps the invite.
    expect(await oss.grantRow(invite.grantId)).toMatchObject({ status: 'pending', revokedAt: null });

    const claimed = await oss.claim(invite.token, paused);
    // Observed: 200, the claim switches the paused row back on (the pause is not a removal).
    // The re-entry is the follow-up PRDCT-2831; what this lane closes is the role.
    expect(claimed.status).toBe(200);
    expect(await oss.memberRowOf(paused.userId, workspaceId)).toMatchObject({
      isActive: true,
      role: 'member'
    });
  });

  it('F3: an active deck grant ends with the removal and does not come back with the workspace', async () => {
    const yara = await addActor('yara');
    const owner = actors.owner!;
    const deck = await oss.createDeck(owner, 'Owner’s deck for Yara');
    const invite = await oss.inviteOnDeck(deck, owner, yara.email);
    expect((await oss.claim(invite.token, yara)).status).toBe(200);
    expect(await oss.grantRow(invite.grantId)).toMatchObject({ status: 'active' });
    const read = () =>
      oss.send('GET', `/presentations/${deck}`, yara, undefined, { 'x-workspace-id': workspaceId });
    expect((await read()).status).toBe(200);

    expect((await remove(yara.memberId, owner)).status).toBe(200);
    const row = await oss.grantRow(invite.grantId);
    expect(row.status).toBe('revoked');
    expect(row.revokedAt).not.toBeNull();
    expect(await removalRecord(yara.memberId)).toMatchObject({ deckGrants: 1, deckInvites: 0 });

    // Invited back to the workspace, signed in: a member again, without the deck.
    const invited = await oss.send('POST', '/invitations', owner, { email: yara.email, role: 'member' });
    expect(invited.status).toBe(201);
    const token = ((await readJson(invited)).acceptUrl as string).split('/invite/')[1]!;
    expect((await oss.send('POST', '/invitations/accept', yara, { token })).status).toBe(200);
    expect(await oss.memberRowOf(yara.userId, workspaceId)).toMatchObject({ isActive: true, role: 'member' });
    expect((await read()).status).toBe(404);
  });

  it('the boundaries: another workspace, another person, and the address in other letter case', async () => {
    const owner = actors.owner!;
    const pia = await addActor('pia');
    const quinn = await addActor('quinn');
    const elsewhere = (await app.registry.workspaces.create('Elsewhere', owner.userId)).workspaceId;
    const there = { 'x-workspace-id': elsewhere };

    // The same address invited in ANOTHER workspace.
    const elsewhereDeck = await oss.createDeck(owner, 'Elsewhere deck', there);
    const away = await oss.inviteOnDeck(elsewhereDeck, owner, pia.email, there);

    // On one deck here: Pia's pending invite and Quinn's active grant.
    const shared = await oss.createDeck(owner, 'Shared deck');
    const piaHere = await oss.inviteOnDeck(shared, owner, pia.email);
    const quinnHere = await oss.inviteOnDeck(shared, owner, quinn.email);
    expect((await oss.claim(quinnHere.token, quinn)).status).toBe(200);

    // An invite sent to the address with a capital. The route stores it lower
    // case, so the row is set to the capitalized form directly: the removal's
    // match must not depend on the letter case of either side.
    const capsDeck = await oss.createDeck(owner, 'Capital deck');
    const capital = await oss.inviteOnDeck(capsDeck, owner, 'Pia@removal-decks.test');
    expect((await oss.grantRow(capital.grantId)).email).toBe('pia@removal-decks.test');
    await app.db.db
      .update(collaborators)
      .set({ email: 'Pia@Removal-Decks.test' })
      .where(eq(collaborators.id, capital.grantId));

    expect((await remove(pia.memberId, owner)).status).toBe(200);

    expect(await oss.grantRow(piaHere.grantId)).toMatchObject({ status: 'revoked' });
    const caps = await oss.grantRow(capital.grantId);
    expect(caps.status).toBe('revoked');
    expect(caps.revokedAt).not.toBeNull();
    // Untouched: the other workspace's invite for the same address…
    expect(await oss.grantRow(away.grantId)).toMatchObject({ status: 'pending', revokedAt: null });
    // …and another person's grant on the same deck.
    expect(await oss.grantRow(quinnHere.grantId)).toMatchObject({
      status: 'active',
      revokedAt: null,
      userId: quinn.userId
    });
    expect(await removalRecord(pia.memberId)).toMatchObject({ deckGrants: 0, deckInvites: 2 });
  });

  it('the counts: 2 pending invites and 1 active grant are written on member.remove', async () => {
    const owner = actors.owner!;
    const cora = await addActor('cora');
    const a = await oss.createDeck(owner, 'Cora A');
    const b = await oss.createDeck(owner, 'Cora B');
    const c = await oss.createDeck(owner, 'Cora C');
    // The grant first: a claim sweeps the person's sibling pending invites.
    const granted = await oss.inviteOnDeck(a, owner, cora.email);
    expect((await oss.claim(granted.token, cora)).status).toBe(200);
    const pendingB = await oss.inviteOnDeck(b, owner, cora.email);
    const pendingC = await oss.inviteOnDeck(c, owner, cora.email);
    expect((await oss.grantRow(pendingB.grantId)).status).toBe('pending');
    expect((await oss.grantRow(pendingC.grantId)).status).toBe('pending');

    expect((await remove(cora.memberId, owner)).status).toBe(200);
    for (const id of [granted.grantId, pendingB.grantId, pendingC.grantId]) {
      expect((await oss.grantRow(id)).status).toBe('revoked');
    }
    expect(await removalRecord(cora.memberId)).toMatchObject({
      targetUserId: cora.userId,
      roleBefore: 'member',
      projectGrants: 0,
      teamSeats: 0,
      deckInvites: 2,
      deckGrants: 1
    });
  });

  it('N2: a pending deck invite a removed admin issued to an outside address is revoked and claims nothing', async () => {
    const owner = actors.owner!;
    const issuer = await addActor('n2-deck-issuer', { role: 'admin' });
    const outside = 'n2-outside@removal-decks.test';
    const deck = await oss.createDeck(owner, 'Deck the removed admin shared out');
    const invite = await oss.inviteOnDeck(deck, issuer, outside);
    expect(await oss.grantRow(invite.grantId)).toMatchObject({ status: 'pending', revokedAt: null });

    expect((await remove(issuer.memberId, owner)).status).toBe(200);
    const row = await oss.grantRow(invite.grantId);
    expect(row.status).toBe('revoked');
    expect(row.revokedAt).not.toBeNull();

    // The account under that address exists only after the removal (an
    // earlier sign-up would have swept the pending invite into a grant).
    await app.auth.api.signUpEmail({ body: { email: outside, password: PASSWORD, name: 'Outside' } });
    const cookie = await signIn(outside);
    const claimed = await oss.claim(invite.token, { cookie });
    const body = await readJson(claimed);
    // Pinned as observed.
    expect({ status: claimed.status, code: body?.error?.code }).toEqual({ status: 404, code: 'not_found' });
    expect(await oss.grantRow(invite.grantId)).toMatchObject({ status: 'revoked' });
    expect(await removalRecord(issuer.memberId)).toMatchObject({ deckInvitesIssued: 1 });
  });

  it('a grant another person already claimed through the removed admin’s invite stays active and reads', async () => {
    const owner = actors.owner!;
    const issuer = await addActor('claimed-issuer', { role: 'admin' });
    const reader = await addActor('claimed-reader');
    const deck = await oss.createDeck(owner, 'Deck read through a removed admin’s invite');
    const invite = await oss.inviteOnDeck(deck, issuer, reader.email);
    expect((await oss.claim(invite.token, reader)).status).toBe(200);
    expect(await oss.grantRow(invite.grantId)).toMatchObject({ status: 'active', userId: reader.userId });

    expect((await remove(issuer.memberId, owner)).status).toBe(200);
    expect(await oss.grantRow(invite.grantId)).toMatchObject({
      status: 'active',
      revokedAt: null,
      userId: reader.userId
    });
    const read = await oss.send('GET', `/presentations/${deck}`, reader, undefined, {
      'x-workspace-id': workspaceId
    });
    expect(read.status).toBe(200);
    expect(await removalRecord(issuer.memberId)).toMatchObject({ deckInvitesIssued: 0 });
  });

  it('T02: a row already revoked before the removal keeps its revoked_at and is not counted', async () => {
    const owner = actors.owner!;
    const tessa = await addActor('tessa');
    const oldDeck = await oss.createDeck(owner, 'Tessa old');
    const liveDeck = await oss.createDeck(owner, 'Tessa live');
    const pendingDeck = await oss.createDeck(owner, 'Tessa pending');
    // Claims first: a claim sweeps the person's sibling pending invites.
    const old = await oss.inviteOnDeck(oldDeck, owner, tessa.email);
    expect((await oss.claim(old.token, tessa)).status).toBe(200);
    const live = await oss.inviteOnDeck(liveDeck, owner, tessa.email);
    expect((await oss.claim(live.token, tessa)).status).toBe(200);
    const revokeRes = await oss.send(
      'DELETE',
      `/presentations/${oldDeck}/collaborators/${old.grantId}`,
      owner
    );
    expect(revokeRes.status).toBe(200);
    const oldRevokedAt = new Date('2020-01-01T00:00:00.000Z');
    await app.db.db
      .update(collaborators)
      .set({ revokedAt: oldRevokedAt })
      .where(eq(collaborators.id, old.grantId));
    const pending = await oss.inviteOnDeck(pendingDeck, owner, tessa.email);
    expect(await oss.grantRow(old.grantId)).toMatchObject({ status: 'revoked', revokedAt: oldRevokedAt });

    expect((await remove(tessa.memberId, owner)).status).toBe(200);

    expect(await oss.grantRow(old.grantId)).toMatchObject({ status: 'revoked', revokedAt: oldRevokedAt });
    expect(await oss.grantRow(live.grantId)).toMatchObject({ status: 'revoked' });
    expect(await oss.grantRow(pending.grantId)).toMatchObject({ status: 'revoked' });
    expect(await removalRecord(tessa.memberId)).toMatchObject({ deckGrants: 1, deckInvites: 1 });
  });

  it('T03: a claimed grant whose stored address changed is revoked on the account alone', async () => {
    const owner = actors.owner!;
    const theo = await addActor('theo');
    const deck = await oss.createDeck(owner, 'Theo deck');
    const invite = await oss.inviteOnDeck(deck, owner, theo.email);
    expect((await oss.claim(invite.token, theo)).status).toBe(200);
    await app.db.db
      .update(collaborators)
      .set({ email: 'not-theo-anymore@removal-decks.test' })
      .where(eq(collaborators.id, invite.grantId));
    expect(await oss.grantRow(invite.grantId)).toMatchObject({
      status: 'active',
      userId: theo.userId,
      email: 'not-theo-anymore@removal-decks.test'
    });

    expect((await remove(theo.memberId, owner)).status).toBe(200);
    const row = await oss.grantRow(invite.grantId);
    expect(row.status).toBe('revoked');
    expect(row.revokedAt).not.toBeNull();
    expect(await removalRecord(theo.memberId)).toMatchObject({ deckGrants: 1, deckInvites: 0 });
  });

  it('T09: the hook called directly with two people holding one pending invite each: deckInvites 2', async () => {
    const owner = actors.owner!;
    const h1 = await addActor('hook-1');
    const h2 = await addActor('hook-2');
    const deck = await oss.createDeck(owner, 'Hook deck');
    const i1 = await oss.inviteOnDeck(deck, owner, h1.email);
    const i2 = await oss.inviteOnDeck(deck, owner, h2.email);
    const removed = [h1, h2].map((who) => ({ memberId: who.memberId, workspaceId, userId: who.userId }));

    const counts = await app.db.db.transaction((tx) => endDeckAccessOnRemoval(tx, removed));
    expect(counts).toEqual({ deckGrants: 0, deckInvites: 2, deckInvitesIssued: 0 });
    for (const id of [i1.grantId, i2.grantId]) {
      expect(await oss.grantRow(id)).toMatchObject({ status: 'revoked' });
    }
  });
});

// ─────────────────────────────── cloud ───────────────────────────────

const ORG = '28160000-aaaa-4bbb-8ccc-000000000001';
/** A second org of the member's, so their session keeps resolving while ORG is swept. */
const ORG_OTHER = '28160000-aaaa-4bbb-8ccc-000000000002';
const DIALS = {
  reconcileTtlMs: 120,
  reconcileStaleMaxMs: 60_000,
  retryMs: 250,
  orgsTimeoutMs: 400,
  tokenTimeoutMs: 2_000
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Let the per-user reconcile cache expire so the next request runs a fresh pass. */
const expireTtl = () => sleep(DIALS.reconcileTtlMs + 40);

const hubOwner: HubUserFixture = {
  sub: 'hub-owner-removal-decks',
  email: 'hub-owner@removal-decks.test',
  name: 'Hub Owner',
  workspaceId: ORG,
  role: 'owner',
  workspaceName: 'Org Removal Decks'
};
const hubMember: HubUserFixture = {
  sub: 'hub-member-removal-decks',
  email: 'hub-member@removal-decks.test',
  name: 'Hub Member',
  workspaceId: ORG,
  role: 'member',
  workspaceName: 'Org Removal Decks'
};

describe('cloud: the hub’s removal sweeps the deck invites and grants too', () => {
  let hub: FakeHub;
  let cloudApp: TestApp;
  const cloud = client(() => cloudApp);

  beforeAll(async () => {
    hub = await FakeHub.start({ clientId: 'tool-slideless-cloud' });
    cloudApp = await createTestApp(
      await createDatabase(container, 'removal_decks_cloud'),
      {
        EDITION: 'cloud',
        HUB_ISSUER_URL: hub.issuer,
        HUB_CLIENT_ID: 'tool-slideless-cloud',
        HUB_CLIENT_SECRET: 'integration-test-hub-secret-removal'
      },
      { hubDials: DIALS }
    );
    const setup = await cloud.send(
      'POST',
      '/setup',
      {},
      {
        setupToken: 'integration-test-setup-token',
        instanceName: 'Removal decks cloud',
        owner: { email: 'operator@removal-decks.test', name: 'Operator', password: PASSWORD }
      }
    );
    expect(setup.status).toBe(201);
  }, 180_000);

  afterAll(async () => {
    await cloudApp?.stop();
    await hub?.stop();
  });

  it('removed at the hub: the membership goes inactive and both collaborator rows are revoked', async () => {
    const ownerCookie = await sso.ssoLogin(cloudApp, hub, hubOwner);
    const ownerMe = await readJson(await cloud.send('GET', '/me', { cookie: ownerCookie }));
    const projected = ownerMe.activeWorkspaceId as string;
    expect(ownerMe.workspace.hubOrigin).toBe(true);
    const memberCookie = await sso.ssoLogin(cloudApp, hub, hubMember);
    const memberMe = await readJson(await cloud.send('GET', '/me', { cookie: memberCookie }));
    expect(memberMe.activeWorkspaceId).toBe(projected);
    const memberUserId = memberMe.user.id as string;

    const owner = { cookie: ownerCookie };
    const member = { cookie: memberCookie };
    const inWs = { 'x-workspace-id': projected };
    const deckA = await cloud.createDeck(owner, 'Cloud deck A', inWs);
    const deckB = await cloud.createDeck(owner, 'Cloud deck B', inWs);
    // The grant first (a claim sweeps sibling pending invites), then the pending invite.
    const granted = await cloud.inviteOnDeck(deckA, owner, hubMember.email, inWs);
    expect((await cloud.claim(granted.token, member)).status).toBe(200);
    const pending = await cloud.inviteOnDeck(deckB, owner, hubMember.email, inWs);
    expect(await cloud.grantRow(granted.grantId)).toMatchObject({ status: 'active' });
    expect(await cloud.grantRow(pending.grantId)).toMatchObject({ status: 'pending' });
    expect(await cloud.memberRowOf(memberUserId, projected)).toMatchObject({ isActive: true, origin: 'hub' });

    // Removed from the org at the hub; the next request's reconcile pass sweeps.
    hub.setUserOrg(hubMember.sub, ORG_OTHER, { name: 'Another Org', role: 'member' });
    hub.removeUserOrg(hubMember.sub, ORG);
    await expireTtl();
    await cloud.send('GET', '/me', member);

    expect(await cloud.memberRowOf(memberUserId, projected)).toMatchObject({ isActive: false });
    for (const id of [granted.grantId, pending.grantId]) {
      const row = await cloud.grantRow(id);
      expect(row.status).toBe('revoked');
      expect(row.revokedAt).not.toBeNull();
    }
  });
});
