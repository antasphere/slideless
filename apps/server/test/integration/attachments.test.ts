import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { and, eq, isNull, sql } from 'drizzle-orm';
import AdmZip from 'adm-zip';
import { files, presentations, shareTokenDownloads, shareTokens } from '@slideless/db';
import { purgeShareTokenDownloads } from '../../src/sharing/download-events.js';
import { VIEWER_CSP } from '../../src/viewer/routes.js';
import {
  createDatabase,
  createTestApp,
  extractCookie,
  readJson,
  startPostgres,
  type TestApp
} from './helpers.js';

/**
 * Attachments — the `downloads/` convention (PRDCT-2278), end to end:
 *
 *  - at COMMIT every entry under `downloads/` is an attachment: the version
 *    and the deck are stamped hasDownloads, the version detail derives the
 *    list by name, and a version is its own file set (v1 keeps its files
 *    after v2 replaces one and adds one, and exactly the two new blobs land
 *    in storage);
 *  - on the RECIPIENT side a link serves the set of the version it resolves
 *    to (latest follows, pinned stays), one file at a time with a FORCED
 *    attachment disposition or the whole set as a streamed store-only zip;
 *    an HTML file in the folder is never rendered — not through the
 *    attachment route, not through the generic asset route (encoded slash);
 *  - `canDownload` off: 404 on the files and the zip, an EMPTY list (200,
 *    never 403), the deck itself still opens; the default is on;
 *  - a download is one EVENT and one increment of the link's counter, never
 *    a view; HEAD, 304 and owner previews never count; the nightly purge
 *    prunes the events like the view events;
 *  - the OWNER side serves any version's set under canReadDeck (404 for a
 *    non-reader, never 403), read keys allowed, write-only keys refused.
 */

const OWNER = { email: 'owner@attach.test', name: 'Attach Owner', password: 'attach-owner-pass-1' };
const MEMBER = { email: 'member@attach.test', name: 'Plain Member', password: 'attach-member-pass-1' };

const HTML = Buffer.from('<!doctype html><html><body><h1>Quarterly review</h1></body></html>');
const CSV_A = Buffer.from('quarter,revenue\nQ3,42\n');
const PDF_B1 = Buffer.from('%PDF-1.4 annex v1');
const PDF_B2 = Buffer.from('%PDF-1.4 annex v2 (replaced)');
const ZIP_C = Buffer.from('PK sources v2');
const PAGE_HTML = Buffer.from('<!doctype html><html><body><script>alert(1)</script>not a page</body></html>');
const NOTES_MD = Buffer.from('# notes\n');

const shaOf = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const entryOf = (path: string, bytes: Buffer, contentType: string) => ({
  path,
  sha256: shaOf(bytes),
  sizeBytes: bytes.length,
  contentType
});

/** v1: a.csv, b.pdf (v1 bytes), page.html, sub/notes.md. */
const MANIFEST_V1 = [
  entryOf('index.html', HTML, 'text/html'),
  entryOf('downloads/a.csv', CSV_A, 'text/csv'),
  entryOf('downloads/b.pdf', PDF_B1, 'application/pdf'),
  entryOf('downloads/page.html', PAGE_HTML, 'text/html'),
  entryOf('downloads/sub/notes.md', NOTES_MD, 'text/markdown')
];
/** v2: b.pdf replaced, c.zip added — exactly two new blobs. */
const MANIFEST_V2 = [
  entryOf('index.html', HTML, 'text/html'),
  entryOf('downloads/a.csv', CSV_A, 'text/csv'),
  entryOf('downloads/b.pdf', PDF_B2, 'application/pdf'),
  entryOf('downloads/c.zip', ZIP_C, 'application/zip'),
  entryOf('downloads/page.html', PAGE_HTML, 'text/html'),
  entryOf('downloads/sub/notes.md', NOTES_MD, 'text/markdown')
];
const V1_NAMES = ['a.csv', 'b.pdf', 'page.html', 'sub/notes.md'];
const V2_NAMES = ['a.csv', 'b.pdf', 'c.zip', 'page.html', 'sub/notes.md'];

let container: StartedPostgreSqlContainer;
let app: TestApp;
let ownerCookie: string;
let memberCookie: string;
let readKey: string;
let writeOnlyKey: string;
/** The deck with attachments ("Quarterly review", v1 + v2). */
let deckId: string;
/** A deck with no downloads/ folder. */
let plainDeckId: string;

let ipCounter = 0;
const nextIp = () => `10.98.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp(), ...headers },
  body: JSON.stringify(body)
});

const get = (path: string, headers: Record<string, string> = {}, init: RequestInit = {}) =>
  app.app.request(path, { ...init, headers: { 'x-forwarded-for': nextIp(), ...headers } });

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

async function createDeck(title: string, manifest: typeof MANIFEST_V1) {
  const reserve = await readJson(
    await app.app.request('/api/v1/presentations/uploads', {
      method: 'POST',
      headers: { cookie: ownerCookie }
    })
  );
  const commit = await app.app.request(
    `/api/v1/presentations/uploads/${reserve.uploadSession.id}/commit`,
    json({ title, entryPath: 'index.html', manifest }, { cookie: ownerCookie })
  );
  expect(commit.status).toBe(201);
  return readJson(commit);
}

async function commitVersion(id: string, expectedBaseVersion: number, manifest: typeof MANIFEST_V1) {
  const res = await app.app.request(
    `/api/v1/presentations/${id}/versions`,
    json({ expectedBaseVersion, entryPath: 'index.html', manifest }, { cookie: ownerCookie })
  );
  expect(res.status).toBe(201);
  return readJson(res);
}

async function versionDetail(id: string, version: number) {
  const res = await get(`/api/v1/presentations/${id}/versions/${version}`, { cookie: ownerCookie });
  expect(res.status).toBe(200);
  return readJson(res);
}

async function createToken(body: Record<string, unknown>) {
  const res = await app.app.request(
    `/api/v1/presentations/${deckId}/tokens`,
    json(body, { cookie: ownerCookie })
  );
  expect(res.status).toBe(201);
  return readJson(res);
}

async function liveFilesCount(): Promise<number> {
  const [row] = await app.db.db
    .select({ n: sql<number>`count(*)::int` })
    .from(files)
    .where(isNull(files.deletedAt));
  return row!.n;
}

async function tokenRow(tokenId: string) {
  const [row] = await app.db.db.select().from(shareTokens).where(eq(shareTokens.id, tokenId));
  return row!;
}

async function downloadRows(tokenId: string) {
  return app.db.db
    .select()
    .from(shareTokenDownloads)
    .where(eq(shareTokenDownloads.shareTokenId, tokenId))
    .orderBy(shareTokenDownloads.occurredAt, shareTokenDownloads.id);
}

async function mintKey(name: string, scopes: string[]): Promise<string> {
  const res = await app.app.request('/api/v1/api-keys', json({ name, scopes }, { cookie: ownerCookie }));
  expect(res.status).toBe(201);
  return (await readJson(res)).key as string;
}

/** Every attachment response wears the exact ADR 012 set + a FORCED attachment disposition. */
function expectAttachmentResponse(res: Response, basename: string, contentType: string): void {
  expect(res.headers.get('content-security-policy')).toBe(VIEWER_CSP);
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  expect(res.headers.get('content-type')).toBe(contentType);
  expect(res.headers.get('content-disposition')).toBe(
    `attachment; filename="${basename}"; filename*=UTF-8''${encodeURIComponent(basename)}`
  );
  expect(res.headers.get('cache-control')).toBe('private, no-cache');
  expect(res.headers.get('set-cookie')).toBeNull();
}

beforeAll(async () => {
  container = await startPostgres();
  app = await createTestApp(await createDatabase(container, 'attachments'));
  await app.app.request(
    '/api/v1/setup',
    json({ setupToken: 'integration-test-setup-token', instanceName: 'Attachments', owner: OWNER })
  );
  ownerCookie = extractCookie(
    await app.app.request(
      '/api/v1/auth/sign-in/email',
      json({ email: OWNER.email, password: OWNER.password })
    )
  );

  const invite = await app.app.request(
    '/api/v1/invitations',
    json({ email: MEMBER.email, role: 'member' }, { cookie: ownerCookie })
  );
  expect(invite.status).toBe(201);
  const acceptToken = ((await readJson(invite)).acceptUrl as string).split('/invite/')[1]!;
  const accept = await app.app.request(
    '/api/v1/invitations/accept',
    json({ token: acceptToken, name: MEMBER.name, password: MEMBER.password })
  );
  expect(accept.status).toBe(200);
  memberCookie = extractCookie(
    await app.app.request(
      '/api/v1/auth/sign-in/email',
      json({ email: MEMBER.email, password: MEMBER.password })
    )
  );
  readKey = await mintKey('read-key', ['presentations:read']);
  writeOnlyKey = await mintKey('write-only-key', ['presentations:write']);

  for (const [bytes, type, name] of [
    [HTML, 'text/html', 'index.html'],
    [CSV_A, 'text/csv', 'a.csv'],
    [PDF_B1, 'application/pdf', 'b.pdf'],
    [PAGE_HTML, 'text/html', 'page.html'],
    [NOTES_MD, 'text/markdown', 'notes.md']
  ] as const) {
    await uploadAsset(bytes, type, name);
  }
  const created = await createDeck('Quarterly review', MANIFEST_V1);
  deckId = created.presentation.id;
  const plain = await createDeck('Plain deck', [entryOf('index.html', HTML, 'text/html')]);
  plainDeckId = plain.presentation.id;
}, 120_000);

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

// ═══ The convention at commit ════════════════════════════════════════════════

describe('the downloads/ convention at commit', () => {
  it('stamps hasDownloads on the version and the deck, and the detail derives the attachments by name', async () => {
    const deck = await readJson(await get(`/api/v1/presentations/${deckId}`, { cookie: ownerCookie }));
    expect(deck.hasDownloads).toBe(true);
    const v1 = await versionDetail(deckId, 1);
    expect(v1.hasDownloads).toBe(true);
    expect(v1.attachments.map((a: { name: string }) => a.name)).toEqual(V1_NAMES);
    const csv = v1.attachments.find((a: { name: string }) => a.name === 'a.csv');
    expect(csv).toMatchObject({
      path: 'downloads/a.csv',
      sizeBytes: CSV_A.length,
      contentType: 'text/csv',
      sha256: shaOf(CSV_A)
    });
    // The list is derived; the manifest still carries every file.
    expect(v1.manifest).toHaveLength(MANIFEST_V1.length);
    const listed = await readJson(
      await get(`/api/v1/presentations/${deckId}/versions`, { cookie: ownerCookie })
    );
    expect(listed.versions[0].hasDownloads).toBe(true);
  });

  it('v2 replaces one file and adds one: v1 keeps its set, v2 shows the new one, exactly two new blobs', async () => {
    const before = await liveFilesCount();
    await uploadAsset(PDF_B2, 'application/pdf', 'b.pdf');
    await uploadAsset(ZIP_C, 'application/zip', 'c.zip');
    const committed = await commitVersion(deckId, 1, MANIFEST_V2);
    expect(committed.version.version).toBe(2);
    expect(committed.version.hasDownloads).toBe(true);
    expect(committed.presentation.hasDownloads).toBe(true);
    expect((await liveFilesCount()) - before).toBe(2);

    const v1 = await versionDetail(deckId, 1);
    expect(v1.attachments.map((a: { name: string }) => a.name)).toEqual(V1_NAMES);
    expect(v1.attachments.find((a: { name: string }) => a.name === 'b.pdf').sha256).toBe(shaOf(PDF_B1));
    const v2 = await versionDetail(deckId, 2);
    expect(v2.attachments.map((a: { name: string }) => a.name)).toEqual(V2_NAMES);
    expect(v2.attachments.find((a: { name: string }) => a.name === 'b.pdf').sha256).toBe(shaOf(PDF_B2));
  });

  it('a deck without a downloads/ folder: hasDownloads false, an empty list, no zip', async () => {
    const deck = await readJson(await get(`/api/v1/presentations/${plainDeckId}`, { cookie: ownerCookie }));
    expect(deck.hasDownloads).toBe(false);
    const v1 = await versionDetail(plainDeckId, 1);
    expect(v1.hasDownloads).toBe(false);
    expect(v1.attachments).toEqual([]);
    const zip = await get(`/api/v1/presentations/${plainDeckId}/versions/1/downloads.zip`, {
      cookie: ownerCookie
    });
    expect(zip.status).toBe(404);
    expect((await readJson(zip)).error.code).toBe('no_attachments');
  });

  it('the folder is exact and case-sensitive: Downloads/ and downloads-old/ are not attachments', async () => {
    const committed = await commitVersion(plainDeckId, 1, [
      entryOf('index.html', HTML, 'text/html'),
      entryOf('Downloads/x.md', NOTES_MD, 'text/markdown'),
      entryOf('downloads-old/y.md', NOTES_MD, 'text/markdown')
    ]);
    expect(committed.version.hasDownloads).toBe(false);
    expect(committed.presentation.hasDownloads).toBe(false);
    expect((await versionDetail(plainDeckId, 2)).attachments).toEqual([]);
  });
});

// ═══ The recipient side ══════════════════════════════════════════════════════

describe('the recipient side: the share link', () => {
  it('a latest link lists and serves v2; a link pinned to v1 lists and serves v1', async () => {
    const latest = await createToken({ name: 'Latest' });
    const pinned = await createToken({ name: 'Pinned v1', versionMode: 'pinned', pinnedVersion: 1 });

    const latestList = await readJson(await get(`/api/v1/viewer/${latest.secret}/attachments`));
    expect(latestList.version).toBe(2);
    expect(latestList.attachments.map((a: { name: string }) => a.name)).toEqual(V2_NAMES);
    const pinnedList = await readJson(await get(`/api/v1/viewer/${pinned.secret}/attachments`));
    expect(pinnedList.version).toBe(1);
    expect(pinnedList.attachments.map((a: { name: string }) => a.name)).toEqual(V1_NAMES);

    const latestPdf = await get(`/v/${latest.secret}/downloads/b.pdf`);
    expect(latestPdf.status).toBe(200);
    expect(Buffer.from(await latestPdf.arrayBuffer()).equals(PDF_B2)).toBe(true);
    const pinnedPdf = await get(`/v/${pinned.secret}/downloads/b.pdf`);
    expect(pinnedPdf.status).toBe(200);
    expect(Buffer.from(await pinnedPdf.arrayBuffer()).equals(PDF_B1)).toBe(true);
    // c.zip exists on v2 only.
    expect((await get(`/v/${pinned.secret}/downloads/c.zip`)).status).toBe(404);
    expect((await get(`/v/${latest.secret}/downloads/c.zip`)).status).toBe(200);
  });

  it('a file downloads with a forced attachment disposition, the manifest type, nosniff, the sandbox set, ETag and Range', async () => {
    const { secret } = await createToken({ name: 'Files' });
    const csv = await get(`/v/${secret}/downloads/a.csv`);
    expect(csv.status).toBe(200);
    expectAttachmentResponse(csv, 'a.csv', 'text/csv');
    expect(csv.headers.get('etag')).toBe(`"${shaOf(CSV_A)}"`);
    expect(Buffer.from(await csv.arrayBuffer()).equals(CSV_A)).toBe(true);

    // A PDF is inline-safe on the asset routes; here it is an ATTACHMENT.
    const pdf = await get(`/v/${secret}/downloads/b.pdf`);
    expect(pdf.status).toBe(200);
    expectAttachmentResponse(pdf, 'b.pdf', 'application/pdf');

    // A nested name: the basename is the download filename.
    const notes = await get(`/v/${secret}/downloads/sub/notes.md`);
    expect(notes.status).toBe(200);
    expectAttachmentResponse(notes, 'notes.md', 'text/markdown');
    expect(await notes.text()).toBe(NOTES_MD.toString());

    const partial = await get(`/v/${secret}/downloads/a.csv`, { range: 'bytes=0-6' });
    expect(partial.status).toBe(206);
    expect(partial.headers.get('content-range')).toBe(`bytes 0-6/${CSV_A.length}`);
    expect(Buffer.from(await partial.arrayBuffer()).equals(CSV_A.subarray(0, 7))).toBe(true);

    const cached = await get(`/v/${secret}/downloads/a.csv`, { 'if-none-match': `"${shaOf(CSV_A)}"` });
    expect(cached.status).toBe(304);
  });

  it('an HTML file in downloads/ is never rendered: attachment on its route, 404 through the generic asset route', async () => {
    const { secret } = await createToken({ name: 'Never inline' });
    // A browser navigation to the file, the shape the injection seam keys on.
    const nav = await get(`/v/${secret}/downloads/page.html`, {
      accept: 'text/html,application/xhtml+xml',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'user-agent': 'Mozilla/5.0 Chrome/126.0.0.0 Safari/537.36'
    });
    expect(nav.status).toBe(200);
    expectAttachmentResponse(nav, 'page.html', 'text/html');
    // Byte-exact: nothing was injected into it.
    expect(Buffer.from(await nav.arrayBuffer()).equals(PAGE_HTML)).toBe(true);

    // The encoded-slash shape is ONE segment to the router, so it reaches the
    // generic asset route decoded as `downloads/page.html`: refused there.
    for (const path of ['downloads%2Fpage.html', 'downloads%2Fa.csv', 'downloads%2Fsub%2Fnotes.md']) {
      const res = await get(`/v/${secret}/${path}`, { accept: 'text/html' });
      expect(res.status, path).toBe(404);
    }
    // The bare folder and traversal shapes are 404 on the attachment route.
    for (const path of [
      'downloads/',
      'downloads/..%2Findex.html',
      'downloads/a%5Cb.csv',
      'downloads/nope.csv'
    ]) {
      expect((await get(`/v/${secret}/${path}`)).status, path).toBe(404);
    }
    // The deck's real pages are untouched by the exclusion.
    expect((await get(`/v/${secret}/index.html`)).status).toBe(200);
  });

  it('the zip streams the whole set of the resolved version, store-only, named after the deck and the version', async () => {
    const latest = await createToken({ name: 'Zip latest' });
    const res = await get(`/v/${latest.secret}/downloads.zip`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="quarterly-review-v2.zip"; filename*=UTF-8\'\'quarterly-review-v2.zip'
    );
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBe(VIEWER_CSP);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const zip = new AdmZip(Buffer.from(await res.arrayBuffer()));
    const entries = zip.getEntries();
    expect(entries.map((e) => e.entryName)).toEqual(V2_NAMES);
    expect(entries.every((e) => e.header.method === 0)).toBe(true); // stored, not deflated
    expect(zip.getEntry('b.pdf')!.getData().equals(PDF_B2)).toBe(true);
    expect(zip.getEntry('c.zip')!.getData().equals(ZIP_C)).toBe(true);
    expect(zip.getEntry('sub/notes.md')!.getData().equals(NOTES_MD)).toBe(true);

    const pinned = await createToken({ name: 'Zip pinned', versionMode: 'pinned', pinnedVersion: 1 });
    const pinnedRes = await get(`/v/${pinned.secret}/downloads.zip`);
    expect(pinnedRes.status).toBe(200);
    expect(pinnedRes.headers.get('content-disposition')).toContain('quarterly-review-v1.zip');
    const pinnedZip = new AdmZip(Buffer.from(await pinnedRes.arrayBuffer()));
    expect(pinnedZip.getEntries().map((e) => e.entryName)).toEqual(V1_NAMES);
    expect(pinnedZip.getEntry('b.pdf')!.getData().equals(PDF_B1)).toBe(true);

    const head = await get(`/v/${latest.secret}/downloads.zip`, {}, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-type')).toBe('application/zip');
    expect(await head.text()).toBe('');
  });

  it('downloads off: an empty list (200, never 403), 404 on the file and the zip, the deck still opens', async () => {
    const created = await createToken({ name: 'No downloads', canDownload: false });
    expect(created.shareToken.canDownload).toBe(false);
    const list = await get(`/api/v1/viewer/${created.secret}/attachments`);
    expect(list.status).toBe(200);
    expect(await readJson(list)).toEqual({ version: 2, attachments: [] });
    const file = await get(`/v/${created.secret}/downloads/a.csv`);
    expect(file.status).toBe(404);
    expect((await readJson(file)).error.code).toBe('not_found');
    expect((await get(`/v/${created.secret}/downloads.zip`)).status).toBe(404);
    expect((await get(`/v/${created.secret}/`)).status).toBe(200);

    // Switched back on through the owner PATCH.
    const patched = await app.app.request(`/api/v1/presentations/${deckId}/tokens/${created.shareToken.id}`, {
      ...json({ canDownload: true }, { cookie: ownerCookie }),
      method: 'PATCH'
    });
    expect(patched.status).toBe(200);
    expect((await readJson(patched)).canDownload).toBe(true);
    expect((await get(`/v/${created.secret}/downloads/a.csv`)).status).toBe(200);
    expect(
      (await readJson(await get(`/api/v1/viewer/${created.secret}/attachments`))).attachments
    ).toHaveLength(V2_NAMES.length);
  });

  it('downloads are on by default, and the link row says so', async () => {
    const created = await createToken({ name: 'Default' });
    expect(created.shareToken.canDownload).toBe(true);
    expect(created.shareToken.downloadCount).toBe(0);
    const listed = await readJson(
      await get(`/api/v1/presentations/${deckId}/tokens`, { cookie: ownerCookie })
    );
    const row = listed.shareTokens.find((t: { id: string }) => t.id === created.shareToken.id);
    expect(row.canDownload).toBe(true);
    expect(row.downloadCount).toBe(0);
  });

  it('a password-protected link needs the proof on the list, the files and the zip', async () => {
    const { secret } = await createToken({ name: 'Locked', password: 'open-sesame' });
    expect((await get(`/api/v1/viewer/${secret}/attachments`)).status).toBe(401);
    expect((await get(`/v/${secret}/downloads/a.csv`)).status).toBe(401);
    expect((await get(`/v/${secret}/downloads.zip`)).status).toBe(401);
    const proof = { 'x-viewer-password': 'open-sesame' };
    expect((await get(`/api/v1/viewer/${secret}/attachments`, proof)).status).toBe(200);
    expect((await get(`/v/${secret}/downloads/a.csv`, proof)).status).toBe(200);
    expect((await get(`/v/${secret}/downloads.zip`, proof)).status).toBe(200);
  });

  it('unknown → 404, revoked → 403, expired → 410 on every attachment route', async () => {
    const unknown = `/v/${'A'.repeat(64)}`;
    expect((await get(`${unknown}/downloads/a.csv`)).status).toBe(404);
    expect((await get(`${unknown}/downloads.zip`)).status).toBe(404);
    expect((await get(`/api/v1/viewer/${'A'.repeat(64)}/attachments`)).status).toBe(404);

    const revokable = await createToken({ name: 'Revoke me' });
    const revoke = await app.app.request(
      `/api/v1/presentations/${deckId}/tokens/${revokable.shareToken.id}`,
      {
        method: 'DELETE',
        headers: { cookie: ownerCookie }
      }
    );
    expect(revoke.status).toBe(200);
    expect((await get(`/v/${revokable.secret}/downloads/a.csv`)).status).toBe(403);
    expect((await get(`/v/${revokable.secret}/downloads.zip`)).status).toBe(403);
    expect((await get(`/api/v1/viewer/${revokable.secret}/attachments`)).status).toBe(403);

    const expired = await createToken({
      name: 'Expired',
      expiresAt: new Date(Date.now() - 60_000).toISOString()
    });
    expect((await get(`/v/${expired.secret}/downloads/a.csv`)).status).toBe(410);
    expect((await get(`/v/${expired.secret}/downloads.zip`)).status).toBe(410);
    expect((await get(`/api/v1/viewer/${expired.secret}/attachments`)).status).toBe(410);
  });

  it('the attachments list is CORS-open like its siblings (the sandboxed opaque origin calls it)', async () => {
    const { secret } = await createToken({ name: 'CORS' });
    const res = await get(`/api/v1/viewer/${secret}/attachments`, {
      origin: 'null',
      'sec-fetch-site': 'cross-site'
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

// ═══ Download events and the counter ═════════════════════════════════════════

describe('download events and the counter', () => {
  it('each file and each zip is one event and one increment; nothing is a view', async () => {
    const created = await createToken({ name: 'Counted' });
    const [{ totalViews: viewsBefore }] = await app.db.db
      .select({ totalViews: presentations.totalViews })
      .from(presentations)
      .where(eq(presentations.id, deckId));

    expect((await get(`/v/${created.secret}/downloads/a.csv`)).status).toBe(200);
    expect((await get(`/v/${created.secret}/downloads/sub/notes.md`)).status).toBe(200);
    expect((await get(`/v/${created.secret}/downloads.zip`)).status).toBe(200);
    // The same file again counts again: downloads are never de-duplicated.
    expect((await get(`/v/${created.secret}/downloads/a.csv`)).status).toBe(200);

    const rows = await downloadRows(created.shareToken.id);
    expect(rows.map((r) => r.name)).toEqual(['a.csv', 'sub/notes.md', null, 'a.csv']);
    expect(rows.every((r) => r.version === 2 && r.presentationId === deckId)).toBe(true);
    // The privacy posture is structural: no column could hold an IP, a
    // referrer or a user agent.
    expect(Object.keys(rows[0]!).sort()).toEqual(
      ['id', 'workspaceId', 'presentationId', 'shareTokenId', 'version', 'name', 'occurredAt'].sort()
    );
    const token = await tokenRow(created.shareToken.id);
    expect(token.downloadCount).toBe(4);
    expect(token.accessCount).toBe(0);
    expect(token.lastAccessedAt).toBeNull();
    const [{ totalViews: viewsAfter }] = await app.db.db
      .select({ totalViews: presentations.totalViews })
      .from(presentations)
      .where(eq(presentations.id, deckId));
    expect(viewsAfter).toBe(viewsBefore);

    // The count reaches the owner on the link row.
    const listed = await readJson(
      await get(`/api/v1/presentations/${deckId}/tokens`, { cookie: ownerCookie })
    );
    expect(listed.shareTokens.find((t: { id: string }) => t.id === created.shareToken.id).downloadCount).toBe(
      4
    );
  });

  it('HEAD, a 304 revalidation and an owner preview never count', async () => {
    const created = await createToken({ name: 'Uncounted' });
    expect((await get(`/v/${created.secret}/downloads/a.csv`, {}, { method: 'HEAD' })).status).toBe(200);
    expect((await get(`/v/${created.secret}/downloads.zip`, {}, { method: 'HEAD' })).status).toBe(200);
    expect(
      (await get(`/v/${created.secret}/downloads/a.csv`, { 'if-none-match': `"${shaOf(CSV_A)}"` })).status
    ).toBe(304);
    expect(await downloadRows(created.shareToken.id)).toHaveLength(0);
    expect((await tokenRow(created.shareToken.id)).downloadCount).toBe(0);

    const preview = await readJson(
      await app.app.request(
        `/api/v1/presentations/${deckId}/preview-token`,
        json({}, { cookie: ownerCookie })
      )
    );
    expect(preview.shareToken.canDownload).toBe(true);
    expect((await get(`/v/${preview.secret}/downloads/a.csv`)).status).toBe(200);
    expect((await get(`/v/${preview.secret}/downloads.zip`)).status).toBe(200);
    expect(await downloadRows(preview.shareToken.id)).toHaveLength(0);
    expect((await tokenRow(preview.shareToken.id)).downloadCount).toBe(0);
  });

  it('a refused download (downloads off) records nothing', async () => {
    const created = await createToken({ name: 'Off, uncounted', canDownload: false });
    expect((await get(`/v/${created.secret}/downloads/a.csv`)).status).toBe(404);
    expect((await get(`/v/${created.secret}/downloads.zip`)).status).toBe(404);
    expect(await downloadRows(created.shareToken.id)).toHaveLength(0);
    expect((await tokenRow(created.shareToken.id)).downloadCount).toBe(0);
  });

  it('token deletion keeps the rows (share_token_id nulled); the purge prunes by age, 0 keeps forever', async () => {
    const created = await createToken({ name: 'Retention' });
    expect((await get(`/v/${created.secret}/downloads/a.csv`)).status).toBe(200);
    expect((await get(`/v/${created.secret}/downloads/b.pdf`)).status).toBe(200);
    const rows = await downloadRows(created.shareToken.id);
    expect(rows).toHaveLength(2);
    await app.db.db
      .update(shareTokenDownloads)
      .set({ occurredAt: sql`now() - interval '91 days'` })
      .where(eq(shareTokenDownloads.id, rows[0]!.id));

    expect(await purgeShareTokenDownloads(app.db.db, 0)).toBe(0);
    expect(await downloadRows(created.shareToken.id)).toHaveLength(2);
    expect(await purgeShareTokenDownloads(app.db.db, 90)).toBe(1);
    const kept = await downloadRows(created.shareToken.id);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.id).toBe(rows[1]!.id);

    await app.db.db.delete(shareTokens).where(eq(shareTokens.id, created.shareToken.id));
    const [orphan] = await app.db.db
      .select()
      .from(shareTokenDownloads)
      .where(and(eq(shareTokenDownloads.id, rows[1]!.id)));
    expect(orphan).toBeDefined();
    expect(orphan!.shareTokenId).toBeNull();
    expect(orphan!.name).toBe('b.pdf');
  });
});

// ═══ The owner side ══════════════════════════════════════════════════════════

describe('the owner side: any version of a readable deck', () => {
  const base = () => `/api/v1/presentations/${deckId}/versions`;

  it('serves the zip and the files, attachment + nosniff, a nested name percent-encoded', async () => {
    const zip = await get(`${base()}/1/downloads.zip`, { cookie: ownerCookie });
    expect(zip.status).toBe(200);
    expect(zip.headers.get('content-type')).toBe('application/zip');
    expect(zip.headers.get('content-disposition')).toContain(
      'attachment; filename="quarterly-review-v1.zip"'
    );
    expect(zip.headers.get('x-content-type-options')).toBe('nosniff');
    const parsed = new AdmZip(Buffer.from(await zip.arrayBuffer()));
    expect(parsed.getEntries().map((e) => e.entryName)).toEqual(V1_NAMES);
    expect(parsed.getEntry('b.pdf')!.getData().equals(PDF_B1)).toBe(true);

    const csv = await get(`${base()}/2/downloads/a.csv`, { cookie: ownerCookie });
    expect(csv.status).toBe(200);
    expect(csv.headers.get('content-type')).toBe('text/csv');
    expect(csv.headers.get('content-disposition')).toBe(
      'attachment; filename="a.csv"; filename*=UTF-8\'\'a.csv'
    );
    expect(csv.headers.get('x-content-type-options')).toBe('nosniff');
    expect(csv.headers.get('etag')).toBe(`"${shaOf(CSV_A)}"`);
    expect(Buffer.from(await csv.arrayBuffer()).equals(CSV_A)).toBe(true);

    // A PDF renders inline on the asset route; here it is FORCED attachment.
    const pdf = await get(`${base()}/2/downloads/b.pdf`, { cookie: ownerCookie });
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get('content-disposition')).toContain('attachment; filename="b.pdf"');

    const nested = await get(`${base()}/2/downloads/sub%2Fnotes.md`, { cookie: ownerCookie });
    expect(nested.status).toBe(200);
    expect(nested.headers.get('content-disposition')).toContain('attachment; filename="notes.md"');
    expect(await nested.text()).toBe(NOTES_MD.toString());

    const head = await get(`${base()}/2/downloads/a.csv`, { cookie: ownerCookie }, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe(String(CSV_A.length));
    expect(await head.text()).toBe('');
  });

  it('unknown, traversal-shaped and literal-slash names answer 404; so does an unknown version', async () => {
    for (const name of ['nope.csv', '..%2Findex.html', 'a%5Cb.csv', 'sub%2F..%2Fa.csv']) {
      expect((await get(`${base()}/2/downloads/${name}`, { cookie: ownerCookie })).status, name).toBe(404);
    }
    // A literal slash is not the route's contract (the name is one segment).
    expect((await get(`${base()}/2/downloads/sub/notes.md`, { cookie: ownerCookie })).status).toBe(404);
    expect((await get(`${base()}/99/downloads.zip`, { cookie: ownerCookie })).status).toBe(404);
    expect((await get(`${base()}/99/downloads/a.csv`, { cookie: ownerCookie })).status).toBe(404);
  });

  it('a plain member answers 404 on both (never 403); a read key succeeds; a write-only key is refused', async () => {
    const memberZip = await get(`${base()}/2/downloads.zip`, { cookie: memberCookie });
    expect(memberZip.status).toBe(404);
    expect((await readJson(memberZip)).error.code).toBe('not_found');
    expect((await get(`${base()}/2/downloads/a.csv`, { cookie: memberCookie })).status).toBe(404);

    const keyZip = await get(`${base()}/2/downloads.zip`, { authorization: `Bearer ${readKey}` });
    expect(keyZip.status).toBe(200);
    const keyFile = await get(`${base()}/2/downloads/a.csv`, { authorization: `Bearer ${readKey}` });
    expect(keyFile.status).toBe(200);

    expect((await get(`${base()}/2/downloads.zip`, { authorization: `Bearer ${writeOnlyKey}` })).status).toBe(
      403
    );
    expect(
      (await get(`${base()}/2/downloads/a.csv`, { authorization: `Bearer ${writeOnlyKey}` })).status
    ).toBe(403);
  });
});
