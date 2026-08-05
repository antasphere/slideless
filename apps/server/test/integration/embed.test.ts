import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { VIEWER_IFRAME_SANDBOX } from '@slideless/contract';
import { EMBED_JS_SOURCE } from '../../src/viewer/embed.js';
import {
  createDatabase,
  createTestApp,
  extractCookie,
  readJson,
  startPostgres,
  type TestApp
} from './helpers.js';

/**
 * PRDCT-1312 — the official embed loader + the viewer framing policy
 * (ADR 021):
 *
 *  - GET /embed.js is public static JS: anonymous, correct content-type,
 *    nosniff, cache-friendly (max-age + ETag/304);
 *  - the loader's sandbox attribute set is EXACTLY the contract's
 *    VIEWER_IFRAME_SANDBOX (the drift pin — embed.js templates the constant
 *    in, this test fails if the served bytes ever say otherwise);
 *  - framing policy: deck bytes stay frameable (no frame-ancestors, no
 *    X-Frame-Options — that IS the embed feature), while the first-party
 *    password gate stays frame-blocked (frame-ancestors 'none').
 */

const OWNER = { email: 'owner@embed.test', name: 'Embed Owner', password: 'embed-owner-password-1' };

const HTML = Buffer.from('<!doctype html><html><body><h1>Embed deck marker</h1></body></html>');
const shaOf = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

let container: StartedPostgreSqlContainer;
let app: TestApp;
let cookie: string;
let deckId: string;
let secret: string;

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body)
});

beforeAll(async () => {
  container = await startPostgres();
  app = await createTestApp(await createDatabase(container, 'embed'));
  await app.app.request('/api/v1/setup', json({ instanceName: 'Embed', owner: OWNER }));
  const signIn = await app.app.request(
    '/api/v1/auth/sign-in/email',
    json({ email: OWNER.email, password: OWNER.password })
  );
  cookie = extractCookie(signIn);

  const reserve = await readJson(
    await app.app.request('/api/v1/presentations/uploads', { method: 'POST', headers: { cookie } })
  );
  deckId = reserve.uploadSession.presentationId;
  const form = new FormData();
  form.set('sha256', shaOf(HTML));
  form.set('file', new Blob([new Uint8Array(HTML)], { type: 'text/html' }), 'index.html');
  const upload = await app.app.request('/api/v1/presentations/assets', {
    method: 'POST',
    headers: { cookie },
    body: form
  });
  expect(upload.status).toBe(201);
  const commit = await app.app.request(
    `/api/v1/presentations/uploads/${reserve.uploadSession.id}/commit`,
    json(
      {
        title: 'Embed Deck',
        entryPath: 'index.html',
        manifest: [
          { path: 'index.html', sha256: shaOf(HTML), sizeBytes: HTML.length, contentType: 'text/html' }
        ]
      },
      { cookie }
    )
  );
  expect(commit.status).toBe(201);

  const token = await app.app.request(
    `/api/v1/presentations/${deckId}/tokens`,
    json({ name: 'Embed' }, { cookie })
  );
  expect(token.status).toBe(201);
  secret = (await readJson(token)).secret;
}, 120_000);

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

describe('GET /embed.js (the official embed loader)', () => {
  it('serves the loader anonymously with the right static-JS header set', async () => {
    const res = await app.app.request('/embed.js'); // no session, no key, no cookie
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
    expect(res.headers.get('etag')).toMatch(/^"[0-9a-f]{32}"$/);
    expect(await res.text()).toBe(EMBED_JS_SOURCE);
  });

  it('revalidates cheaply: If-None-Match answers 304, HEAD answers empty 200', async () => {
    const first = await app.app.request('/embed.js');
    const etag = first.headers.get('etag')!;
    const cached = await app.app.request('/embed.js', { headers: { 'if-none-match': etag } });
    expect(cached.status).toBe(304);
    expect(await cached.text()).toBe('');

    const head = await app.app.request('/embed.js', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(await head.text()).toBe('');
  });

  it('DRIFT PIN: the loader carries exactly the contract sandbox set (ADR 012 Surface D)', async () => {
    const body = await (await app.app.request('/embed.js')).text();
    // The one place the loader states its sandbox — must be the contract
    // constant verbatim. If someone edits the attrs in embed.ts without
    // going through the contract, this fails.
    expect(body).toContain(`var SANDBOX = '${VIEWER_IFRAME_SANDBOX}';`);
    // And the constant itself must never regress the two fatal tokens.
    expect(VIEWER_IFRAME_SANDBOX).not.toContain('allow-same-origin');
    expect(VIEWER_IFRAME_SANDBOX).not.toContain('allow-top-navigation');
    expect(body).not.toContain('allow-same-origin');
    expect(body).not.toContain('allow-top-navigation');
  });
});

describe('framing policy (ADR 021)', () => {
  it('deck bytes stay frameable: no frame-ancestors, no X-Frame-Options on the entry', async () => {
    const res = await app.app.request(`/v/${secret}/`);
    expect(res.status).toBe(200);
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain('sandbox'); // the ADR 012 regime is still on…
    expect(csp).not.toContain('frame-ancestors'); // …and framing stays open
    expect(res.headers.get('x-frame-options')).toBeNull();
  });

  it('the password gate stays frame-blocked (first-party shell, never embeddable)', async () => {
    const gated = await app.app.request(
      `/api/v1/presentations/${deckId}/tokens`,
      json({ name: 'Gated', password: 'embed-gate-pw-1' }, { cookie })
    );
    expect(gated.status).toBe(201);
    const gatedSecret = (await readJson(gated)).secret;

    const challenge = await app.app.request(`/v/${gatedSecret}/`, {
      headers: { accept: 'text/html' }
    });
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });
});
