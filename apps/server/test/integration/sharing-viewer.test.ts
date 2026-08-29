import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { PREVIEW_SHARE_TOKEN_NAME } from '@slideless/contract';
import { presentations } from '@slideless/db';
import { OVERLAY_MARKER } from '../../src/viewer/overlay.js';
import { VIEWER_CSP } from '../../src/viewer/routes.js';
import { mintViewedValue } from '../../src/viewer/viewed.js';
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
 * Phase 4 — sharing + the public viewer (ADR 012), end-to-end:
 *
 *  - the share-token management API (create/list/patch/revoke/send), owner-
 *    gated, hash-only storage, secret shown once;
 *  - the anonymous viewer: entry HTML inline UNDER `CSP: sandbox` (the
 *    security regression tests live here), asset streaming with Range/ETag,
 *    revoked→403 / expired→410 / unknown→404, pinned-vs-latest versioning,
 *    entry-only view counting, the password gate (browser form + agent
 *    header), and share-via-email through the recording driver.
 */

const OWNER = { email: 'owner@share.test', name: 'Share Owner', password: 'share-owner-password-1' };

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const HTML_V1 = Buffer.from('<!doctype html><html><body><h1>Deck v1 marker</h1></body></html>');
const HTML_V2 = Buffer.from('<!doctype html><html><body><h1>Deck v2 marker</h1></body></html>');
const HTML_SUBPAGE = Buffer.from('<!doctype html><html><body><h1>Subpage marker</h1></body></html>');

const shaOf = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

const entryOf = (path: string, bytes: Buffer, contentType: string) => ({
  path,
  sha256: shaOf(bytes),
  sizeBytes: bytes.length,
  contentType
});

let container: StartedPostgreSqlContainer;
let app: TestApp;
let mail: RecordingEmailDriver;
let cookie: string;
let deckId: string;

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body)
});

/** EVERY response carrying user bytes must wear the exact ADR 012 set. */
function expectViewerContentHeaders(res: Response): void {
  const csp = res.headers.get('content-security-policy') ?? '';
  expect(csp).toBe(VIEWER_CSP);
  expect(csp).toContain('sandbox');
  expect(csp).not.toContain('allow-same-origin');
  expect(csp).not.toContain('allow-top-navigation');
  // Framing policy (ADR 021): deck bytes are deliberately frameable — the
  // official embeds depend on this. The sandbox is the boundary, not
  // frame-ancestors / X-Frame-Options.
  expect(csp).not.toContain('frame-ancestors');
  expect(res.headers.get('x-frame-options')).toBeNull();
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  expect(res.headers.get('referrer-policy')).toBe('no-referrer');
}

async function uploadAsset(bytes: Buffer, contentType: string, name: string): Promise<void> {
  const form = new FormData();
  form.set('sha256', shaOf(bytes));
  form.set('file', new Blob([new Uint8Array(bytes)], { type: contentType }), name);
  const res = await app.app.request('/api/v1/presentations/assets', {
    method: 'POST',
    headers: { cookie },
    body: form
  });
  expect(res.status).toBe(201);
}

async function createToken(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const res = await app.app.request(
    `/api/v1/presentations/${deckId}/tokens`,
    json(body, { cookie, ...headers })
  );
  expect(res.status).toBe(201);
  return readJson(res);
}

async function listTokens() {
  const res = await app.app.request(`/api/v1/presentations/${deckId}/tokens`, { headers: { cookie } });
  expect(res.status).toBe(200);
  return readJson(res);
}

async function totalViewsOf(id: string): Promise<{ totalViews: number; lastViewedAt: Date | null }> {
  const [row] = await app.db.db
    .select({ totalViews: presentations.totalViews, lastViewedAt: presentations.lastViewedAt })
    .from(presentations)
    .where(eq(presentations.id, id));
  return row!;
}

beforeAll(async () => {
  container = await startPostgres();
  mail = new RecordingEmailDriver();
  app = await createTestApp(await createDatabase(container, 'sharing_viewer'), {}, { email: mail });
  await app.app.request(
    '/api/v1/setup',
    json({ setupToken: 'integration-test-setup-token', instanceName: 'Sharing', owner: OWNER })
  );
  const signIn = await app.app.request(
    '/api/v1/auth/sign-in/email',
    json({ email: OWNER.email, password: OWNER.password })
  );
  cookie = extractCookie(signIn);

  // Author deck v1: HTML entry + a PNG + an HTML subpage (nested path).
  const reserve = await readJson(
    await app.app.request('/api/v1/presentations/uploads', { method: 'POST', headers: { cookie } })
  );
  deckId = reserve.uploadSession.presentationId;
  await uploadAsset(HTML_V1, 'text/html', 'index.html');
  await uploadAsset(PNG_BYTES, 'image/png', 'logo.png');
  await uploadAsset(HTML_SUBPAGE, 'text/html', 'pages/two.html');
  const commit = await app.app.request(
    `/api/v1/presentations/uploads/${reserve.uploadSession.id}/commit`,
    json(
      {
        title: 'Shared Deck',
        entryPath: 'index.html',
        manifest: [
          entryOf('index.html', HTML_V1, 'text/html'),
          entryOf('assets/logo.png', PNG_BYTES, 'image/png'),
          entryOf('pages/two.html', HTML_SUBPAGE, 'text/html')
        ]
      },
      { cookie }
    )
  );
  expect(commit.status).toBe(201);
}, 120_000);

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

// ═══ Token management API ════════════════════════════════════════════════════

describe('share-token management API', () => {
  it('creates a token: 64-char base64url secret + viewer URL, shown exactly once', async () => {
    const created = await createToken({ name: 'Alice' });
    expect(created.secret).toMatch(/^[A-Za-z0-9_-]{64}$/); // 48 bytes base64url
    expect(created.url).toBe(`http://localhost:3000/v/${created.secret}/`);
    expect(created.shareToken).toMatchObject({
      name: 'Alice',
      versionMode: 'latest',
      pinnedVersion: null,
      canAnnotate: false,
      hasPassword: false,
      revokedAt: null,
      accessCount: 0,
      lastAccessedAt: null
    });

    // Listings never leak the secret or any hash.
    const listed = await listTokens();
    const raw = JSON.stringify(listed);
    expect(raw).not.toContain(created.secret);
    expect(raw.toLowerCase()).not.toContain('hash');
    expect(listed.shareTokens.some((t: { id: string }) => t.id === created.shareToken.id)).toBe(true);
  });

  it('replays (not double-mints) a retried create carrying an Idempotency-Key', async () => {
    const key = `share-create-${Date.now()}`;
    const first = await createToken({ name: 'Retry' }, { 'idempotency-key': key });
    const second = await createToken({ name: 'Retry' }, { 'idempotency-key': key });
    expect(second.secret).toBe(first.secret);
    expect(second.shareToken.id).toBe(first.shareToken.id);
  });

  it('validates pinnedVersion exists (400 invalid_version)', async () => {
    const res = await app.app.request(
      `/api/v1/presentations/${deckId}/tokens`,
      json({ name: 'Pin', versionMode: 'pinned', pinnedVersion: 99 }, { cookie })
    );
    expect(res.status).toBe(400);
    expect((await readJson(res)).error.code).toBe('invalid_version');
  });

  it('404s an unknown deck and 400s a non-uuid deck id', async () => {
    const unknown = await app.app.request(
      '/api/v1/presentations/00000000-0000-4000-8000-000000000000/tokens',
      json({ name: 'X' }, { cookie })
    );
    expect(unknown.status).toBe(404);
    const malformed = await app.app.request('/api/v1/presentations/not-a-uuid/tokens', {
      headers: { cookie }
    });
    expect(malformed.status).toBe(400);
  });

  it('gates the sharing surface on deck write access: a plain member 404s (AUTH-5)', async () => {
    // Invite + accept a plain member, then try the owner's deck.
    const invite = await app.app.request(
      '/api/v1/invitations',
      json({ email: 'member@share.test', role: 'member' }, { cookie })
    );
    expect(invite.status).toBe(201);
    const acceptUrl: string = (await readJson(invite)).acceptUrl;
    const token = acceptUrl.split('/invite/')[1]!;
    const accept = await app.app.request(
      '/api/v1/invitations/accept',
      json({ token, name: 'Member', password: 'member-password-123' })
    );
    expect(accept.status).toBe(200);
    const memberSignIn = await app.app.request(
      '/api/v1/auth/sign-in/email',
      json({ email: 'member@share.test', password: 'member-password-123' })
    );
    const memberCookie = extractCookie(memberSignIn);

    // 404, not 403 (PRDCT-1354 / AUTH-5): a 403 here confirmed the deck
    // exists to any workspace member, the same existence oracle the ADR 013
    // read invariant forbids. Indistinguishable from an unknown deck id.
    const list = await app.app.request(`/api/v1/presentations/${deckId}/tokens`, {
      headers: { cookie: memberCookie }
    });
    expect(list.status).toBe(404);
    const create = await app.app.request(
      `/api/v1/presentations/${deckId}/tokens`,
      json({ name: 'Nope' }, { cookie: memberCookie })
    );
    expect(create.status).toBe(404);
  });

  it('machine principals ride the presentations scopes: read lists, write creates', async () => {
    const mintRead = await app.app.request(
      '/api/v1/api-keys',
      json({ name: 'read-key', scopes: ['presentations:read'] }, { cookie })
    );
    const readKey = (await readJson(mintRead)).key as string;
    const mintWrite = await app.app.request(
      '/api/v1/api-keys',
      json({ name: 'write-key', scopes: ['presentations:write'] }, { cookie })
    );
    const writeKey = (await readJson(mintWrite)).key as string;

    const listWithRead = await app.app.request(`/api/v1/presentations/${deckId}/tokens`, {
      headers: { authorization: `Bearer ${readKey}` }
    });
    expect(listWithRead.status).toBe(200);

    const createWithRead = await app.app.request(
      `/api/v1/presentations/${deckId}/tokens`,
      json({ name: 'Denied' }, { authorization: `Bearer ${readKey}` })
    );
    expect(createWithRead.status).toBe(403); // fail-closed scope gate

    const createWithWrite = await app.app.request(
      `/api/v1/presentations/${deckId}/tokens`,
      json({ name: 'Via key' }, { authorization: `Bearer ${writeKey}` })
    );
    expect(createWithWrite.status).toBe(201);
  });
});

// ═══ The public viewer ═══════════════════════════════════════════════════════

describe('public viewer (ADR 012)', () => {
  it('serves the entry HTML anonymously, inline, under the exact sandbox header set', async () => {
    const { secret } = await createToken({ name: 'Viewer' });
    const res = await app.app.request(`/v/${secret}/`); // NO auth of any kind
    expect(res.status).toBe(200);
    expectViewerContentHeaders(res);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('content-disposition')).toContain('inline');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toContain('Deck v1 marker');
  });

  it('301s the no-slash entry URL to the trailing-slash form, query preserved', async () => {
    // The slash form is what makes a deck's RELATIVE references (styles,
    // images, links to other pages) resolve inside /v/{secret}/ — at the
    // no-slash URL the browser would resolve them against /v/, replacing
    // the secret segment. Old printed links heal through this redirect.
    const { secret } = await createToken({ name: 'Redirect' });
    const bare = await app.app.request(`/v/${secret}`);
    expect(bare.status).toBe(301);
    expect(bare.headers.get('location')).toBe(`/v/${secret}/`);

    const withQuery = await app.app.request(`/v/${secret}?raw`);
    expect(withQuery.status).toBe(301);
    expect(withQuery.headers.get('location')).toBe(`/v/${secret}/?raw`);

    // The redirect resolves nothing: even an unknown secret gets the same
    // 301 (existence stays unprobeable from the bare form; the slash form
    // answers 404 as before).
    const unknown = await app.app.request(`/v/${'A'.repeat(64)}`);
    expect(unknown.status).toBe(301);
  });

  it('sub-page HTML assets carry the sandbox set too (every user-HTML response)', async () => {
    const { secret } = await createToken({ name: 'Subpage' });
    const res = await app.app.request(`/v/${secret}/pages/two.html`);
    expect(res.status).toBe(200);
    expectViewerContentHeaders(res);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('Subpage marker');
  });

  it('streams assets byte-exact with ETag + Range, sandbox CSP included', async () => {
    const { secret } = await createToken({ name: 'Assets' });
    const res = await app.app.request(`/v/${secret}/assets/logo.png`);
    expect(res.status).toBe(200);
    expectViewerContentHeaders(res);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('etag')).toBe(`"${shaOf(PNG_BYTES)}"`);
    expect(res.headers.get('cache-control')).toBe('private, no-cache');
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG_BYTES)).toBe(true);

    const partial = await app.app.request(`/v/${secret}/assets/logo.png`, {
      headers: { range: 'bytes=0-3' }
    });
    expect(partial.status).toBe(206);
    expect(partial.headers.get('content-range')).toBe(`bytes 0-3/${PNG_BYTES.length}`);
    expect(Buffer.from(await partial.arrayBuffer()).equals(PNG_BYTES.subarray(0, 4))).toBe(true);
    expectViewerContentHeaders(partial);

    const cached = await app.app.request(`/v/${secret}/assets/logo.png`, {
      headers: { 'if-none-match': `"${shaOf(PNG_BYTES)}"` }
    });
    expect(cached.status).toBe(304);
  });

  it('counts views on ENTRY loads only — not on assets, not on HEAD', async () => {
    const created = await createToken({ name: 'Counter' });
    const before = await totalViewsOf(deckId);

    await app.app.request(`/v/${created.secret}/`);
    await app.app.request(`/v/${created.secret}/`);
    await app.app.request(`/v/${created.secret}/assets/logo.png`);
    await app.app.request(`/v/${created.secret}/pages/two.html`);
    await app.app.request(`/v/${created.secret}/`, { method: 'HEAD' });

    const listed = await listTokens();
    const row = listed.shareTokens.find((t: { id: string }) => t.id === created.shareToken.id);
    expect(row.accessCount).toBe(2);
    expect(row.lastAccessedAt).not.toBeNull();

    const after = await totalViewsOf(deckId);
    expect(after.totalViews).toBe(before.totalViews + 2);
    expect(after.lastViewedAt).not.toBeNull();
  });

  it('de-dupes repeat opens per browser: a counted GET sets slvd_, replaying it never re-counts', async () => {
    // PRDCT-1243: one "open" is several GETs in the wild (speculative
    // prefetch/prerender + the navigation, reloads). The first counted GET
    // hands out the signed viewed cookie; while the browser presents it,
    // the entry is served but not re-counted.
    const created = await createToken({ name: 'Deduped' });
    const before = await totalViewsOf(deckId);

    const first = await app.app.request(`/v/${created.secret}/`);
    expect(first.status).toBe(200);
    const setCookie = first.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`slvd_${created.shareToken.id}=`);
    expect(setCookie).toContain(`Path=/v/${created.secret}`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Max-Age=600'); // 10-minute default, in seconds
    expectViewerContentHeaders(first);
    const viewedCookie = setCookie.split(';')[0]!;

    const second = await app.app.request(`/v/${created.secret}/`, { headers: { cookie: viewedCookie } });
    expect(second.status).toBe(200); // served in full…
    expect(await second.text()).toContain('marker');

    const listed = await listTokens();
    const row = listed.shareTokens.find((t: { id: string }) => t.id === created.shareToken.id);
    expect(row.accessCount).toBe(1); // …but counted once
    expect((await totalViewsOf(deckId)).totalViews).toBe(before.totalViews + 1);
  });

  it('forged, expired, and wrong-token viewed cookies never suppress counting', async () => {
    const a = await createToken({ name: 'Dedupe A' });
    const b = await createToken({ name: 'Dedupe B' });

    const first = await app.app.request(`/v/${a.secret}/`); // counts 1, hands out A's cookie
    const aPair = (first.headers.get('set-cookie') ?? '').split(';')[0]!;
    const aValue = aPair.slice(aPair.indexOf('=') + 1);

    // Garbage under the right name.
    await app.app.request(`/v/${a.secret}/`, {
      headers: { cookie: `slvd_${a.shareToken.id}=garbage` }
    });
    // Well-signed but expired (minted with a negative TTL under the real key).
    const expired = mintViewedValue(app.authSecret, a.shareToken.id, -1000);
    await app.app.request(`/v/${a.secret}/`, {
      headers: { cookie: `slvd_${a.shareToken.id}=${expired}` }
    });
    // Token A's genuine value smuggled under token B's cookie name.
    await app.app.request(`/v/${b.secret}/`, {
      headers: { cookie: `slvd_${b.shareToken.id}=${aValue}` }
    });

    const listed = await listTokens();
    const rowA = listed.shareTokens.find((t: { id: string }) => t.id === a.shareToken.id);
    const rowB = listed.shareTokens.find((t: { id: string }) => t.id === b.shareToken.id);
    expect(rowA.accessCount).toBe(3); // initial + garbage + expired all counted
    expect(rowB.accessCount).toBe(1); // the cross-token replay counted
  });

  it('HEAD and preview responses never carry the viewed cookie', async () => {
    const created = await createToken({ name: 'No cookie on HEAD' });
    const head = await app.app.request(`/v/${created.secret}/`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('set-cookie')).toBeNull();

    const previewRes = await app.app.request(
      `/api/v1/presentations/${deckId}/preview-token`,
      json({}, { cookie })
    );
    expect(previewRes.status).toBe(201);
    const preview = await readJson(previewRes);
    const served = await app.app.request(`/v/${preview.secret}/`);
    expect(served.status).toBe(200);
    expect(served.headers.get('set-cookie')).toBeNull(); // never counted → never marked
  });

  it('the overlay-injected (transform) entry path carries the viewed cookie too', async () => {
    // The annotator/browser entry is served through the buffered transform
    // path, not serveBlob — the de-dupe cookie must ride both serve paths.
    const created = await createToken({ name: 'Overlay dedupe', canAnnotate: true });

    const first = await app.app.request(`/v/${created.secret}/`, { headers: { accept: 'text/html' } });
    expect(first.status).toBe(200);
    expect(await first.text()).toContain(OVERLAY_MARKER); // proves the transform path served it
    const setCookie = first.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`slvd_${created.shareToken.id}=`);
    const viewedCookie = setCookie.split(';')[0]!;

    const second = await app.app.request(`/v/${created.secret}/`, {
      headers: { accept: 'text/html', cookie: viewedCookie }
    });
    expect(second.status).toBe(200);

    const listed = await listTokens();
    const row = listed.shareTokens.find((t: { id: string }) => t.id === created.shareToken.id);
    expect(row.accessCount).toBe(1);
  });

  it('exposes totalViews on the wire and never counts dashboard preview tokens', async () => {
    // The dashboard detail page mints a transient preview token through the
    // DEDICATED endpoint for its sandboxed iframe (ADR 012 Surface D) —
    // those opens must not inflate the deck's view stats. The exclusion
    // keys on the server-set purpose column (the name is cosmetic).
    const res = await app.app.request(`/api/v1/presentations/${deckId}/preview-token`, json({}, { cookie }));
    expect(res.status).toBe(201);
    const preview = await readJson(res);
    expect(preview.shareToken.purpose).toBe('preview');
    const before = await totalViewsOf(deckId);

    const served = await app.app.request(`/v/${preview.secret}/`);
    expect(served.status).toBe(200); // the preview still renders…
    const after = await totalViewsOf(deckId);
    expect(after.totalViews).toBe(before.totalViews); // …but never counts

    const listed = await listTokens();
    const row = listed.shareTokens.find((t: { id: string }) => t.id === preview.shareToken.id);
    expect(row.accessCount).toBe(0);

    // The deck wire shape carries the counter (list + get agree).
    const listRes = await readJson(await app.app.request('/api/v1/presentations', { headers: { cookie } }));
    const deckRow = listRes.presentations.find((p: { id: string }) => p.id === deckId);
    expect(deckRow.totalViews).toBe(before.totalViews);
    const getRes = await readJson(
      await app.app.request(`/api/v1/presentations/${deckId}`, { headers: { cookie } })
    );
    expect(getRes.totalViews).toBe(before.totalViews);
  });

  it('SECURITY: a token merely NAMED "Dashboard preview" is a NORMAL token — visible and counted', async () => {
    // The old model keyed concealment on this client-controlled name; any
    // deck writer could mint a hidden, stat-silent link. The name must have
    // no special meaning anywhere anymore.
    const spoofed = await createToken({ name: PREVIEW_SHARE_TOKEN_NAME });
    expect(spoofed.shareToken.purpose).toBe('share');
    const before = await totalViewsOf(deckId);

    expect((await app.app.request(`/v/${spoofed.secret}/`)).status).toBe(200);
    const after = await totalViewsOf(deckId);
    expect(after.totalViews).toBe(before.totalViews + 1); // counted like any token

    const listed = await listTokens();
    const row = listed.shareTokens.find((t: { id: string }) => t.id === spoofed.shareToken.id);
    expect(row).toBeDefined();
    expect(row.purpose).toBe('share'); // the panel filter keys on purpose → visible
    expect(row.accessCount).toBe(1);
  });

  it('unknown → 404, revoked → 403, expired → 410', async () => {
    const unknown = await app.app.request(`/v/${'A'.repeat(64)}/`);
    expect(unknown.status).toBe(404);

    const revokable = await createToken({ name: 'Revoke me' });
    expect((await app.app.request(`/v/${revokable.secret}/`)).status).toBe(200);
    const revoke = await app.app.request(
      `/api/v1/presentations/${deckId}/tokens/${revokable.shareToken.id}`,
      { method: 'DELETE', headers: { cookie } }
    );
    expect(revoke.status).toBe(200);
    expect((await readJson(revoke)).revokedAt).not.toBeNull();
    const afterRevoke = await app.app.request(`/v/${revokable.secret}/`);
    expect(afterRevoke.status).toBe(403);
    // Assets die with the token too.
    expect((await app.app.request(`/v/${revokable.secret}/assets/logo.png`)).status).toBe(403);

    const expired = await createToken({
      name: 'Expired',
      expiresAt: new Date(Date.now() - 60_000).toISOString()
    });
    expect((await app.app.request(`/v/${expired.secret}/`)).status).toBe(410);
  });

  it('rejects traversal-shaped asset paths without touching the manifest', async () => {
    const { secret } = await createToken({ name: 'Traversal' });
    for (const path of ['..%2F..%2Fetc%2Fpasswd', 'a//b', 'assets/%2e%2e/logo.png']) {
      const res = await app.app.request(`/v/${secret}/${path}`);
      expect(res.status, `path ${path}`).toBe(404);
    }
    // Dot-dot segments (literal or percent-encoded, per the WHATWG URL
    // parser) normalize BEFORE routing: /v/{secret}/../x becomes /v/x — the
    // bare-entry shape, which 301s to /v/x/ where the nonexistent "secret"
    // answers 404. Nothing in the manifest is reachable either way.
    for (const path of ['../secret', '.%2e/x']) {
      const res = await app.app.request(`/v/${secret}/${path}`);
      expect(res.status, `path ${path}`).toBe(301);
      expect(res.headers.get('location'), `path ${path}`).toMatch(/^\/v\/[^/]+\/$/);
    }
    expect((await app.app.request('/v/secret/')).status).toBe(404);
  });

  it('pinned tokens stay on their version while latest follows a new push', async () => {
    const pinned = await createToken({ name: 'Pinned v1', versionMode: 'pinned', pinnedVersion: 1 });
    const latest = await createToken({ name: 'Latest' });

    await uploadAsset(HTML_V2, 'text/html', 'index.html');
    const commit = await app.app.request(
      `/api/v1/presentations/${deckId}/versions`,
      json(
        {
          expectedBaseVersion: 1,
          entryPath: 'index.html',
          manifest: [
            entryOf('index.html', HTML_V2, 'text/html'),
            entryOf('assets/logo.png', PNG_BYTES, 'image/png'),
            entryOf('pages/two.html', HTML_SUBPAGE, 'text/html')
          ]
        },
        { cookie }
      )
    );
    expect(commit.status).toBe(201);

    const pinnedRes = await app.app.request(`/v/${pinned.secret}/`);
    expect(await pinnedRes.text()).toContain('Deck v1 marker');
    const latestRes = await app.app.request(`/v/${latest.secret}/`);
    expect(await latestRes.text()).toContain('Deck v2 marker');
    expectViewerContentHeaders(pinnedRes);
    expectViewerContentHeaders(latestRes);

    // PATCH re-pins live: pin the latest token to v1, then back to latest.
    const pin = await app.app.request(`/api/v1/presentations/${deckId}/tokens/${latest.shareToken.id}`, {
      ...json({ versionMode: 'pinned', pinnedVersion: 1 }, { cookie }),
      method: 'PATCH'
    });
    expect(pin.status).toBe(200);
    expect((await readJson(pin)).versionMode).toBe('pinned');
    expect(await (await app.app.request(`/v/${latest.secret}/`)).text()).toContain('Deck v1 marker');

    const unpin = await app.app.request(`/api/v1/presentations/${deckId}/tokens/${latest.shareToken.id}`, {
      ...json({ versionMode: 'latest' }, { cookie }),
      method: 'PATCH'
    });
    expect(unpin.status).toBe(200);
    expect(await (await app.app.request(`/v/${latest.secret}/`)).text()).toContain('Deck v2 marker');
  });

  it('soft-deleting the deck makes its tokens stop resolving (404)', async () => {
    // A dedicated throwaway deck so the shared one survives the suite.
    const reserve = await readJson(
      await app.app.request('/api/v1/presentations/uploads', { method: 'POST', headers: { cookie } })
    );
    await app.app.request(
      `/api/v1/presentations/uploads/${reserve.uploadSession.id}/commit`,
      json(
        { title: 'Doomed', entryPath: 'index.html', manifest: [entryOf('index.html', HTML_V1, 'text/html')] },
        { cookie }
      )
    );
    const doomedId = reserve.uploadSession.presentationId as string;
    const res = await app.app.request(
      `/api/v1/presentations/${doomedId}/tokens`,
      json({ name: 'D' }, { cookie })
    );
    const { secret } = await readJson(res);
    expect((await app.app.request(`/v/${secret}/`)).status).toBe(200);
    await app.app.request(`/api/v1/presentations/${doomedId}`, { method: 'DELETE', headers: { cookie } });
    expect((await app.app.request(`/v/${secret}/`)).status).toBe(404);
  });
});

// ═══ Password gate ═══════════════════════════════════════════════════════════

describe('password gate', () => {
  const PASSWORD = 'correct-horse-9';

  it('challenges browsers with a form, agents with the JSON wire shape', async () => {
    const created = await createToken({ name: 'Gated', password: PASSWORD });

    const browser = await app.app.request(`/v/${created.secret}/`, {
      headers: { accept: 'text/html,application/xhtml+xml' }
    });
    expect(browser.status).toBe(401);
    const page = await browser.text();
    expect(page).toContain('<form');
    expect(page).not.toContain('Deck v'); // never the deck bytes
    expect(browser.headers.get('cache-control')).toBe('no-store');
    expect(browser.headers.get('vary')).toContain('accept');
    // The gate shell is OURS — first-party HTML, strict CSP, NOT the sandbox.
    expect(browser.headers.get('content-security-policy')).not.toContain('allow-scripts');

    const agent = await app.app.request(`/v/${created.secret}/`, { headers: { accept: '*/*' } });
    expect(agent.status).toBe(401);
    expect((await readJson(agent)).error.code).toBe('password_required');

    // ?raw never gets the HTML shell, whatever the Accept header says.
    const raw = await app.app.request(`/v/${created.secret}/?raw`, { headers: { accept: 'text/html' } });
    expect(raw.status).toBe(401);
    expect((await readJson(raw)).error.code).toBe('password_required');
  });

  it('accepts the x-viewer-password header (agents), counting the view', async () => {
    const created = await createToken({ name: 'Gated header', password: PASSWORD });

    const wrong = await app.app.request(`/v/${created.secret}/`, {
      headers: { 'x-viewer-password': 'nope' }
    });
    expect(wrong.status).toBe(401);
    expect((await readJson(wrong)).error.code).toBe('password_invalid');

    const right = await app.app.request(`/v/${created.secret}/`, {
      headers: { 'x-viewer-password': PASSWORD }
    });
    expect(right.status).toBe(200);
    expectViewerContentHeaders(right);
    expect(await right.text()).toContain('marker');

    // Assets sit behind the same gate.
    const assetNoProof = await app.app.request(`/v/${created.secret}/assets/logo.png`);
    expect(assetNoProof.status).toBe(401);
    const assetWithProof = await app.app.request(`/v/${created.secret}/assets/logo.png`, {
      headers: { 'x-viewer-password': PASSWORD }
    });
    expect(assetWithProof.status).toBe(200);

    const listed = await listTokens();
    const row = listed.shareTokens.find((t: { id: string }) => t.id === created.shareToken.id);
    expect(row.hasPassword).toBe(true);
    expect(row.accessCount).toBe(1); // only the successful entry load counted
  });

  it('the password form on a SUB-PAGE posts back to that sub-page (multi-page decks)', async () => {
    // The gate challenges on every document under /v/{secret}/, and the form
    // posts to the URL that challenged — a sub-page unlock must bounce back
    // to the sub-page, not 404 (found by the overlay-rework review).
    const created = await createToken({ name: 'Gated subpage', password: PASSWORD });
    const post = await app.app.request(`/v/${created.secret}/pages/two.html`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': '10.9.9.1' },
      body: new URLSearchParams({ password: PASSWORD }).toString()
    });
    expect(post.status).toBe(303);
    expect(post.headers.get('location')).toBe(`/v/${created.secret}/pages/two.html`);
    const unlockCookie = (post.headers.get('set-cookie') ?? '').split(';')[0]!;
    const page = await app.app.request(`/v/${created.secret}/pages/two.html`, {
      headers: { cookie: unlockCookie }
    });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Subpage marker');
  });

  it('browser form POST sets a token-scoped unlock cookie honored by entry + assets', async () => {
    const created = await createToken({ name: 'Gated form', password: PASSWORD });

    const post = await app.app.request(`/v/${created.secret}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: PASSWORD }).toString()
    });
    expect(post.status).toBe(303);
    expect(post.headers.get('location')).toBe(`/v/${created.secret}/`);
    const setCookie = post.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`slv_${created.shareToken.id}=`);
    expect(setCookie).toContain(`Path=/v/${created.secret}`);
    expect(setCookie).toContain('HttpOnly');
    const unlockCookie = setCookie.split(';')[0]!;

    const entry = await app.app.request(`/v/${created.secret}/`, { headers: { cookie: unlockCookie } });
    expect(entry.status).toBe(200);
    expectViewerContentHeaders(entry);
    const asset = await app.app.request(`/v/${created.secret}/assets/logo.png`, {
      headers: { cookie: unlockCookie }
    });
    expect(asset.status).toBe(200);

    // A wrong form POST re-challenges.
    const bad = await app.app.request(`/v/${created.secret}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' },
      body: new URLSearchParams({ password: 'wrong' }).toString()
    });
    expect(bad.status).toBe(401);
    expect(await bad.text()).toContain('not correct');

    // Changing the password kills outstanding unlock cookies.
    const patch = await app.app.request(`/api/v1/presentations/${deckId}/tokens/${created.shareToken.id}`, {
      ...json({ password: 'a-new-password-1' }, { cookie }),
      method: 'PATCH'
    });
    expect(patch.status).toBe(200);
    const stale = await app.app.request(`/v/${created.secret}/`, { headers: { cookie: unlockCookie } });
    expect(stale.status).toBe(401);

    // Clearing the password re-opens the link.
    await app.app.request(`/api/v1/presentations/${deckId}/tokens/${created.shareToken.id}`, {
      ...json({ password: null }, { cookie }),
      method: 'PATCH'
    });
    expect((await app.app.request(`/v/${created.secret}/`)).status).toBe(200);
  });

  it('the unlock flow counts exactly once: challenge never counts, unlocked GET counts + de-dupes', async () => {
    const created = await createToken({ name: 'Gated dedupe', password: PASSWORD });

    // Challenge and form POST hand out no viewed cookie and count nothing.
    const challenge = await app.app.request(`/v/${created.secret}/`, { headers: { accept: 'text/html' } });
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get('set-cookie')).toBeNull();
    const post = await app.app.request(`/v/${created.secret}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: PASSWORD }).toString()
    });
    expect(post.status).toBe(303);
    expect(post.headers.get('set-cookie')).not.toContain('slvd_'); // only the slv_ unlock cookie
    const unlockCookie = (post.headers.get('set-cookie') ?? '').split(';')[0]!;

    // The unlocked GET is the view: counted once, viewed cookie minted.
    const entry = await app.app.request(`/v/${created.secret}/`, { headers: { cookie: unlockCookie } });
    expect(entry.status).toBe(200);
    const viewedCookie = (entry.headers.get('set-cookie') ?? '').split(';')[0]!;
    expect(viewedCookie).toContain(`slvd_${created.shareToken.id}=`);

    const again = await app.app.request(`/v/${created.secret}/`, {
      headers: { cookie: `${unlockCookie}; ${viewedCookie}` }
    });
    expect(again.status).toBe(200);

    const listed = await listTokens();
    const row = listed.shareTokens.find((t: { id: string }) => t.id === created.shareToken.id);
    expect(row.accessCount).toBe(1);
  });

  it('failed attempts burn a per-IP+token bucket (429 after exhaustion)', async () => {
    const created = await createToken({ name: 'Bruteforce', password: PASSWORD });
    // The limiter allows 10 failures per 15 min; app.request has no socket,
    // so all attempts share the 'unknown' IP + this token's bucket.
    for (let i = 0; i < 10; i++) {
      const res = await app.app.request(`/v/${created.secret}/`, {
        headers: { 'x-viewer-password': `guess-${i}` }
      });
      expect(res.status).toBe(401);
    }
    const blocked = await app.app.request(`/v/${created.secret}/`, {
      headers: { 'x-viewer-password': PASSWORD } // even the right one is walled now
    });
    expect(blocked.status).toBe(429);
  });
});

// ═══ De-dupe disabled (VIEW_DEDUPE_WINDOW_MINUTES=0) ═════════════════════════

describe('view counting with de-dupe disabled', () => {
  let offApp: TestApp;
  let offCookie: string;
  let offDeckId: string;

  beforeAll(async () => {
    // Own boot on the shared container: the window is an env knob, fixed at
    // boot (createTestApp extraEnv), so the opt-out needs its own app + db.
    offApp = await createTestApp(await createDatabase(container, 'view_dedupe_off'), {
      VIEW_DEDUPE_WINDOW_MINUTES: '0'
    });
    await offApp.app.request(
      '/api/v1/setup',
      json({ setupToken: 'integration-test-setup-token', instanceName: 'Dedupe Off', owner: OWNER })
    );
    const signIn = await offApp.app.request(
      '/api/v1/auth/sign-in/email',
      json({ email: OWNER.email, password: OWNER.password })
    );
    offCookie = extractCookie(signIn);

    const reserve = await readJson(
      await offApp.app.request('/api/v1/presentations/uploads', {
        method: 'POST',
        headers: { cookie: offCookie }
      })
    );
    offDeckId = reserve.uploadSession.presentationId;
    const form = new FormData();
    form.set('sha256', shaOf(HTML_V1));
    form.set('file', new Blob([new Uint8Array(HTML_V1)], { type: 'text/html' }), 'index.html');
    const upload = await offApp.app.request('/api/v1/presentations/assets', {
      method: 'POST',
      headers: { cookie: offCookie },
      body: form
    });
    expect(upload.status).toBe(201);
    const commit = await offApp.app.request(
      `/api/v1/presentations/uploads/${reserve.uploadSession.id}/commit`,
      json(
        {
          title: 'Dedupe Off',
          entryPath: 'index.html',
          manifest: [entryOf('index.html', HTML_V1, 'text/html')]
        },
        { cookie: offCookie }
      )
    );
    expect(commit.status).toBe(201);
  }, 120_000);

  afterAll(async () => {
    await offApp?.stop();
  });

  it('0 disables de-dupe: every entry GET counts and no viewed cookie is set (pre-fix behavior)', async () => {
    const createRes = await offApp.app.request(
      `/api/v1/presentations/${offDeckId}/tokens`,
      json({ name: 'Raw counter' }, { cookie: offCookie })
    );
    expect(createRes.status).toBe(201);
    const created = await readJson(createRes);

    for (let i = 0; i < 3; i++) {
      const res = await offApp.app.request(`/v/${created.secret}/`);
      expect(res.status).toBe(200);
      expect(res.headers.get('set-cookie')).toBeNull();
    }

    const listRes = await offApp.app.request(`/api/v1/presentations/${offDeckId}/tokens`, {
      headers: { cookie: offCookie }
    });
    expect(listRes.status).toBe(200);
    const listed = await readJson(listRes);
    const row = listed.shareTokens.find((t: { id: string }) => t.id === created.shareToken.id);
    expect(row.accessCount).toBe(3);
  });
});

// ═══ Share via email ═════════════════════════════════════════════════════════

describe('share via email', () => {
  it('sends one email per recipient token, each with its own working viewer URL', async () => {
    const alice = await createToken({ name: 'Alice (email)' });
    const bob = await createToken({ name: 'Bob (email)' });
    mail.sent.length = 0;

    for (const [t, to] of [
      [alice, 'alice@recipients.test'],
      [bob, 'bob@recipients.test']
    ] as const) {
      const res = await app.app.request(
        `/api/v1/presentations/${deckId}/tokens/${t.shareToken.id}/send`,
        json({ email: to, message: `Hi ${to}` }, { cookie })
      );
      expect(res.status).toBe(200);
      expect((await readJson(res)).emailSent).toBe(true);
    }

    expect(mail.sent).toHaveLength(2);
    expect(mail.sent.map((m) => m.to).sort()).toEqual(['alice@recipients.test', 'bob@recipients.test']);

    const urls = mail.sent.map((m) => {
      const match = /\/v\/([A-Za-z0-9_-]{64})/.exec(m.html);
      expect(match).not.toBeNull();
      return match![1]!;
    });
    expect(urls[0]).not.toBe(urls[1]); // per-recipient links are distinct

    // The emailed (rotated) secret works; the create-time secret is retired.
    for (const [i, t] of [alice, bob].entries()) {
      expect((await app.app.request(`/v/${urls[i]}/`)).status).toBe(200);
      expect((await app.app.request(`/v/${t.secret}/`)).status).toBe(404);
    }

    // Personal note travels escaped into the mail body.
    expect(mail.sent[0]!.html).toContain('Hi alice@recipients.test');
  });

  it('refuses to send on a revoked token', async () => {
    const t = await createToken({ name: 'Revoked send' });
    await app.app.request(`/api/v1/presentations/${deckId}/tokens/${t.shareToken.id}`, {
      method: 'DELETE',
      headers: { cookie }
    });
    const res = await app.app.request(
      `/api/v1/presentations/${deckId}/tokens/${t.shareToken.id}/send`,
      json({ email: 'x@y.test' }, { cookie })
    );
    expect(res.status).toBe(400);
    expect((await readJson(res)).error.code).toBe('token_revoked');
  });
});
