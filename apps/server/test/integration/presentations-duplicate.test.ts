import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { auditLog, files } from '@antasphere/chassis-db';
import { presentations, presentationVersions } from '@slideless/db';
import {
  createDatabase,
  createTestApp,
  extractCookie,
  readJson,
  startPostgres,
  type TestApp
} from './helpers.js';

/**
 * Duplicate (PRDCT-2279, the master page's "Duplicate"), end to end:
 *
 *  - the copy is a NEW deck in the same workspace at version 1, whose
 *    manifest is the source version's sha for sha (the current version by
 *    default, a chosen one on request), with lineage in `remixedFrom`; no
 *    blob is written — the `files` row count is unchanged;
 *  - the source is a READ: a plain member with no grant gets the same 404 a
 *    nonexistent id gets (never a 403); a local member holding an active
 *    dev grant may copy the deck into one of their own;
 *  - deck creation stays guest-forbidden: a guest with a grant on the source
 *    is refused 403 guest_forbidden, whatever the id;
 *  - one Idempotency-Key mints exactly one copy;
 *  - the scope allowlist: a read key is refused, a write key allowed.
 */

const OWNER = { email: 'owner@dup.test', name: 'Dup Owner', password: 'dup-owner-pass-1234' };
const MEMBER = { email: 'member@dup.test', name: 'Dup Member', password: 'dup-member-pass-1234' };
const DEVU = { email: 'dev@dup.test', name: 'Dup Dev', password: 'dup-dev-pass-1234' };
const GUEST = { email: 'guest@outside.test', name: 'Outside Guest', password: 'dup-guest-pass-1234' };

const HTML_V1 = Buffer.from('<!doctype html><html><body><h1>Quarterly review v1</h1></body></html>');
const HTML_V2 = Buffer.from('<!doctype html><html><body><h1>Quarterly review v2</h1></body></html>');
const CSV = Buffer.from('quarter,revenue\nQ3,42\n');
const PDF_V1 = Buffer.from('%PDF-1.4 annex v1');
const PDF_V2 = Buffer.from('%PDF-1.4 annex v2');
const NOTES = Buffer.from('# notes\n');

/** A high surrogate without its low, or a low without its high: a string Postgres would not take as-is. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const shaOf = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const entryOf = (path: string, bytes: Buffer, contentType: string) => ({
  path,
  sha256: shaOf(bytes),
  sizeBytes: bytes.length,
  contentType
});

const MANIFEST_V1 = [
  entryOf('index.html', HTML_V1, 'text/html'),
  entryOf('downloads/figures.csv', CSV, 'text/csv'),
  entryOf('downloads/annex.pdf', PDF_V1, 'application/pdf')
];
const MANIFEST_V2 = [
  entryOf('index.html', HTML_V2, 'text/html'),
  entryOf('downloads/figures.csv', CSV, 'text/csv'),
  entryOf('downloads/annex.pdf', PDF_V2, 'application/pdf'),
  entryOf('downloads/notes.md', NOTES, 'text/markdown')
];

const UNKNOWN_DECK = '00000000-0000-4000-8000-0000000000dd';

let container: StartedPostgreSqlContainer;
let app: TestApp;
let ownerCookie: string;
let memberCookie: string;
let devCookie: string;
let guestCookie: string;
let readKey: string;
let writeKey: string;
/** "Quarterly review", v1 + v2, owned by OWNER. */
let deckId: string;

let ipCounter = 0;
const nextIp = () => `10.99.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp(), ...headers },
  body: JSON.stringify(body)
});

const get = (path: string, headers: Record<string, string>) =>
  app.app.request(path, { headers: { 'x-forwarded-for': nextIp(), ...headers } });

async function signIn(p: { email: string; password: string }): Promise<string> {
  const res = await app.app.request(
    '/api/v1/auth/sign-in/email',
    json({ email: p.email, password: p.password })
  );
  expect(res.status).toBe(200);
  return extractCookie(res);
}

async function addMember(p: { email: string; name: string; password: string }): Promise<string> {
  const invite = await app.app.request(
    '/api/v1/invitations',
    json({ email: p.email, role: 'member' }, { cookie: ownerCookie })
  );
  expect(invite.status).toBe(201);
  const acceptToken = ((await readJson(invite)).acceptUrl as string).split('/invite/')[1]!;
  const accept = await app.app.request(
    '/api/v1/invitations/accept',
    json({ token: acceptToken, name: p.name, password: p.password })
  );
  expect(accept.status).toBe(200);
  return signIn(p);
}

async function uploadAsset(bytes: Buffer, contentType: string, name: string): Promise<void> {
  const form = new FormData();
  form.set('sha256', shaOf(bytes));
  form.set('file', new Blob([new Uint8Array(bytes)], { type: contentType }), name);
  const res = await app.app.request('/api/v1/presentations/assets', {
    method: 'POST',
    headers: { cookie: ownerCookie },
    body: form
  });
  expect(res.status).toBe(201);
}

async function mintKey(name: string, scopes: string[]): Promise<string> {
  const res = await app.app.request('/api/v1/api-keys', json({ name, scopes }, { cookie: ownerCookie }));
  expect(res.status).toBe(201);
  return (await readJson(res)).key as string;
}

function duplicate(id: string, body: Record<string, unknown>, headers: Record<string, string>) {
  return app.app.request(`/api/v1/presentations/${id}/duplicate`, json(body, headers));
}

async function versionDetail(id: string, version: number, cookie = ownerCookie) {
  const res = await get(`/api/v1/presentations/${id}/versions/${version}`, { cookie });
  expect(res.status).toBe(200);
  return readJson(res);
}

const shaSetOf = (manifest: Array<{ path: string; sha256: string }>) =>
  [...manifest].map((e) => `${e.path}=${e.sha256}`).sort();

async function liveFilesCount(): Promise<number> {
  const [row] = await app.db.db
    .select({ n: sql<number>`count(*)::int` })
    .from(files)
    .where(isNull(files.deletedAt));
  return row!.n;
}

async function liveDecksCount(): Promise<number> {
  const [row] = await app.db.db
    .select({ n: sql<number>`count(*)::int` })
    .from(presentations)
    .where(isNull(presentations.deletedAt));
  return row!.n;
}

beforeAll(async () => {
  container = await startPostgres();
  app = await createTestApp(await createDatabase(container, 'duplicate'));
  await app.app.request(
    '/api/v1/setup',
    json({ setupToken: 'integration-test-setup-token', instanceName: 'Duplicate', owner: OWNER })
  );
  ownerCookie = await signIn(OWNER);
  memberCookie = await addMember(MEMBER);
  devCookie = await addMember(DEVU);
  readKey = await mintKey('read-key', ['presentations:read']);
  writeKey = await mintKey('write-key', ['presentations:read', 'presentations:write']);

  for (const [bytes, type, name] of [
    [HTML_V1, 'text/html', 'index.html'],
    [HTML_V2, 'text/html', 'index.html'],
    [CSV, 'text/csv', 'figures.csv'],
    [PDF_V1, 'application/pdf', 'annex.pdf'],
    [PDF_V2, 'application/pdf', 'annex.pdf'],
    [NOTES, 'text/markdown', 'notes.md']
  ] as const) {
    await uploadAsset(bytes, type, name);
  }
  const reserve = await readJson(
    await app.app.request('/api/v1/presentations/uploads', {
      method: 'POST',
      headers: { cookie: ownerCookie }
    })
  );
  const commit = await app.app.request(
    `/api/v1/presentations/uploads/${reserve.uploadSession.id}/commit`,
    json(
      { title: 'Quarterly review', entryPath: 'index.html', manifest: MANIFEST_V1 },
      { cookie: ownerCookie }
    )
  );
  expect(commit.status).toBe(201);
  deckId = (await readJson(commit)).presentation.id;
  const v2 = await app.app.request(
    `/api/v1/presentations/${deckId}/versions`,
    json({ expectedBaseVersion: 1, entryPath: 'index.html', manifest: MANIFEST_V2 }, { cookie: ownerCookie })
  );
  expect(v2.status).toBe(201);

  // DEVU: a LOCAL member holding an active dev grant on the deck (claims
  // with their own session, so their origin stays 'local').
  const devInvite = await readJson(
    await app.app.request(
      `/api/v1/presentations/${deckId}/collaborators`,
      json({ email: DEVU.email }, { cookie: ownerCookie })
    )
  );
  const devClaim = await app.app.request(
    '/api/v1/collaborators/claim',
    json({ token: devInvite.claimUrl.split('/collab/')[1] }, { cookie: devCookie })
  );
  expect(devClaim.status).toBe(200);

  // GUEST: an outsider claiming the same deck without an account — the
  // claim path mints an origin='guest' membership (D2).
  const guestInvite = await readJson(
    await app.app.request(
      `/api/v1/presentations/${deckId}/collaborators`,
      json({ email: GUEST.email }, { cookie: ownerCookie })
    )
  );
  const guestClaim = await app.app.request(
    '/api/v1/collaborators/claim',
    json({ token: guestInvite.claimUrl.split('/collab/')[1], name: GUEST.name, password: GUEST.password })
  );
  expect(guestClaim.status).toBe(200);
  guestCookie = await signIn(GUEST);
}, 240_000);

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

describe('what a duplicate is', () => {
  it('creates a new deck at version 1 with the CURRENT version’s manifest sha for sha, lineage set, no new blob', async () => {
    const filesBefore = await liveFilesCount();
    const decksBefore = await liveDecksCount();

    const res = await duplicate(deckId, {}, { cookie: ownerCookie });
    expect(res.status).toBe(201);
    const { presentation: copy, version } = await readJson(res);

    expect(copy.id).not.toBe(deckId);
    expect(copy.title).toBe('Quarterly review (copy)');
    expect(copy.remixedFrom).toBe(deckId);
    expect(copy.currentVersion).toBe(1);
    expect(copy.hasDownloads).toBe(true);
    expect(copy.totalViews).toBe(0);
    expect(version.version).toBe(1);
    expect(version.createdByRole).toBe('owner');
    expect(version.fileCount).toBe(MANIFEST_V2.length);

    const source = await versionDetail(deckId, 2);
    const copied = await versionDetail(copy.id, 1);
    expect(shaSetOf(copied.manifest)).toEqual(shaSetOf(source.manifest));
    expect(copied.attachments.map((a: { name: string }) => a.name)).toEqual(
      source.attachments.map((a: { name: string }) => a.name)
    );
    expect(copied.entryPath).toBe('index.html');

    expect(await liveFilesCount()).toBe(filesBefore);
    expect(await liveDecksCount()).toBe(decksBefore + 1);

    // The copy's blobs serve through the copy's own asset route (the manifest
    // containment check holds for the copied manifest).
    const asset = await get(`/api/v1/presentations/${copy.id}/assets/${shaOf(CSV)}`, { cookie: ownerCookie });
    expect(asset.status).toBe(200);
    expect(Buffer.from(await asset.arrayBuffer()).equals(CSV)).toBe(true);

    const [audit] = await app.db.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'presentation.duplicate'), eq(auditLog.resourceId, copy.id)));
    expect(audit).toBeDefined();
    expect((audit!.metadata as { sourceId: string; sourceVersion: number }).sourceId).toBe(deckId);
    expect((audit!.metadata as { sourceId: string; sourceVersion: number }).sourceVersion).toBe(2);
  });

  it('copies a CHOSEN version and honours a title', async () => {
    const res = await duplicate(deckId, { version: 1, title: 'Board copy' }, { cookie: ownerCookie });
    expect(res.status).toBe(201);
    const { presentation: copy } = await readJson(res);
    expect(copy.title).toBe('Board copy');
    const source = await versionDetail(deckId, 1);
    const copied = await versionDetail(copy.id, 1);
    expect(shaSetOf(copied.manifest)).toEqual(shaSetOf(source.manifest));
    expect(copied.attachments).toHaveLength(2);
  });

  it('refuses a version the source does not have (400 invalid_version) and writes nothing', async () => {
    const decksBefore = await liveDecksCount();
    const res = await duplicate(deckId, { version: 99 }, { cookie: ownerCookie });
    expect(res.status).toBe(400);
    expect((await readJson(res)).error.code).toBe('invalid_version');
    expect(await liveDecksCount()).toBe(decksBefore);
  });

  it('names the copy by code point: a 300-unit emoji title gets no lone surrogate', async () => {
    // Verifier round 1: a unit-wise slice split a surrogate pair and Postgres
    // stored U+FFFD. The title is legal on the wire (300 UTF-16 units).
    const emoji = '😀'.repeat(150);
    const reserve = await readJson(
      await app.app.request('/api/v1/presentations/uploads', {
        method: 'POST',
        headers: { cookie: ownerCookie }
      })
    );
    const commit = await app.app.request(
      `/api/v1/presentations/uploads/${reserve.uploadSession.id}/commit`,
      json({ title: emoji, entryPath: 'index.html', manifest: MANIFEST_V1 }, { cookie: ownerCookie })
    );
    expect(commit.status).toBe(201);
    const sourceId = (await readJson(commit)).presentation.id as string;
    const res = await duplicate(sourceId, {}, { cookie: ownerCookie });
    expect(res.status).toBe(201);
    const title = (await readJson(res)).presentation.title as string;
    expect(title.endsWith(' (copy)')).toBe(true);
    expect(title.length).toBeLessThanOrEqual(300);
    expect(LONE_SURROGATE.test(title)).toBe(false);
    expect(title.includes('\uFFFD')).toBe(false);
    expect(Array.from(title.slice(0, -' (copy)'.length)).every((c) => c === '😀')).toBe(true);
  });

  it('the audit row names the version the transaction copied, on the chosen-version path too', async () => {
    const res = await duplicate(deckId, { version: 1, title: 'Audited copy' }, { cookie: ownerCookie });
    expect(res.status).toBe(201);
    const copyId = (await readJson(res)).presentation.id as string;
    const [audit] = await app.db.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'presentation.duplicate'), eq(auditLog.resourceId, copyId)));
    expect((audit!.metadata as { sourceVersion: number }).sourceVersion).toBe(1);
  });

  it('the copy’s version row keeps the source’s entry path and its forms flag', async () => {
    // A forms deck whose entry is NOT the column default: the viewer serves
    // the copy by version.entryPath and arms the forms runtime from
    // version.hasForms, so a copy that lost either would not serve, or
    // would drop submissions (verifier round 1, gaps M12 and M14).
    const FORM_HTML = Buffer.from(
      '<!doctype html><html><body><form data-slideless-form="rsvp"><input name="who"></form></body></html>'
    );
    await uploadAsset(FORM_HTML, 'text/html', 'deck.html');
    const reserve = await readJson(
      await app.app.request('/api/v1/presentations/uploads', {
        method: 'POST',
        headers: { cookie: ownerCookie }
      })
    );
    const commit = await app.app.request(
      `/api/v1/presentations/uploads/${reserve.uploadSession.id}/commit`,
      json(
        { title: 'RSVP', entryPath: 'deck.html', manifest: [entryOf('deck.html', FORM_HTML, 'text/html')] },
        { cookie: ownerCookie }
      )
    );
    expect(commit.status).toBe(201);
    const sourceId = (await readJson(commit)).presentation.id as string;
    const res = await duplicate(sourceId, {}, { cookie: ownerCookie });
    expect(res.status).toBe(201);
    const { presentation: copy, version } = await readJson(res);
    expect(copy.entryPath).toBe('deck.html');
    expect(version.entryPath).toBe('deck.html');
    const [sourceRow] = await app.db.db
      .select({ hasForms: presentationVersions.hasForms, entryPath: presentationVersions.entryPath })
      .from(presentationVersions)
      .where(and(eq(presentationVersions.presentationId, sourceId), eq(presentationVersions.version, 1)));
    const [copyRow] = await app.db.db
      .select({ hasForms: presentationVersions.hasForms, entryPath: presentationVersions.entryPath })
      .from(presentationVersions)
      .where(and(eq(presentationVersions.presentationId, copy.id), eq(presentationVersions.version, 1)));
    expect(sourceRow!.hasForms).toBe(true);
    expect(copyRow).toEqual({ hasForms: true, entryPath: 'deck.html' });
    const [deckRow] = await app.db.db
      .select({ hasForms: presentations.hasForms })
      .from(presentations)
      .where(eq(presentations.id, copy.id));
    expect(deckRow!.hasForms).toBe(true);
  });

  it('a copy of a copy points at the copy, not the original', async () => {
    const first = await readJson(await duplicate(deckId, { title: 'Gen 1' }, { cookie: ownerCookie }));
    const second = await readJson(
      await duplicate(first.presentation.id, { title: 'Gen 2' }, { cookie: ownerCookie })
    );
    expect(second.presentation.remixedFrom).toBe(first.presentation.id);
  });
});

describe('who may duplicate', () => {
  it('a plain member with no grant: 404 not_found, the same for a nonexistent id', async () => {
    const real = await duplicate(deckId, {}, { cookie: memberCookie });
    const fake = await duplicate(UNKNOWN_DECK, {}, { cookie: memberCookie });
    expect([real.status, fake.status]).toEqual([404, 404]);
    expect((await readJson(real)).error.code).toBe('not_found');
    expect((await readJson(fake)).error.code).toBe('not_found');
  });

  it('a local member holding an active dev grant copies the deck into one they own', async () => {
    const filesBefore = await liveFilesCount();
    const res = await duplicate(deckId, {}, { cookie: devCookie });
    expect(res.status).toBe(201);
    const { presentation: copy, version } = await readJson(res);
    expect(copy.remixedFrom).toBe(deckId);
    expect(version.createdByRole).toBe('owner');
    expect(await liveFilesCount()).toBe(filesBefore);

    // Their own deck: readable by them, invisible to the plain member.
    const mine = await get(`/api/v1/presentations/${copy.id}`, { cookie: devCookie });
    expect(mine.status).toBe(200);
    expect((await readJson(mine)).ownerUserId).not.toBeNull();
    const notTheirs = await get(`/api/v1/presentations/${copy.id}`, { cookie: memberCookie });
    expect(notTheirs.status).toBe(404);
    // And the copy's blobs serve for them through the copy (blob scope: a
    // live version of a deck they own).
    const asset = await get(`/api/v1/presentations/${copy.id}/assets/${shaOf(NOTES)}`, { cookie: devCookie });
    expect(asset.status).toBe(200);
  });

  it('a guest holding a grant on the source: 403 guest_forbidden, whatever the id', async () => {
    const decksBefore = await liveDecksCount();
    const real = await duplicate(deckId, {}, { cookie: guestCookie });
    const fake = await duplicate(UNKNOWN_DECK, {}, { cookie: guestCookie });
    expect([real.status, fake.status]).toEqual([403, 403]);
    expect((await readJson(real)).error.code).toBe('guest_forbidden');
    expect((await readJson(fake)).error.code).toBe('guest_forbidden');
    expect(await liveDecksCount()).toBe(decksBefore);
    // The guest still reads the source (their grant is untouched).
    expect((await get(`/api/v1/presentations/${deckId}`, { cookie: guestCookie })).status).toBe(200);
  });

  it('machine principals: a read key is refused at the scope gate, a write key duplicates', async () => {
    const denied = await duplicate(deckId, {}, { authorization: `Bearer ${readKey}` });
    expect(denied.status).toBe(403);
    const allowed = await duplicate(deckId, { title: 'By key' }, { authorization: `Bearer ${writeKey}` });
    expect(allowed.status).toBe(201);
    expect((await readJson(allowed)).presentation.title).toBe('By key');
  });
});

describe('one click, one copy', () => {
  it('replays the same copy under one Idempotency-Key', async () => {
    const decksBefore = await liveDecksCount();
    const headers = { cookie: ownerCookie, 'idempotency-key': 'dup-click-1' };
    const first = await duplicate(deckId, { title: 'Once' }, headers);
    expect(first.status).toBe(201);
    const second = await duplicate(deckId, { title: 'Once' }, headers);
    expect(second.status).toBe(201);
    expect(second.headers.get('idempotency-replayed')).toBe('true');
    expect((await readJson(second)).presentation.id).toBe((await readJson(first)).presentation.id);
    expect(await liveDecksCount()).toBe(decksBefore + 1);
  });
});
