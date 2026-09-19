import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { and, eq, sql } from 'drizzle-orm';
import { files } from '@antasphere/chassis-db';
import { uploadSessions } from '@slideless/db';
import { purgeExpiredUploadSessions } from '../../src/jobs/pgboss.js';
import {
  createDatabase,
  createTestApp,
  extractCookie,
  readJson,
  startPostgres,
  type TestApp
} from './helpers.js';

/**
 * Phase 3 — the upload + versioning pipeline end-to-end (ADR 011):
 * reserve → precheck → multipart asset push → transactional commit, then the
 * pull path (version listings without manifests, manifest detail, streamed
 * content-addressed asset download), content-addressed dedupe across decks,
 * optimistic-concurrency 409s, session one-shot/expiry semantics, version
 * immutability, the DELETE /files blob guard, and the session purge job.
 */

const OWNER = { email: 'owner@upload.test', name: 'Upload Owner', password: 'upload-owner-password-1' };

// A real 1x1 PNG — the binary asset of the round-trip.
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const HTML_A = Buffer.from('<!doctype html><html><body><h1>Deck A</h1></body></html>');
const HTML_A2 = Buffer.from('<!doctype html><html><body><h1>Deck A, take two</h1></body></html>');
const HTML_B = Buffer.from('<!doctype html><html><body><h1>Deck B</h1></body></html>');

const shaOf = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const SHA_PNG = shaOf(PNG_BYTES);
const SHA_HTML_A = shaOf(HTML_A);
const SHA_HTML_A2 = shaOf(HTML_A2);
const SHA_HTML_B = shaOf(HTML_B);

const entry = (path: string, bytes: Buffer, contentType: string) => ({
  path,
  sha256: shaOf(bytes),
  sizeBytes: bytes.length,
  contentType
});

let container: StartedPostgreSqlContainer;
let app: TestApp;
let cookie: string;

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body)
});

async function reserve(): Promise<{ id: string; presentationId: string }> {
  const res = await app.app.request('/api/v1/presentations/uploads', {
    method: 'POST',
    headers: { cookie }
  });
  expect(res.status).toBe(201);
  return (await readJson(res)).uploadSession;
}

async function precheck(shas: string[]): Promise<string[]> {
  const res = await app.app.request('/api/v1/presentations/precheck', json({ sha256: shas }, { cookie }));
  expect(res.status).toBe(200);
  return (await readJson(res)).missing;
}

async function uploadAsset(
  bytes: Buffer,
  declaredSha: string,
  contentType: string,
  name: string
): Promise<Response> {
  const form = new FormData();
  form.set('sha256', declaredSha);
  form.set('file', new Blob([new Uint8Array(bytes)], { type: contentType }), name);
  return app.app.request('/api/v1/presentations/assets', {
    method: 'POST',
    headers: { cookie },
    body: form
  });
}

beforeAll(async () => {
  container = await startPostgres();
  app = await createTestApp(await createDatabase(container, 'presentations_phase3'));
  await app.app.request(
    '/api/v1/setup',
    json({ setupToken: 'integration-test-setup-token', instanceName: 'Uploads', owner: OWNER })
  );
  const signIn = await app.app.request(
    '/api/v1/auth/sign-in/email',
    json({ email: OWNER.email, password: OWNER.password })
  );
  cookie = extractCookie(signIn);
});

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

describe('push protocol (reserve → precheck → upload → commit)', () => {
  let deckAId: string;
  let sessionAId: string;

  it('walks a multi-file deck (HTML entry + binary PNG) through the full push', async () => {
    const session = await reserve();
    sessionAId = session.id;
    deckAId = session.presentationId;

    // Everything missing on a fresh workspace.
    expect(await precheck([SHA_HTML_A, SHA_PNG])).toEqual(expect.arrayContaining([SHA_HTML_A, SHA_PNG]));

    const pngRes = await uploadAsset(PNG_BYTES, SHA_PNG, 'image/png', 'logo.png');
    expect(pngRes.status).toBe(201);
    const pngBody = await readJson(pngRes);
    expect(pngBody).toMatchObject({ sha256: SHA_PNG, sizeBytes: PNG_BYTES.length, deduplicated: false });

    const htmlRes = await uploadAsset(HTML_A, SHA_HTML_A, 'text/html', 'index.html');
    expect(htmlRes.status).toBe(201);

    // Nothing missing anymore.
    expect(await precheck([SHA_HTML_A, SHA_PNG])).toEqual([]);

    const commit = await app.app.request(
      `/api/v1/presentations/uploads/${sessionAId}/commit`,
      json(
        {
          title: 'Deck A',
          kind: 'presentation',
          interactive: false,
          entryPath: 'index.html',
          manifest: [
            entry('index.html', HTML_A, 'text/html'),
            entry('assets/logo.png', PNG_BYTES, 'image/png')
          ]
        },
        { cookie }
      )
    );
    expect(commit.status).toBe(201);
    const body = await readJson(commit);
    expect(body.presentation).toMatchObject({
      id: deckAId,
      title: 'Deck A',
      currentVersion: 1,
      entryPath: 'index.html'
    });
    expect(body.version).toMatchObject({
      presentationId: deckAId,
      version: 1,
      fileCount: 2,
      sizeBytes: HTML_A.length + PNG_BYTES.length,
      createdByRole: 'owner'
    });
  });

  it('a consumed session is one-shot (second commit 409s)', async () => {
    const res = await app.app.request(
      `/api/v1/presentations/uploads/${sessionAId}/commit`,
      json(
        {
          title: 'Deck A again',
          entryPath: 'index.html',
          manifest: [entry('index.html', HTML_A, 'text/html')]
        },
        { cookie }
      )
    );
    expect(res.status).toBe(409);
    expect((await readJson(res)).error.code).toBe('session_consumed');
  });

  it('lists the deck and serves metadata + versions (list has NO manifest — ADR 011)', async () => {
    const list = await readJson(await app.app.request('/api/v1/presentations', { headers: { cookie } }));
    expect(list.presentations.map((p: { id: string }) => p.id)).toContain(deckAId);

    const deck = await readJson(
      await app.app.request(`/api/v1/presentations/${deckAId}`, { headers: { cookie } })
    );
    expect(deck).toMatchObject({ id: deckAId, title: 'Deck A', currentVersion: 1 });

    const versions = await readJson(
      await app.app.request(`/api/v1/presentations/${deckAId}/versions`, { headers: { cookie } })
    );
    expect(versions.versions).toHaveLength(1);
    expect(versions.versions[0].version).toBe(1);
    expect(versions.versions[0].manifest).toBeUndefined();

    const detail = await readJson(
      await app.app.request(`/api/v1/presentations/${deckAId}/versions/1`, { headers: { cookie } })
    );
    expect(detail.manifest).toHaveLength(2);
    expect(detail.manifest).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'assets/logo.png', sha256: SHA_PNG })])
    );
  });

  it('pulls an asset back byte-identical, with ETag/304/Range and safe-serving headers', async () => {
    const res = await app.app.request(`/api/v1/presentations/${deckAId}/assets/${SHA_PNG}`, {
      headers: { cookie }
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBe(`"${SHA_PNG}"`);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-disposition')).toContain('inline'); // passive media
    const pulled = Buffer.from(await res.arrayBuffer());
    expect(pulled.equals(PNG_BYTES)).toBe(true);

    // Active content never renders inline on the app origin.
    const html = await app.app.request(`/api/v1/presentations/${deckAId}/assets/${SHA_HTML_A}`, {
      headers: { cookie }
    });
    expect(html.status).toBe(200);
    expect(html.headers.get('content-disposition')).toContain('attachment');

    const cached = await app.app.request(`/api/v1/presentations/${deckAId}/assets/${SHA_PNG}`, {
      headers: { cookie, 'if-none-match': `"${SHA_PNG}"` }
    });
    expect(cached.status).toBe(304);

    const partial = await app.app.request(`/api/v1/presentations/${deckAId}/assets/${SHA_PNG}`, {
      headers: { cookie, range: 'bytes=0-3' }
    });
    expect(partial.status).toBe(206);
    expect(partial.headers.get('content-range')).toBe(`bytes 0-3/${PNG_BYTES.length}`);
    const head = Buffer.from(await partial.arrayBuffer());
    expect(head.equals(PNG_BYTES.subarray(0, 4))).toBe(true);
    expect(head.toString('latin1')).toContain('PNG');
  });

  it('dedupes across decks: a second deck reusing the PNG uploads 0 new blobs', async () => {
    const session = await reserve();

    // Only the new HTML is missing — the PNG blob already lives here.
    expect(await precheck([SHA_PNG, SHA_HTML_B])).toEqual([SHA_HTML_B]);

    expect((await uploadAsset(HTML_B, SHA_HTML_B, 'text/html', 'index.html')).status).toBe(201);

    const commit = await app.app.request(
      `/api/v1/presentations/uploads/${session.id}/commit`,
      json(
        {
          title: 'Deck B',
          entryPath: 'index.html',
          manifest: [entry('index.html', HTML_B, 'text/html'), entry('logo.png', PNG_BYTES, 'image/png')]
        },
        { cookie }
      )
    );
    expect(commit.status).toBe(201);

    // Exactly ONE files row (and one blob) per (workspace, sha) — by query.
    const rows = await app.db.db.select({ id: files.id }).from(files).where(eq(files.sha256, SHA_PNG));
    expect(rows).toHaveLength(1);

    // Cross-deck isolation: deck A never referenced HTML_B, so its id is not
    // a handle to that blob.
    const foreign = await app.app.request(`/api/v1/presentations/${deckAId}/assets/${SHA_HTML_B}`, {
      headers: { cookie }
    });
    expect(foreign.status).toBe(404);
  });

  it('re-uploading identical bytes answers deduplicated: true', async () => {
    const res = await uploadAsset(PNG_BYTES, SHA_PNG, 'image/png', 'logo.png');
    expect(res.status).toBe(201);
    expect((await readJson(res)).deduplicated).toBe(true);
  });
});

describe('commit validation', () => {
  it('rejects a manifest referencing missing blobs (400, session NOT consumed) and succeeds after upload', async () => {
    const session = await reserve();
    const manifest = [entry('index.html', HTML_A2, 'text/html')];

    const first = await app.app.request(
      `/api/v1/presentations/uploads/${session.id}/commit`,
      json({ title: 'Deck C', entryPath: 'index.html', manifest }, { cookie })
    );
    expect(first.status).toBe(400);
    const body = await readJson(first);
    expect(body.error.code).toBe('missing_blobs');
    expect(body.error.details.missing).toEqual([SHA_HTML_A2]);

    // The failed commit did not consume the session: upload and retry.
    expect((await uploadAsset(HTML_A2, SHA_HTML_A2, 'text/html', 'index.html')).status).toBe(201);
    const second = await app.app.request(
      `/api/v1/presentations/uploads/${session.id}/commit`,
      json({ title: 'Deck C', entryPath: 'index.html', manifest }, { cookie })
    );
    expect(second.status).toBe(201);
  });

  it('rejects a hash mismatch without storing anything', async () => {
    const bytes = Buffer.from('not the bytes the sha claims');
    const res = await uploadAsset(
      bytes,
      SHA_PNG.replace(/^./, SHA_PNG.startsWith('0') ? '1' : '0'),
      'text/plain',
      'x.txt'
    );
    expect(res.status).toBe(400);
    expect((await readJson(res)).error.code).toBe('sha256_mismatch');
    expect(await precheck([shaOf(bytes)])).toEqual([shaOf(bytes)]); // nothing minted
  });

  it('stamps the authoritative blob size onto the version + manifest, ignoring a lied sizeBytes', async () => {
    const bytes = Buffer.from('hello'); // real size 5, not the 999_999 the client will claim
    const sha = shaOf(bytes);
    const session = await reserve();
    expect((await uploadAsset(bytes, sha, 'text/html', 'index.html')).status).toBe(201);

    const commit = await app.app.request(
      `/api/v1/presentations/uploads/${session.id}/commit`,
      json(
        {
          title: 'Size Lie',
          entryPath: 'index.html',
          manifest: [{ path: 'index.html', sha256: sha, sizeBytes: 999_999, contentType: 'text/html' }]
        },
        { cookie }
      )
    );
    expect(commit.status).toBe(201);
    expect((await readJson(commit)).version.sizeBytes).toBe(bytes.length);

    // Persisted totals AND the per-entry manifest size are the real blob size,
    // never the client's claim (size is a pure function of the addressed bytes).
    const detail = await readJson(
      await app.app.request(`/api/v1/presentations/${session.presentationId}/versions/1`, {
        headers: { cookie }
      })
    );
    expect(detail.sizeBytes).toBe(bytes.length);
    expect(detail.manifest[0].sizeBytes).toBe(bytes.length);
  });

  it('rejects an entryPath outside the manifest and duplicate manifest paths', async () => {
    const session = await reserve();
    const badEntry = await app.app.request(
      `/api/v1/presentations/uploads/${session.id}/commit`,
      json(
        {
          title: 'Bad',
          entryPath: 'missing.html',
          manifest: [entry('index.html', HTML_A, 'text/html')]
        },
        { cookie }
      )
    );
    expect(badEntry.status).toBe(400);
    expect((await readJson(badEntry)).error.code).toBe('invalid_manifest');

    const dup = await app.app.request(
      `/api/v1/presentations/uploads/${session.id}/commit`,
      json(
        {
          title: 'Bad',
          entryPath: 'index.html',
          manifest: [entry('index.html', HTML_A, 'text/html'), entry('index.html', HTML_B, 'text/html')]
        },
        { cookie }
      )
    );
    expect(dup.status).toBe(400);
    expect((await readJson(dup)).error.code).toBe('invalid_manifest');
  });

  it('answers 410 on an expired session and 404 on an unknown one', async () => {
    const session = await reserve();
    await app.db.db
      .update(uploadSessions)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(uploadSessions.id, session.id));
    const expired = await app.app.request(
      `/api/v1/presentations/uploads/${session.id}/commit`,
      json(
        { title: 'X', entryPath: 'index.html', manifest: [entry('index.html', HTML_A, 'text/html')] },
        { cookie }
      )
    );
    expect(expired.status).toBe(410);
    expect((await readJson(expired)).error.code).toBe('session_expired');

    const unknown = await app.app.request(
      `/api/v1/presentations/uploads/${crypto.randomUUID()}/commit`,
      json(
        { title: 'X', entryPath: 'index.html', manifest: [entry('index.html', HTML_A, 'text/html')] },
        { cookie }
      )
    );
    expect(unknown.status).toBe(404);
  });
});

describe('versioning (optimistic concurrency + immutability)', () => {
  let deckId: string;

  beforeAll(async () => {
    const session = await reserve();
    deckId = session.presentationId;
    const commit = await app.app.request(
      `/api/v1/presentations/uploads/${session.id}/commit`,
      json(
        { title: 'Versioned', entryPath: 'index.html', manifest: [entry('index.html', HTML_A, 'text/html')] },
        { cookie }
      )
    );
    expect(commit.status).toBe(201);
  });

  it('commits version 2 with expectedBaseVersion 1 (counter, entry path, title advance atomically)', async () => {
    const res = await app.app.request(
      `/api/v1/presentations/${deckId}/versions`,
      json(
        {
          expectedBaseVersion: 1,
          entryPath: 'main.html',
          title: 'Versioned v2',
          manifest: [
            entry('main.html', HTML_A2, 'text/html'),
            entry('assets/logo.png', PNG_BYTES, 'image/png')
          ]
        },
        { cookie }
      )
    );
    expect(res.status).toBe(201);
    const body = await readJson(res);
    expect(body.presentation).toMatchObject({
      id: deckId,
      currentVersion: 2,
      entryPath: 'main.html',
      title: 'Versioned v2'
    });
    expect(body.version).toMatchObject({ version: 2, fileCount: 2 });
  });

  it('409s a stale expectedBaseVersion (version_conflict, with the live counter)', async () => {
    const res = await app.app.request(
      `/api/v1/presentations/${deckId}/versions`,
      json(
        {
          expectedBaseVersion: 1,
          entryPath: 'index.html',
          manifest: [entry('index.html', HTML_A, 'text/html')]
        },
        { cookie }
      )
    );
    expect(res.status).toBe(409);
    const body = await readJson(res);
    expect(body.error.code).toBe('version_conflict');
    expect(body.error.details.currentVersion).toBe(2);
  });

  it('keeps committed versions immutable: version 1 is untouched by later commits', async () => {
    const v1 = await readJson(
      await app.app.request(`/api/v1/presentations/${deckId}/versions/1`, { headers: { cookie } })
    );
    expect(v1).toMatchObject({ version: 1, entryPath: 'index.html', fileCount: 1 });
    expect(v1.manifest).toEqual([entry('index.html', HTML_A, 'text/html')]);

    const list = await readJson(
      await app.app.request(`/api/v1/presentations/${deckId}/versions`, { headers: { cookie } })
    );
    expect(list.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
  });

  it('404s a version commit against an unknown deck', async () => {
    const res = await app.app.request(
      `/api/v1/presentations/${crypto.randomUUID()}/versions`,
      json(
        {
          expectedBaseVersion: 0,
          entryPath: 'index.html',
          manifest: [entry('index.html', HTML_A, 'text/html')]
        },
        { cookie }
      )
    );
    expect(res.status).toBe(404);
  });
});

describe('blob-delete guard (ADR 011) + soft delete', () => {
  it('refuses the generic DELETE /files/{id} while any live deck references the blob', async () => {
    const [pngRow] = await app.db.db.select().from(files).where(eq(files.sha256, SHA_PNG));
    expect(pngRow).toBeDefined();

    const denied = await app.app.request(`/api/v1/files/${pngRow!.id}`, {
      method: 'DELETE',
      headers: { cookie }
    });
    expect(denied.status).toBe(409);
    expect((await readJson(denied)).error.code).toBe('file_in_use');

    // Still intact and pullable.
    const [stillThere] = await app.db.db
      .select()
      .from(files)
      .where(and(eq(files.sha256, SHA_PNG), sql`deleted_at IS NULL`));
    expect(stillThere).toBeDefined();
  });

  it('allows the delete once every referencing deck is soft-deleted', async () => {
    // Delete ALL decks (A, B, C, Versioned) — the guard only counts live ones.
    const list = await readJson(await app.app.request('/api/v1/presentations', { headers: { cookie } }));
    for (const deck of list.presentations) {
      const res = await app.app.request(`/api/v1/presentations/${deck.id}`, {
        method: 'DELETE',
        headers: { cookie }
      });
      expect(res.status).toBe(200);
    }

    // Soft-deleted decks stop resolving everywhere.
    const gone = await app.app.request(`/api/v1/presentations/${list.presentations[0].id}`, {
      headers: { cookie }
    });
    expect(gone.status).toBe(404);
    const emptied = await readJson(await app.app.request('/api/v1/presentations', { headers: { cookie } }));
    expect(emptied.presentations).toEqual([]);

    const [pngRow] = await app.db.db.select().from(files).where(eq(files.sha256, SHA_PNG));
    const allowed = await app.app.request(`/api/v1/files/${pngRow!.id}`, {
      method: 'DELETE',
      headers: { cookie }
    });
    expect(allowed.status).toBe(200);
  });
});

describe('upload-session purge job', () => {
  it('deletes expired sessions and keeps live ones', async () => {
    const live = await reserve();
    const dead = await reserve();
    await app.db.db
      .update(uploadSessions)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(uploadSessions.id, dead.id));

    const deleted = await purgeExpiredUploadSessions(app.db.db);
    expect(deleted).toBeGreaterThanOrEqual(1);

    const remaining = await app.db.db.select({ id: uploadSessions.id }).from(uploadSessions);
    const ids = remaining.map((r) => r.id);
    expect(ids).toContain(live.id);
    expect(ids).not.toContain(dead.id);
  });
});
