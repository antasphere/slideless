import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { hostGate, isViewerHostPath } from '../../src/middleware/host-gate.js';

/**
 * PRDCT-1352 (VIEW-2): with VIEWER_BASE_URL set, the viewer hostname must
 * serve ONLY deck content and the token-authed viewer API, and the app
 * hostname must not serve decks. Routing was host-agnostic before, so the
 * "separate origin" was a share-URL cosmetic: the viewer hostname answered the
 * dashboard, /api/v1, /mcp and Better Auth too.
 */
const VIEWER = 'https://decks.example.net';
const APP = 'https://app.example.com';

function app(): Hono {
  const root = new Hono();
  root.use('*', hostGate({ viewerBaseUrl: VIEWER }));
  root.get('/healthz', (c) => c.text('ok'));
  root.get('/readyz', (c) => c.text('ok'));
  root.all('/api/v1/*', (c) => c.json({ api: c.req.path }));
  root.all('/mcp', (c) => c.json({ mcp: true }));
  root.get('/embed.js', (c) => c.text('loader'));
  root.all('/v/:secret', (c) => c.text('entry ' + c.req.method));
  root.all('/v/:secret/*', (c) => c.text('asset'));
  root.get('*', (c) => c.html('<h1>spa</h1>'));
  return root;
}

const on = (origin: string, path: string, init?: RequestInit) => app().request(origin + path, init);

describe('hostGate — the viewer hostname', () => {
  it('serves the deck entry, its assets and the password form', async () => {
    expect((await on(VIEWER, '/v/secret123')).status).toBe(200);
    expect((await on(VIEWER, '/v/secret123/')).status).toBe(200);
    expect((await on(VIEWER, '/v/secret123/slides/1.html')).status).toBe(200);
    expect((await on(VIEWER, '/v/secret123', { method: 'POST' })).status).toBe(200);
  });

  it('serves the token-authed viewer API the deck runtime calls relative to its page', async () => {
    const res = await on(VIEWER, '/api/v1/viewer/secret123/annotations', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ api: '/api/v1/viewer/secret123/annotations' });
  });

  it('answers the operator probes', async () => {
    expect((await on(VIEWER, '/healthz')).status).toBe(200);
    expect((await on(VIEWER, '/readyz')).status).toBe(200);
  });

  it('answers 404 on the dashboard, the rest of /api/v1, auth, /mcp and /embed.js', async () => {
    for (const path of [
      '/',
      '/decks',
      '/api/v1/me',
      '/api/v1/presentations',
      '/api/v1/auth/sign-in/email',
      '/api/v1/auth/get-session',
      '/api/v1/viewer', // the bare prefix, not the API under it
      '/v', // the bare deck prefix routes nothing — the SPA shell must not answer here
      '/v/',
      '/api/v1/viewerish/x', // a prefix must match on the path boundary
      '/mcp',
      '/embed.js',
      '/vanity' // not /v/
    ]) {
      const res = await on(VIEWER, path, { method: path.startsWith('/api') ? 'POST' : 'GET' });
      expect(res.status, path).toBe(404);
      expect(await res.json(), path).toMatchObject({ error: { code: 'not_found' } });
    }
  });

  it('matches the host case-insensitively and with the port', async () => {
    const root = new Hono();
    root.use('*', hostGate({ viewerBaseUrl: 'http://Decks.Example.net:8080' }));
    root.get('*', (c) => c.text('served'));
    expect((await root.request('http://decks.example.net:8080/api/v1/me')).status).toBe(404);
    // A different port is a different host: gate does not apply, /v/ redirects.
    const other = await root.request('http://decks.example.net/v/abc');
    expect(other.status).toBe(308);
    expect(other.headers.get('location')).toBe('http://decks.example.net:8080/v/abc');
  });
});

describe('hostGate — every other hostname', () => {
  it('redirects a deck GET/HEAD to the viewer origin, path and query preserved', async () => {
    const res = await on(APP, '/v/secret123/slides/1.html?p=mail');
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe(`${VIEWER}/v/secret123/slides/1.html?p=mail`);
    const head = await on(APP, '/v/secret123', { method: 'HEAD' });
    expect(head.status).toBe(308);
  });

  it('never redirects a body-carrying method to the viewer origin — 404 instead', async () => {
    const res = await on(APP, '/v/secret123', { method: 'POST', body: 'password=x' });
    expect(res.status).toBe(404);
    expect(res.headers.get('location')).toBeNull();
  });

  it('serves everything else untouched (app, localhost, a preview host)', async () => {
    expect((await on(APP, '/api/v1/me')).status).toBe(200);
    expect((await on(APP, '/embed.js')).status).toBe(200);
    expect((await on(APP, '/')).status).toBe(200);
    expect((await on('http://localhost:3000', '/api/v1/me')).status).toBe(200);
    expect((await on('http://localhost:3000', '/vanity')).status).toBe(200);
  });

  it('keeps the token-authed viewer API reachable on the app hostname too', async () => {
    // Nothing cookie-authed lives there, and same-origin callers (tests,
    // SDK-driven annotation tooling) never went through the viewer hostname.
    expect((await on(APP, '/api/v1/viewer/secret123/badge')).status).toBe(200);
  });
});

describe('hostGate — the host is the Host header, never X-Forwarded-Host', () => {
  it('ignores a client-supplied X-Forwarded-Host in both directions', async () => {
    // Forged towards the viewer host: the app host keeps serving the app.
    const spoofedIn = await on(APP, '/api/v1/me', { headers: { 'x-forwarded-host': 'decks.example.net' } });
    expect(spoofedIn.status).toBe(200);
    // Forged away from the viewer host: the viewer host keeps refusing.
    const spoofedOut = await on(VIEWER, '/api/v1/me', { headers: { 'x-forwarded-host': 'app.example.com' } });
    expect(spoofedOut.status).toBe(404);
  });
});

describe('isViewerHostPath', () => {
  it('is a boundary-aware prefix match', () => {
    expect(isViewerHostPath('/v')).toBe(false); // routes nothing; the SPA fallback would answer
    expect(isViewerHostPath('/v/')).toBe(false);
    expect(isViewerHostPath('/v/x')).toBe(true);
    expect(isViewerHostPath('/vx')).toBe(false);
    expect(isViewerHostPath('/api/v1/viewer/x/forms/f/responses')).toBe(true);
    expect(isViewerHostPath('/api/v1/viewer')).toBe(false); // bare prefix routes nothing
    expect(isViewerHostPath('/api/v1/viewer/')).toBe(true);
    expect(isViewerHostPath('/api/v1/viewers')).toBe(false);
    expect(isViewerHostPath('/api/v1/presentations')).toBe(false);
    expect(isViewerHostPath('/healthz')).toBe(true);
    expect(isViewerHostPath('/healthz/')).toBe(false);
  });
});
