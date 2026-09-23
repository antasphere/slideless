import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import {
  createDatabase,
  createTestApp,
  extractCookie,
  readJson,
  startPostgres,
  type TestApp
} from './helpers.js';

/** An HTML Accept: the deck, not the agent index (PRDCT-2670). */
const DOC_NAV = { accept: 'text/html' };

/**
 * Per-version views and downloads on the version list (PRDCT-2308): the
 * deck page's version popover reads, beside each version, how many times a
 * recipient was served THAT version and how many attachments were taken
 * from it. Both come from the link-analytics event tables grouped by
 * version — so a link following the latest counts on the version it
 * resolved to at the time, a pinned link on its pin, an owner preview
 * nowhere, and a purged event no longer. The two (presentation, version)
 * indexes of migration 0041 back the query.
 */

const OWNER = { email: 'owner@counts.test', name: 'Counts Owner', password: 'counts-owner-pass-1' };
const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const HTML_V1 = Buffer.from('<!doctype html><html><body><h1>Counts v1</h1></body></html>');
const HTML_V2 = Buffer.from('<!doctype html><html><body><h1>Counts v2</h1></body></html>');
const CSV = Buffer.from('quarter,revenue\nQ3,42\n');

const shaOf = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const entryOf = (path: string, bytes: Buffer, contentType: string) => ({
  path,
  sha256: shaOf(bytes),
  sizeBytes: bytes.length,
  contentType
});

let container: StartedPostgreSqlContainer;
let app: TestApp;
let ownerCookie: string;
let deckId: string;
/** A second deck in the same workspace: its events must never count on the first. */
let otherDeckId: string;

let ipCounter = 0;
const nextIp = () => `10.99.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp(), ...headers },
  body: JSON.stringify(body)
});

/** A recipient's browser navigation: counted as a view, one event on the served version. */
const open = (secret: string) =>
  app.app.request(`/v/${secret}/`, {
    headers: {
      ...DOC_NAV,
      'user-agent': CHROME_UA,
      'x-forwarded-for': nextIp(),
      'sec-fetch-dest': 'document'
    }
  });

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

async function listVersions(
  id: string = deckId
): Promise<Array<{ version: number; viewCount: number; downloadCount: number; fileCount: number }>> {
  const res = await app.app.request(`/api/v1/presentations/${id}/versions`, {
    headers: { cookie: ownerCookie, 'x-forwarded-for': nextIp() }
  });
  expect(res.status).toBe(200);
  return (await readJson(res)).versions;
}

async function mintLink(
  body: Record<string, unknown>,
  id: string = deckId
): Promise<{ secret: string; id: string }> {
  const res = await app.app.request(
    `/api/v1/presentations/${id}/tokens`,
    json(body, { cookie: ownerCookie })
  );
  expect(res.status).toBe(201);
  const created = await readJson(res);
  return { secret: created.secret as string, id: created.shareToken.id as string };
}

beforeAll(async () => {
  container = await startPostgres();
  app = await createTestApp(await createDatabase(container, 'version_counts'));
  await app.app.request(
    '/api/v1/setup',
    json({ setupToken: 'integration-test-setup-token', instanceName: 'Counts', owner: OWNER })
  );
  ownerCookie = extractCookie(
    await app.app.request(
      '/api/v1/auth/sign-in/email',
      json({ email: OWNER.email, password: OWNER.password })
    )
  );
  await uploadAsset(HTML_V1, 'text/html', 'index.html');
  await uploadAsset(HTML_V2, 'text/html', 'index.html');
  await uploadAsset(CSV, 'text/csv', 'figures.csv');

  const reserve = await readJson(
    await app.app.request('/api/v1/presentations/uploads', {
      method: 'POST',
      headers: { cookie: ownerCookie }
    })
  );
  const commit = await app.app.request(
    `/api/v1/presentations/uploads/${reserve.uploadSession.id}/commit`,
    json(
      {
        title: 'Counts',
        entryPath: 'index.html',
        manifest: [
          entryOf('index.html', HTML_V1, 'text/html'),
          entryOf('downloads/figures.csv', CSV, 'text/csv')
        ]
      },
      { cookie: ownerCookie }
    )
  );
  expect(commit.status).toBe(201);
  deckId = (await readJson(commit)).presentation.id;
  const v2 = await app.app.request(
    `/api/v1/presentations/${deckId}/versions`,
    json(
      {
        expectedBaseVersion: 1,
        entryPath: 'index.html',
        manifest: [
          entryOf('index.html', HTML_V2, 'text/html'),
          entryOf('downloads/figures.csv', CSV, 'text/csv')
        ]
      },
      { cookie: ownerCookie }
    )
  );
  expect(v2.status).toBe(201);

  // The second deck: one version, its own link, its own views.
  const reserve2 = await readJson(
    await app.app.request('/api/v1/presentations/uploads', {
      method: 'POST',
      headers: { cookie: ownerCookie }
    })
  );
  const commit2 = await app.app.request(
    `/api/v1/presentations/uploads/${reserve2.uploadSession.id}/commit`,
    json(
      {
        title: 'Other deck',
        entryPath: 'index.html',
        manifest: [
          entryOf('index.html', HTML_V1, 'text/html'),
          entryOf('downloads/figures.csv', CSV, 'text/csv')
        ]
      },
      { cookie: ownerCookie }
    )
  );
  expect(commit2.status).toBe(201);
  otherDeckId = (await readJson(commit2)).presentation.id;
}, 120_000);

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

describe('per-version views and downloads on the version list', () => {
  it('starts at zero on every version, newest first, and the counts are on the wire shape', async () => {
    const versions = await listVersions();
    expect(versions.map((v) => v.version)).toEqual([2, 1]);
    for (const v of versions) {
      expect(v.viewCount).toBe(0);
      expect(v.downloadCount).toBe(0);
    }
  });

  it('a latest link counts on the version it served, a pinned link on its pin, a download on its version', async () => {
    const latest = await mintLink({ name: 'follows' });
    const pinned = await mintLink({ name: 'pinned to v1', versionMode: 'pinned', pinnedVersion: 1 });
    // The other deck's version 1 takes five views and a download of its own
    // first: they must never appear on this deck's version 1 (verifier
    // round 1, G2 — the counts are scoped by deck, not by version number).
    const other = await mintLink({ name: 'other' }, otherDeckId);
    for (let i = 0; i < 5; i++) expect((await open(other.secret)).status).toBe(200);
    expect(
      (
        await app.app.request(`/v/${other.secret}/downloads/figures.csv`, {
          headers: { 'x-forwarded-for': nextIp() }
        })
      ).status
    ).toBe(200);

    expect((await open(latest.secret)).status).toBe(200);
    expect((await open(latest.secret)).status).toBe(200);
    expect((await open(pinned.secret)).status).toBe(200);
    const taken = await app.app.request(`/v/${latest.secret}/downloads/figures.csv`, {
      headers: { 'x-forwarded-for': nextIp() }
    });
    expect(taken.status).toBe(200);

    const versions = await listVersions();
    expect(versions.find((v) => v.version === 2)).toMatchObject({ viewCount: 2, downloadCount: 1 });
    expect(versions.find((v) => v.version === 1)).toMatchObject({ viewCount: 1, downloadCount: 0 });
    expect(await listVersions(otherDeckId)).toMatchObject([{ version: 1, viewCount: 5, downloadCount: 1 }]);
  });

  it('an owner preview never counts: the preview token writes no event', async () => {
    const before = await listVersions();
    const res = await app.app.request(
      `/api/v1/presentations/${deckId}/preview-token`,
      json({ version: 1 }, { cookie: ownerCookie })
    );
    expect(res.status).toBe(201);
    const preview = await readJson(res);
    expect((await open(preview.secret)).status).toBe(200);
    expect(await listVersions()).toEqual(before);
  });

  it('a purged event stops counting, while the deck keeps its lifetime views', async () => {
    const before = await listVersions();
    const deckBefore = await readJson(
      await app.app.request(`/api/v1/presentations/${deckId}`, {
        headers: { cookie: ownerCookie, 'x-forwarded-for': nextIp() }
      })
    );
    expect(before.find((v) => v.version === 1)!.viewCount).toBe(1);
    // Age the v1 view past any retention, then run the retention purge as the
    // nightly job does (1 day keeps everything younger than a day).
    await app.db.db.execute(
      sql`UPDATE share_token_views SET occurred_at = now() - interval '400 days' WHERE version = 1 AND presentation_id = ${deckId}`
    );
    const { purgeShareTokenViews } = await import('../../src/sharing/view-events.js');
    expect(await purgeShareTokenViews(app.db.db, 1)).toBe(1);
    const after = await listVersions();
    expect(after.find((v) => v.version === 1)!.viewCount).toBe(0);
    expect(after.find((v) => v.version === 2)!.viewCount).toBe(2);
    // The other deck's events were younger and stay counted.
    expect((await listVersions(otherDeckId))[0]!.viewCount).toBe(5);
    const deckAfter = await readJson(
      await app.app.request(`/api/v1/presentations/${deckId}`, {
        headers: { cookie: ownerCookie, 'x-forwarded-for': nextIp() }
      })
    );
    expect(deckAfter.totalViews).toBe(deckBefore.totalViews);
  });

  it('the two (presentation, version) indexes exist on both event tables', async () => {
    const rows = await app.db.db.execute(
      sql`SELECT indexname FROM pg_indexes WHERE indexname IN ('share_token_views_presentation_version_idx', 'share_token_downloads_presentation_version_idx') ORDER BY indexname`
    );
    expect(rows.rows.map((r) => r['indexname'])).toEqual([
      'share_token_downloads_presentation_version_idx',
      'share_token_views_presentation_version_idx'
    ]);
  });
});
