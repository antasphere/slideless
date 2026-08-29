import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { VIEWER_CSP } from '../../src/viewer/routes.js';
import {
  SETUP_TOKEN,
  createDatabase,
  createTestApp,
  extractCookie,
  readJson,
  startPostgres,
  type TestApp
} from './helpers.js';

/**
 * PRDCT-1352 — the viewer origin as a REAL boundary, against the booted app.
 *
 * Two instances: `split` boots with VIEWER_BASE_URL on a second hostname,
 * `plain` boots without it. On `split` the viewer hostname serves only decks
 * and the token-authed viewer API, the app hostname refuses to serve decks
 * (redirects), and the app API refuses any request carrying the viewer
 * origin — or any foreign origin — while same-origin dashboard traffic and
 * deck serving keep working. On `plain` nothing changes from today: single
 * origin, no gate, no redirect, no frame-src widening.
 *
 * Every request is addressed with an ABSOLUTE URL so the hostname is the
 * thing under test (a relative `app.request(path)` lands on localhost).
 */

const APP = 'http://localhost:3000';
const VIEWER = 'http://decks.test';
const EVIL = 'https://evil.example';
const OWNER = { email: 'owner@origin.test', name: 'Origin Owner', password: 'origin-owner-password-123' };

const HTML = Buffer.from('<!doctype html><html><body><h1>deck</h1><p>Annotate me</p></body></html>');
const CSS = Buffer.from('h1 { color: teal }');
const shaOf = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

interface Fixture {
  app: TestApp;
  cookie: string;
  deckId: string;
  secret: string;
}

let container: StartedPostgreSqlContainer;
let split: Fixture;
let plain: Fixture;

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body)
});

/** The dashboard's own traffic: same-origin, browser-set metadata present. */
const dashboard = (cookie: string) => ({ cookie, origin: APP, 'sec-fetch-site': 'same-origin' });

async function bootFixture(dbName: string, extraEnv: Record<string, string>): Promise<Fixture> {
  const app = await createTestApp(await createDatabase(container, dbName), extraEnv);
  const setup = await app.app.request(
    `${APP}/api/v1/setup`,
    json({ setupToken: SETUP_TOKEN, instanceName: 'Origin', owner: OWNER })
  );
  expect(setup.status).toBeLessThan(300);
  const signIn = await app.app.request(
    `${APP}/api/v1/auth/sign-in/email`,
    json({ email: OWNER.email, password: OWNER.password }, { origin: APP, 'sec-fetch-site': 'same-origin' })
  );
  expect(signIn.status).toBe(200);
  const cookie = extractCookie(signIn);

  const upload = async (bytes: Buffer, name: string, type: string) => {
    const form = new FormData();
    form.set('sha256', shaOf(bytes));
    form.set('file', new Blob([new Uint8Array(bytes)], { type }), name);
    const res = await app.app.request(`${APP}/api/v1/presentations/assets`, {
      method: 'POST',
      headers: dashboard(cookie),
      body: form
    });
    expect(res.status).toBe(201);
  };
  await upload(HTML, 'index.html', 'text/html');
  await upload(CSS, 'style.css', 'text/css');

  const reserveRes = await app.app.request(`${APP}/api/v1/presentations/uploads`, {
    method: 'POST',
    headers: dashboard(cookie)
  });
  expect(reserveRes.status).toBeLessThan(300);
  const reserve = await readJson(reserveRes);
  const deckId: string = reserve.uploadSession.presentationId;
  const commit = await app.app.request(
    `${APP}/api/v1/presentations/uploads/${reserve.uploadSession.id}/commit`,
    json(
      {
        title: 'Origin Deck',
        entryPath: 'index.html',
        manifest: [
          { path: 'index.html', sha256: shaOf(HTML), sizeBytes: HTML.length, contentType: 'text/html' },
          { path: 'style.css', sha256: shaOf(CSS), sizeBytes: CSS.length, contentType: 'text/css' }
        ]
      },
      dashboard(cookie)
    )
  );
  expect(commit.status).toBe(201);

  const mintRes = await app.app.request(
    `${APP}/api/v1/presentations/${deckId}/tokens`,
    json({ name: 'Origin link', canAnnotate: true }, dashboard(cookie))
  );
  expect(mintRes.status).toBe(201);
  const minted = await readJson(mintRes);
  expect(typeof minted.secret).toBe('string');
  expect(minted.secret.length).toBeGreaterThan(20);
  return { app, cookie, deckId, secret: minted.secret };
}

beforeAll(async () => {
  container = await startPostgres();
  split = await bootFixture('viewer_origin_split', { VIEWER_BASE_URL: VIEWER });
  plain = await bootFixture('viewer_origin_plain', {});
}, 240_000);

afterAll(async () => {
  await split?.app.stop();
  await plain?.app.stop();
  await container?.stop();
});

const mintOn = (f: Fixture, headers: Record<string, string>, base = APP) =>
  f.app.app.request(`${base}/api/v1/presentations/${f.deckId}/tokens`, json({ name: 'probe' }, headers));

const tokenCount = async (f: Fixture): Promise<number> => {
  const res = await f.app.app.request(`${APP}/api/v1/presentations/${f.deckId}/tokens`, {
    headers: dashboard(f.cookie)
  });
  expect(res.status).toBe(200);
  const body = await readJson(res);
  return body.shareTokens.length;
};

// ── VIEWER_BASE_URL set ─────────────────────────────────────────────────────

describe('split origin: share links are minted on the viewer origin', () => {
  it('builds the share URL on VIEWER_BASE_URL', async () => {
    const res = await mintOn(split, dashboard(split.cookie));
    expect(res.status).toBe(201);
    const created = await readJson(res);
    expect(created.url).toBe(`${VIEWER}/v/${created.secret}/`);
  });
});

describe('split origin: the app API refuses the viewer origin and any foreign origin', () => {
  it('refuses a credentialed write carrying the viewer Origin, cross-site — and creates nothing', async () => {
    const before = await tokenCount(split);
    const res = await mintOn(split, { cookie: split.cookie, origin: VIEWER, 'sec-fetch-site': 'cross-site' });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: 'cross_site_forbidden' } });
    expect(await tokenCount(split)).toBe(before);
  });

  it('refuses the viewer Origin even when a proxy presents it as same-site (sibling-subdomain shape)', async () => {
    const res = await mintOn(split, { cookie: split.cookie, origin: VIEWER, 'sec-fetch-site': 'same-site' });
    expect(res.status).toBe(403);
  });

  it('refuses the viewer Origin with no Sec-Fetch metadata at all', async () => {
    const res = await mintOn(split, { cookie: split.cookie, origin: VIEWER });
    expect(res.status).toBe(403);
  });

  it('refuses a foreign Origin', async () => {
    const res = await mintOn(split, { cookie: split.cookie, origin: EVIL, 'sec-fetch-site': 'cross-site' });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: 'cross_site_forbidden' } });
  });

  it('refuses the opaque `Origin: null` a sandboxed deck document would send', async () => {
    const res = await mintOn(split, { cookie: split.cookie, origin: 'null', 'sec-fetch-site': 'cross-site' });
    expect(res.status).toBe(403);
  });

  it('refuses a sign-in POST carrying the viewer Origin (no session can be minted for deck script)', async () => {
    const res = await split.app.app.request(
      `${APP}/api/v1/auth/sign-in/email`,
      json(
        { email: OWNER.email, password: OWNER.password },
        { origin: VIEWER, 'sec-fetch-site': 'cross-site' }
      )
    );
    expect(res.status).toBe(403);
    expect(res.headers.get('set-cookie')).toBeNull();
  });
});

describe('split origin: same-origin app traffic still works', () => {
  it('accepts the dashboard write: same-origin POST with the app Origin', async () => {
    const res = await mintOn(split, dashboard(split.cookie));
    expect(res.status).toBe(201);
  });

  it('accepts a bearer-less non-browser client (no Origin, no Sec-Fetch)', async () => {
    const res = await mintOn(split, { cookie: split.cookie });
    expect(res.status).toBe(201);
  });

  it('serves the dashboard shell on the app hostname with frame-src widened to the viewer origin only', async () => {
    const res = await split.app.app.request(`${APP}/`);
    expect(res.status).toBe(200);
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain(`frame-src 'self' ${VIEWER};`);
    expect(csp).toContain("connect-src 'self';");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain(`script-src 'self' ${VIEWER}`);
  });

  it('keeps the session readable on the app hostname', async () => {
    const res = await split.app.app.request(`${APP}/api/v1/me`, { headers: dashboard(split.cookie) });
    expect(res.status).toBe(200);
  });
});

describe('split origin: the viewer hostname serves decks — and nothing else', () => {
  it('serves the deck entry under the ADR 012 sandbox headers', async () => {
    const res = await split.app.app.request(`${VIEWER}/v/${split.secret}/`, {
      headers: { accept: 'text/html' }
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toBe(VIEWER_CSP);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(await res.text()).toContain('<h1>deck</h1>');
  });

  it('serves a deck asset', async () => {
    const res = await split.app.app.request(`${VIEWER}/v/${split.secret}/style.css`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toBe(VIEWER_CSP);
    expect(await res.text()).toBe(CSS.toString());
  });

  it('serves the token-authed viewer API the overlay calls relative to its page', async () => {
    const res = await split.app.app.request(`${VIEWER}/api/v1/viewer/${split.secret}/annotations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'null', 'sec-fetch-site': 'cross-site' },
      body: JSON.stringify({
        body: 'The intro chart is unclear',
        authorName: 'Alice',
        selection: { type: 'text', quote: 'Annotate me' },
        version: 1
      })
    });
    expect(res.status).toBe(201);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('answers the probes', async () => {
    expect((await split.app.app.request(`${VIEWER}/healthz`)).status).toBe(200);
  });

  it('does NOT serve the dashboard, the API, auth, /mcp, /embed.js or discovery — 404 before any handler', async () => {
    const cases: Array<[string, string]> = [
      ['GET', '/'],
      ['GET', '/decks'],
      ['GET', '/api/v1/me'],
      ['GET', '/api/v1/presentations'],
      ['POST', '/api/v1/presentations/uploads'],
      ['GET', '/api/v1/auth/get-session'],
      ['POST', '/api/v1/auth/sign-in/email'],
      ['POST', '/mcp'],
      ['GET', '/embed.js'],
      ['GET', '/.well-known/oauth-authorization-server'],
      ['GET', '/metrics']
    ];
    for (const [method, path] of cases) {
      const res = await split.app.app.request(`${VIEWER}${path}`, {
        method,
        // Even WITH the session cookie: the viewer hostname reads no session.
        headers: { cookie: split.cookie, origin: VIEWER, 'sec-fetch-site': 'same-origin' }
      });
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(await res.json(), `${method} ${path}`).toMatchObject({ error: { code: 'not_found' } });
      expect(res.headers.get('set-cookie'), `${method} ${path}`).toBeNull();
    }
  });

  it('cannot sign in on the viewer hostname, even with valid credentials', async () => {
    const res = await split.app.app.request(
      `${VIEWER}/api/v1/auth/sign-in/email`,
      json(
        { email: OWNER.email, password: OWNER.password },
        { origin: VIEWER, 'sec-fetch-site': 'same-origin' }
      )
    );
    expect(res.status).toBe(404);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('refuses the writes the guard closes when addressed to the viewer hostname with a session', async () => {
    // Belt (host gate) and braces (denied origin): whichever answers first,
    // the write never reaches a handler.
    const before = await tokenCount(split);
    const res = await mintOn(split, dashboard(split.cookie), VIEWER);
    expect([403, 404]).toContain(res.status);
    expect(await tokenCount(split)).toBe(before);
  });
});

describe('split origin: the app hostname no longer serves decks', () => {
  it('redirects a deck link on the app hostname to the viewer origin, path and query intact', async () => {
    const res = await split.app.app.request(`${APP}/v/${split.secret}/?p=mail`, { redirect: 'manual' });
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe(`${VIEWER}/v/${split.secret}/?p=mail`);
    expect(res.headers.get('content-security-policy')).not.toBe(VIEWER_CSP);
  });

  it('redirects an asset request too, and never serves the bytes on the app origin', async () => {
    const res = await split.app.app.request(`${APP}/v/${split.secret}/style.css`, { redirect: 'manual' });
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe(`${VIEWER}/v/${split.secret}/style.css`);
  });

  it('keeps /embed.js on the app origin (ADR 021)', async () => {
    const res = await split.app.app.request(`${APP}/embed.js`);
    expect(res.status).toBe(200);
  });
});

// ── VIEWER_BASE_URL unset ───────────────────────────────────────────────────

describe('single origin (VIEWER_BASE_URL unset): nothing changes', () => {
  it('mints share URLs on the app origin', async () => {
    const res = await mintOn(plain, dashboard(plain.cookie));
    expect(res.status).toBe(201);
    const created = await readJson(res);
    expect(created.url).toBe(`${APP}/v/${created.secret}/`);
  });

  it('serves the deck on the app origin under the sandbox headers, no redirect', async () => {
    const res = await plain.app.app.request(`${APP}/v/${plain.secret}/`, {
      headers: { accept: 'text/html' },
      redirect: 'manual'
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toBe(VIEWER_CSP);
    expect(await res.text()).toContain('<h1>deck</h1>');
  });

  it('installs no host gate: an unknown hostname is just the app (401, not 404, on a protected read)', async () => {
    const res = await plain.app.app.request(`${VIEWER}/api/v1/me`);
    expect(res.status).toBe(401);
    const spa = await plain.app.app.request(`${VIEWER}/`);
    expect(spa.status).toBe(200);
  });

  it("keeps the dashboard CSP at frame-src 'self'", async () => {
    const res = await plain.app.app.request(`${APP}/`);
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("frame-src 'self';");
    expect(csp).not.toContain('decks.test');
  });

  it('keeps the cross-site guard exactly as before: same-origin accepted, foreign refused, serving origin trusted', async () => {
    expect((await mintOn(plain, dashboard(plain.cookie))).status).toBe(201);
    const evil = await mintOn(plain, { cookie: plain.cookie, origin: EVIL, 'sec-fetch-site': 'cross-site' });
    expect(evil.status).toBe(403);
    // The serving-origin trust that dev proxies and previews rely on is intact.
    const preview = await mintOn(
      plain,
      { cookie: plain.cookie, origin: 'http://localhost:5173', 'sec-fetch-site': 'same-origin' },
      'http://localhost:5173'
    );
    expect(preview.status).toBe(201);
  });
});

// A VIEWER_BASE_URL on the public origin is refused by parseEnv (process exit
// with the fix named) — pinned at the schema level in test/unit/env.test.ts.
