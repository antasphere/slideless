import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { VIEWER_CSP } from '../../src/viewer/routes.js';
import { OVERLAY_MARKER } from '../../src/viewer/overlay.js';
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
 * Phase 5 — annotations, end-to-end across both surfaces:
 *
 *  - OVERLAY INJECTION: the entry HTML carries the inline overlay client
 *    exactly when (annotator token × browser navigation × not ?raw), with
 *    the ADR 012 sandbox header set intact and no ETag on injected bytes;
 *  - the PUBLIC token-authed write/list endpoints (/api/v1/viewer/…):
 *    cross-origin from the opaque origin (Origin: null + preflight),
 *    can_annotate enforcement, revoked/expired/unknown mapping, validation
 *    caps, the password proof (injected unlock MAC + x-viewer-password),
 *    per-token listing isolation, and the spam rate limit;
 *  - the OWNER/DEV management surface: list/filter, resolve, delete, the
 *    workspace inbox, member gating, and principal-authored notes.
 */

const OWNER = { email: 'owner@annot.test', name: 'Annot Owner', password: 'annot-owner-pass-1' };

const HTML_V1 = Buffer.from(
  '<!doctype html><html><head><title>Deck</title></head><body><h1>Annotate me</h1></body></html>'
);
const HTML_V2 = Buffer.from('<!doctype html><html><body><h1>v2 content</h1></body></html>');
const shaOf = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const entryOf = (path: string, bytes: Buffer) => ({
  path,
  sha256: shaOf(bytes),
  sizeBytes: bytes.length,
  contentType: 'text/html'
});

let container: StartedPostgreSqlContainer;
let app: TestApp;
let cookie: string;
let deckId: string;

let ipCounter = 0;
const nextIp = () => `10.77.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body)
});

/** Simulates the overlay: cross-origin JSON POST from the opaque origin. */
const overlayPost = (secret: string, body: unknown, headers: Record<string, string> = {}) =>
  app.app.request(`/api/v1/viewer/${secret}/annotations`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'null',
      'x-forwarded-for': nextIp(),
      ...headers
    },
    body: JSON.stringify(body)
  });

const overlayList = (secret: string, headers: Record<string, string> = {}) =>
  app.app.request(`/api/v1/viewer/${secret}/annotations`, {
    headers: { origin: 'null', 'x-forwarded-for': nextIp(), ...headers }
  });

async function createToken(body: Record<string, unknown>): Promise<{ secret: string; id: string }> {
  const res = await app.app.request(`/api/v1/presentations/${deckId}/tokens`, json(body, { cookie }));
  expect(res.status).toBe(201);
  const parsed = await readJson(res);
  return { secret: parsed.secret, id: parsed.shareToken.id };
}

const fetchEntry = (secret: string, headers: Record<string, string> = {}) =>
  app.app.request(`/v/${secret}`, { headers: { accept: 'text/html', ...headers } });

function expectSandboxHeaders(res: Response): void {
  expect(res.headers.get('content-security-policy')).toBe(VIEWER_CSP);
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  expect(res.headers.get('referrer-policy')).toBe('no-referrer');
}

beforeAll(async () => {
  container = await startPostgres();
  app = await createTestApp(
    await createDatabase(container, 'annotations_p5'),
    {},
    { email: new RecordingEmailDriver() }
  );
  await app.app.request('/api/v1/setup', json({ instanceName: 'Annot', owner: OWNER }));
  const signIn = await app.app.request(
    '/api/v1/auth/sign-in/email',
    json({ email: OWNER.email, password: OWNER.password })
  );
  cookie = extractCookie(signIn);

  const upload = async (bytes: Buffer) => {
    const form = new FormData();
    form.set('sha256', shaOf(bytes));
    form.set('file', new Blob([new Uint8Array(bytes)], { type: 'text/html' }), 'index.html');
    const res = await app.app.request('/api/v1/presentations/assets', {
      method: 'POST',
      headers: { cookie },
      body: form
    });
    expect(res.status).toBe(201);
  };
  await upload(HTML_V1);
  await upload(HTML_V2);

  const reserve = await readJson(
    await app.app.request('/api/v1/presentations/uploads', { method: 'POST', headers: { cookie } })
  );
  deckId = reserve.uploadSession.presentationId;
  const commit = await app.app.request(
    `/api/v1/presentations/uploads/${reserve.uploadSession.id}/commit`,
    json(
      { title: 'Annot Deck', entryPath: 'index.html', manifest: [entryOf('index.html', HTML_V1)] },
      { cookie }
    )
  );
  expect(commit.status).toBe(201);
}, 120_000);

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

// ═══ Overlay injection ═══════════════════════════════════════════════════════

describe('overlay injection', () => {
  it('injects the overlay for a browser entry of an annotator token — sandbox headers intact, no ETag', async () => {
    const { secret } = await createToken({ name: 'Reviewer', canAnnotate: true });
    const res = await fetchEntry(secret);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(OVERLAY_MARKER);
    expect(html).toContain('Annotate me'); // the deck itself is untouched
    expect(html.toLowerCase().lastIndexOf('</body>')).toBeGreaterThan(html.indexOf(OVERLAY_MARKER));
    expectSandboxHeaders(res);
    expect(res.headers.get('etag')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('no-store');
    // Password-less token: the injected config carries no unlock proof.
    expect(html).toContain('"unlock":null');
  });

  it('never injects for ?raw, non-HTML accepts, agent password unlocks, or non-annotator tokens', async () => {
    const annotator = await createToken({ name: 'Raw Check', canAnnotate: true });
    const raw = await app.app.request(`/v/${annotator.secret}?raw`, { headers: { accept: 'text/html' } });
    expect(raw.status).toBe(200);
    expect(await raw.text()).not.toContain(OVERLAY_MARKER);
    expectSandboxHeaders(raw);
    // Raw bytes stay byte-exact: content-sha ETag preserved.
    expect(raw.headers.get('etag')).toBe(`"${shaOf(HTML_V1)}"`);

    const agent = await app.app.request(`/v/${annotator.secret}`, { headers: { accept: '*/*' } });
    expect(agent.status).toBe(200);
    expect(await agent.text()).not.toContain(OVERLAY_MARKER);

    const pw = await createToken({ name: 'PW Agent', canAnnotate: true, password: 'agent-pass-1' });
    const viaHeader = await app.app.request(`/v/${pw.secret}`, {
      headers: { accept: 'text/html', 'x-viewer-password': 'agent-pass-1', 'x-forwarded-for': nextIp() }
    });
    expect(viaHeader.status).toBe(200);
    expect(await viaHeader.text()).not.toContain(OVERLAY_MARKER);

    const viewOnly = await createToken({ name: 'View Only', canAnnotate: false });
    const plain = await fetchEntry(viewOnly.secret);
    expect(plain.status).toBe(200);
    expect(await plain.text()).not.toContain(OVERLAY_MARKER);
    // Untransformed entries keep streaming with their content-sha ETag.
    expect(plain.headers.get('etag')).toBe(`"${shaOf(HTML_V1)}"`);
  });
});

// ═══ Public token-authed surface ═════════════════════════════════════════════

describe('public annotation write/list (token-authed, cross-origin)', () => {
  it('answers the CORS preflight and stamps ACAO on responses', async () => {
    const { secret } = await createToken({ name: 'CORS', canAnnotate: true });
    const preflight = await app.app.request(`/api/v1/viewer/${secret}/annotations`, {
      method: 'OPTIONS',
      headers: { origin: 'null', 'access-control-request-method': 'POST' }
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
    expect(preflight.headers.get('access-control-allow-headers')).toContain('X-Slideless-Unlock');

    const list = await overlayList(secret);
    expect(list.status).toBe(200);
    expect(list.headers.get('access-control-allow-origin')).toBe('*');
    expect(list.headers.get('cache-control')).toBe('no-store');
  });

  it('creates an annotation with the token secret; the owner sees it on the management surface', async () => {
    const { secret, id: tokenId } = await createToken({ name: 'Alice', canAnnotate: true });
    const res = await overlayPost(secret, {
      body: 'The intro chart is unclear',
      authorName: 'Alice',
      selection: { type: 'text', quote: 'Annotate me' },
      version: 1
    });
    expect(res.status).toBe(201);
    const created = await readJson(res);
    expect(created).toMatchObject({ version: 1, authorName: 'Alice', status: 'open' });
    // The reviewer wire shape leaks no foreign ids.
    expect(created.shareTokenId).toBeUndefined();
    expect(created.authorUserId).toBeUndefined();
    expect(created.presentationId).toBeUndefined();

    const ownerView = await readJson(
      await app.app.request(`/api/v1/presentations/${deckId}/annotations`, { headers: { cookie } })
    );
    const mine = ownerView.annotations.find((a: { id: string }) => a.id === created.id);
    expect(mine).toMatchObject({
      shareTokenId: tokenId,
      authorUserId: null,
      authorName: 'Alice',
      body: 'The intro chart is unclear',
      status: 'open'
    });
  });

  it('lists ONLY this token’s own notes (per-recipient isolation)', async () => {
    const a = await createToken({ name: 'Iso A', canAnnotate: true });
    const b = await createToken({ name: 'Iso B', canAnnotate: true });
    await overlayPost(a.secret, { body: 'note from A', selection: {} });
    await overlayPost(b.secret, { body: 'note from B', selection: {} });

    const listA = await readJson(await overlayList(a.secret));
    expect(listA.annotations.map((x: { body: string }) => x.body)).toEqual(['note from A']);
    const listB = await readJson(await overlayList(b.secret));
    expect(listB.annotations.map((x: { body: string }) => x.body)).toEqual(['note from B']);
  });

  it('rejects non-annotator (403), revoked (403), expired (410), unknown (404)', async () => {
    const viewOnly = await createToken({ name: 'No Annot', canAnnotate: false });
    const denied = await overlayPost(viewOnly.secret, { body: 'nope', selection: {} });
    expect(denied.status).toBe(403);
    expect((await readJson(denied)).error.code).toBe('not_annotator');

    const revoked = await createToken({ name: 'Revoked', canAnnotate: true });
    await app.app.request(`/api/v1/presentations/${deckId}/tokens/${revoked.id}`, {
      method: 'DELETE',
      headers: { cookie }
    });
    const deadWrite = await overlayPost(revoked.secret, { body: 'nope', selection: {} });
    expect(deadWrite.status).toBe(403);
    expect((await readJson(deadWrite)).error.code).toBe('revoked');

    const expiring = await createToken({
      name: 'Expired',
      canAnnotate: true,
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    await app.app.request(`/api/v1/presentations/${deckId}/tokens/${expiring.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ expiresAt: new Date(Date.now() - 1000).toISOString() })
    });
    const gone = await overlayPost(expiring.secret, { body: 'nope', selection: {} });
    expect(gone.status).toBe(410);

    const unknown = await overlayPost('A'.repeat(64), { body: 'nope', selection: {} });
    expect(unknown.status).toBe(404);
  });

  it('validates the body: empty note, oversized selection, foreign version', async () => {
    const { secret } = await createToken({ name: 'Valid', canAnnotate: true });
    const empty = await overlayPost(secret, { body: '', selection: {} });
    expect(empty.status).toBe(400);

    const fat = await overlayPost(secret, { body: 'x', selection: { blob: 'y'.repeat(9000) } });
    expect(fat.status).toBe(400);
    expect((await readJson(fat)).error.code).toBe('selection_too_large');

    const future = await overlayPost(secret, { body: 'x', selection: {}, version: 99 });
    expect(future.status).toBe(400);
    expect((await readJson(future)).error.code).toBe('invalid_version');

    const notJson = await app.app.request(`/api/v1/viewer/${secret}/annotations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'null', 'x-forwarded-for': nextIp() },
      body: 'not json'
    });
    expect(notJson.status).toBe(400);
  });

  it('anchors pinned tokens to their pin and rejects a mismatching claimed version', async () => {
    // Push v2 so latest ≠ 1, then pin a token to v1.
    const push = await app.app.request(
      `/api/v1/presentations/${deckId}/versions`,
      json(
        { expectedBaseVersion: 1, entryPath: 'index.html', manifest: [entryOf('index.html', HTML_V2)] },
        { cookie }
      )
    );
    expect(push.status).toBe(201);

    const pinned = await createToken({
      name: 'Pinned',
      canAnnotate: true,
      versionMode: 'pinned',
      pinnedVersion: 1
    });
    const ok = await overlayPost(pinned.secret, { body: 'anchored to v1', selection: {} });
    expect(ok.status).toBe(201);
    expect((await readJson(ok)).version).toBe(1);

    const mismatch = await overlayPost(pinned.secret, { body: 'x', selection: {}, version: 2 });
    expect(mismatch.status).toBe(400);

    // A latest-mode token may claim an OLDER version it was actually served.
    const latest = await createToken({ name: 'Latest', canAnnotate: true });
    const older = await overlayPost(latest.secret, { body: 'mid-review push', selection: {}, version: 1 });
    expect(older.status).toBe(201);
    expect((await readJson(older)).version).toBe(1);
    const dflt = await overlayPost(latest.secret, { body: 'on latest', selection: {} });
    expect((await readJson(dflt)).version).toBe(2);
  });

  it('password-protected tokens: 401 without proof; injected unlock MAC works; x-viewer-password works', async () => {
    const pw = await createToken({ name: 'Locked', canAnnotate: true, password: 'reviewer-pass-9' });

    const noProof = await overlayPost(pw.secret, { body: 'x', selection: {} });
    expect(noProof.status).toBe(401);
    expect((await readJson(noProof)).error.code).toBe('password_required');

    // Browser dance: unlock via the form → cookie → injected overlay carries
    // the unlock MAC → the MAC authenticates the annotation write.
    const form = await app.app.request(`/v/${pw.secret}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'text/html',
        'x-forwarded-for': nextIp()
      },
      body: 'password=reviewer-pass-9'
    });
    expect(form.status).toBe(303);
    const unlockCookie = extractCookie(form);
    const entry = await app.app.request(`/v/${pw.secret}`, {
      headers: { accept: 'text/html', cookie: unlockCookie }
    });
    expect(entry.status).toBe(200);
    const html = await entry.text();
    expect(html).toContain(OVERLAY_MARKER);
    const unlock = /"unlock":"([^"]+)"/.exec(html)?.[1];
    expect(unlock).toBeDefined();

    const viaMac = await overlayPost(
      pw.secret,
      { body: 'proof via MAC', selection: {} },
      { 'x-slideless-unlock': unlock! }
    );
    expect(viaMac.status).toBe(201);
    const listed = await overlayList(pw.secret, { 'x-slideless-unlock': unlock! });
    expect(listed.status).toBe(200);

    const viaPassword = await overlayPost(
      pw.secret,
      { body: 'proof via password', selection: {} },
      { 'x-viewer-password': 'reviewer-pass-9' }
    );
    expect(viaPassword.status).toBe(201);

    const wrong = await overlayPost(
      pw.secret,
      { body: 'x', selection: {} },
      { 'x-viewer-password': 'wrong-pass' }
    );
    expect(wrong.status).toBe(401);
    expect((await readJson(wrong)).error.code).toBe('password_invalid');
  });

  it('rate-limits creates per IP+token (429 after the bucket drains)', async () => {
    const { secret } = await createToken({ name: 'Spam', canAnnotate: true });
    const ip = nextIp(); // ONE fixed ip for the whole burst
    let limited = false;
    for (let i = 0; i < 65 && !limited; i++) {
      const res = await app.app.request(`/api/v1/viewer/${secret}/annotations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'null', 'x-forwarded-for': ip },
        body: JSON.stringify({ body: `spam ${i}`, selection: {} })
      });
      if (res.status === 429) limited = true;
      else expect(res.status).toBe(201);
    }
    expect(limited).toBe(true);
  });
});

// ═══ Owner/dev management surface ════════════════════════════════════════════

describe('owner/dev annotation management', () => {
  let annotationId: string;

  it('a signed-in principal creates a note (authorUserId set, shareTokenId null)', async () => {
    const res = await app.app.request(
      `/api/v1/presentations/${deckId}/annotations`,
      json({ version: 2, selection: { slide: 3 }, body: 'Owner note on v2' }, { cookie })
    );
    expect(res.status).toBe(201);
    const created = await readJson(res);
    expect(created.authorUserId).not.toBeNull();
    expect(created.shareTokenId).toBeNull();
    expect(created.authorName).toBe(OWNER.name);
    annotationId = created.id;

    const badVersion = await app.app.request(
      `/api/v1/presentations/${deckId}/annotations`,
      json({ version: 99, selection: {}, body: 'x' }, { cookie })
    );
    expect(badVersion.status).toBe(400);
  });

  it('filters by version and status', async () => {
    const v2 = await readJson(
      await app.app.request(`/api/v1/presentations/${deckId}/annotations?version=2`, { headers: { cookie } })
    );
    expect(v2.annotations.every((a: { version: number }) => a.version === 2)).toBe(true);
    expect(v2.annotations.some((a: { id: string }) => a.id === annotationId)).toBe(true);

    const resolved = await readJson(
      await app.app.request(`/api/v1/presentations/${deckId}/annotations?status=resolved`, {
        headers: { cookie }
      })
    );
    expect(resolved.annotations.some((a: { id: string }) => a.id === annotationId)).toBe(false);
  });

  it('resolves, then deletes; the inbox reflects both', async () => {
    const inboxBefore = await readJson(await app.app.request('/api/v1/annotations', { headers: { cookie } }));
    expect(inboxBefore.annotations.some((a: { id: string }) => a.id === annotationId)).toBe(true);

    const patched = await app.app.request(`/api/v1/presentations/${deckId}/annotations/${annotationId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ status: 'resolved' })
    });
    expect(patched.status).toBe(200);
    expect((await readJson(patched)).status).toBe('resolved');

    const resolvedList = await readJson(
      await app.app.request(`/api/v1/presentations/${deckId}/annotations?status=resolved`, {
        headers: { cookie }
      })
    );
    expect(resolvedList.annotations.some((a: { id: string }) => a.id === annotationId)).toBe(true);

    const deleted = await app.app.request(`/api/v1/presentations/${deckId}/annotations/${annotationId}`, {
      method: 'DELETE',
      headers: { cookie }
    });
    expect(deleted.status).toBe(200);

    const inboxAfter = await readJson(await app.app.request('/api/v1/annotations', { headers: { cookie } }));
    expect(inboxAfter.annotations.some((a: { id: string }) => a.id === annotationId)).toBe(false);
  });

  it('hides the deck’s annotation stream from a plain member (404, per the contract)', async () => {
    const invited = await readJson(
      await app.app.request(
        '/api/v1/invitations',
        json({ email: 'member@annot.test', role: 'member' }, { cookie })
      )
    );
    const accept = await app.app.request(
      '/api/v1/invitations/accept',
      json(
        { token: invited.acceptUrl.split('/invite/')[1], name: 'Member', password: 'member-pass-12345' },
        { 'x-forwarded-for': nextIp() }
      )
    );
    expect(accept.status).toBe(200);
    const memberCookie = extractCookie(
      await app.app.request(
        '/api/v1/auth/sign-in/email',
        json({ email: 'member@annot.test', password: 'member-pass-12345' })
      )
    );
    const res = await app.app.request(`/api/v1/presentations/${deckId}/annotations`, {
      headers: { cookie: memberCookie }
    });
    expect(res.status).toBe(404);
    // And the member's inbox shows nothing of this deck.
    const inbox = await readJson(
      await app.app.request('/api/v1/annotations', { headers: { cookie: memberCookie } })
    );
    expect(inbox.annotations).toHaveLength(0);
  });

  it('a machine key with presentations:read reads the deck stream + inbox; writes need presentations:write', async () => {
    const minted = await readJson(
      await app.app.request(
        '/api/v1/api-keys',
        json({ name: 'annot-ro', scopes: ['presentations:read'] }, { cookie })
      )
    );
    const list = await app.app.request(`/api/v1/presentations/${deckId}/annotations`, {
      headers: { authorization: `Bearer ${minted.key}` }
    });
    expect(list.status).toBe(200);
    const inbox = await app.app.request('/api/v1/annotations', {
      headers: { authorization: `Bearer ${minted.key}` }
    });
    expect(inbox.status).toBe(200);
    const write = await app.app.request(
      `/api/v1/presentations/${deckId}/annotations`,
      json({ version: 1, selection: {}, body: 'x' }, { authorization: `Bearer ${minted.key}` })
    );
    expect(write.status).toBe(403);
    expect((await readJson(write)).error.code).toBe('insufficient_scope');
  });
});
