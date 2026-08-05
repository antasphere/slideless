import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  createDatabase,
  createTestApp,
  extractCookie,
  readJson,
  startPostgres,
  type TestApp
} from './helpers.js';

/**
 * The PRDCT-1374 / PRDCT-1375 battery, driven against the REAL booted app.
 *
 * The slideless-specific care, and the whole reason this file is not a copy of
 * the hub's: this instance has TWO public surfaces the cross-site gate must
 * NOT touch —
 *
 *  - the share-link viewer (`/v/:secret`, mounted on the ROOT app), which is
 *    deliberately embeddable cross-origin (ADR 021 + /embed.js), password-form
 *    POST included;
 *  - `/api/v1/viewer/*`, the share-token annotation API, called by the overlay
 *    client from inside the sandboxed iframe whose Origin is the opaque
 *    `null`.
 *
 * Neither is cookie-authenticated — the share secret in the path IS the
 * credential — so neither is the ambient-credential class BROW-2 closes, and
 * refusing them would break embeds and annotations outright. Both are asserted
 * open below so a future tightening of the guard fails here first.
 */

const OWNER = { email: 'owner@hard.test', name: 'Hard Owner', password: 'hard-owner-password-123' };
const NUL = '\u0000';

const HTML = Buffer.from('<!doctype html><html><body><h1>deck</h1></body></html>');
const shaOf = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

let container: StartedPostgreSqlContainer;
let app: TestApp;
let httpsApp: TestApp;
let dcrOffApp: TestApp;
let cookie: string;
let deckId: string;
let shareSecret: string;

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body)
});

const nest = (depth: number) => '['.repeat(depth) + '1' + ']'.repeat(depth);

beforeAll(async () => {
  container = await startPostgres();
  app = await createTestApp(await createDatabase(container, 'hardening'));
  await app.app.request('/api/v1/setup', json({ instanceName: 'Hard', owner: OWNER }));
  const signIn = await app.app.request(
    '/api/v1/auth/sign-in/email',
    json({ email: OWNER.email, password: OWNER.password })
  );
  cookie = extractCookie(signIn);

  // Every step is asserted. A silently-broken fixture would leave `shareSecret`
  // undefined, and then every viewer assertion below would pass VACUOUSLY on a
  // 404 (which is both "not 403" and "4xx"). This bit us once already.
  const form = new FormData();
  form.set('sha256', shaOf(HTML));
  form.set('file', new Blob([new Uint8Array(HTML)], { type: 'text/html' }), 'index.html');
  const asset = await app.app.request('/api/v1/presentations/assets', {
    method: 'POST',
    headers: { cookie },
    body: form
  });
  expect(asset.status).toBe(201);

  const reserveRes = await app.app.request('/api/v1/presentations/uploads', {
    method: 'POST',
    headers: { cookie }
  });
  expect(reserveRes.status).toBeLessThan(300);
  const reserve = await readJson(reserveRes);
  deckId = reserve.uploadSession.presentationId;
  const commit = await app.app.request(
    `/api/v1/presentations/uploads/${reserve.uploadSession.id}/commit`,
    json(
      {
        title: 'Hard Deck',
        entryPath: 'index.html',
        manifest: [
          { path: 'index.html', sha256: shaOf(HTML), sizeBytes: HTML.length, contentType: 'text/html' }
        ]
      },
      { cookie }
    )
  );
  expect(commit.status).toBe(201);

  const mintRes = await app.app.request(
    `/api/v1/presentations/${deckId}/tokens`,
    json({ name: 'Hardening link', canAnnotate: true }, { cookie })
  );
  expect(mintRes.status).toBe(201);
  shareSecret = (await readJson(mintRes)).secret;
  expect(typeof shareSecret).toBe('string');
  expect(shareSecret.length).toBeGreaterThan(20);

  httpsApp = await createTestApp(await createDatabase(container, 'hardening_https'), {
    PUBLIC_BASE_URL: 'https://secure.example'
  });
  dcrOffApp = await createTestApp(await createDatabase(container, 'hardening_dcr_off'), {
    OAUTH_DYNAMIC_CLIENT_REGISTRATION: 'false'
  });
}, 240_000);

/** RFC 7591 dynamic client registration — the PLT-29 switch's only sink. */
const registerClient = (target: TestApp) =>
  target.app.request('/api/v1/auth/oauth2/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'plt-29-probe',
      redirect_uris: ['https://plt29.example/cb'],
      grant_types: ['authorization_code'],
      response_types: ['code']
    })
  });

afterAll(async () => {
  await app?.stop();
  await dcrOffApp?.stop();
  await httpsApp?.stop();
  await container?.stop();
});

// ── BROW-2 ──────────────────────────────────────────────────────────────────

describe('cross-site writes are refused before the handler', () => {
  const createKey = (headers: Record<string, string>) =>
    app.app.request('/api/v1/api-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, ...headers },
      body: JSON.stringify({ name: 'csrf-probe', scopes: ['presentations:read'] })
    });

  it('rejects a credentialed POST whose Sec-Fetch-Site is cross-site, and creates nothing', async () => {
    const before = await readJson(await app.app.request('/api/v1/api-keys', { headers: { cookie } }));
    const res = await createKey({ 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect((await readJson(res)).error.code).toBe('cross_site_forbidden');
    const after = await readJson(await app.app.request('/api/v1/api-keys', { headers: { cookie } }));
    expect(after.apiKeys.length).toBe(before.apiKeys.length);
  });

  it('rejects an untrusted Origin with no Sec-Fetch metadata', async () => {
    const res = await createKey({ origin: 'https://evil.example' });
    expect(res.status).toBe(403);
  });

  it('rejects a cross-site deck rename, and the title is unchanged', async () => {
    const res = await app.app.request(`/api/v1/presentations/${deckId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie, 'sec-fetch-site': 'cross-site' },
      body: JSON.stringify({ title: 'pwned' })
    });
    expect(res.status).toBe(403);
    const deck = await readJson(
      await app.app.request(`/api/v1/presentations/${deckId}`, { headers: { cookie } })
    );
    expect(JSON.stringify(deck)).not.toContain('pwned');
  });

  it('rejects a cross-site share-token mint — the capability-granting write', async () => {
    const res = await app.app.request(
      `/api/v1/presentations/${deckId}/tokens`,
      json({ name: 'stolen link' }, { cookie, 'sec-fetch-site': 'cross-site' })
    );
    expect(res.status).toBe(403);
  });

  it('rejects a cross-site sign-in POST (login CSRF / session fixation)', async () => {
    const res = await app.app.request(
      '/api/v1/auth/sign-in/email',
      json({ email: OWNER.email, password: OWNER.password }, { origin: 'https://evil.example' })
    );
    expect(res.status).toBe(403);
  });

  it('lets the dashboard through: same-origin POST', async () => {
    const res = await createKey({ origin: 'http://localhost', 'sec-fetch-site': 'same-origin' });
    expect(res.status).toBe(201);
  });

  it('never refuses a bearer-authenticated call, whatever origin it claims', async () => {
    const res = await app.app.request(
      '/api/v1/presentations/uploads',
      json(
        {},
        {
          authorization: 'Bearer sl_definitely_not_valid',
          origin: 'https://x.example',
          'sec-fetch-site': 'cross-site'
        }
      )
    );
    expect(res.status).not.toBe(403);
  });

  it('leaves the share-token annotation API open to the opaque iframe origin', async () => {
    const res = await app.app.request(`/api/v1/viewer/${shareSecret}/annotations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'null', 'sec-fetch-site': 'cross-site' },
      body: JSON.stringify({ body: 'a note from the sandboxed overlay', selection: {} })
    });
    // 201, not merely "not 403": a 404 from a broken fixture is also "not 403",
    // and asserting the weak form once made this whole block vacuous.
    expect(res.status).toBe(201);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('leaves its CORS preflight answerable from any origin', async () => {
    const res = await app.app.request(`/api/v1/viewer/${shareSecret}/annotations`, {
      method: 'OPTIONS',
      headers: { origin: 'https://embedder.example', 'sec-fetch-site': 'cross-site' }
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('leaves the embeddable viewer (root-mounted) untouched, POST included', async () => {
    const get = await app.app.request(`/v/${shareSecret}/`, {
      headers: { 'sec-fetch-site': 'cross-site', origin: 'https://embedder.example' }
    });
    expect(get.status).toBe(200);
    expect(await get.text()).toContain('deck');
    // The password form is submitted from inside an embed too.
    const post = await app.app.request(`/v/${shareSecret}/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'sec-fetch-site': 'cross-site',
        origin: 'https://embedder.example'
      },
      body: 'password=whatever'
    });
    expect(post.status).not.toBe(403);
  });
});

// ── PLT-3 ───────────────────────────────────────────────────────────────────

describe('the OpenAPI document', () => {
  it('serves the same cacheable buffer on every hit, and stays responsive under a burst', async () => {
    const responses = await Promise.all(
      Array.from({ length: 50 }, () => app.app.request('/api/v1/openapi.json'))
    );
    const bodies = await Promise.all(responses.map((r) => r.text()));
    for (const r of responses) {
      expect(r.status).toBe(200);
      expect(r.headers.get('cache-control')).toBe('public, max-age=300');
    }
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0]!)).toMatchObject({
      openapi: expect.any(String),
      paths: expect.any(Object)
    });
    const health = await app.app.request('/healthz');
    expect(health.status).toBe(200);
  });
});

// ── SL-B4 / SL-B5 ───────────────────────────────────────────────────────────

describe('malformed input from an ANONYMOUS client is 4xx, never 5xx', () => {
  const cases: Array<[string, () => Response | Promise<Response>, string]> = [
    [
      'NUL in the setup instance name',
      () => app.app.request('/api/v1/setup', json({ instanceName: `Acme${NUL}`, owner: OWNER })),
      'validation_error'
    ],
    [
      'NUL in the invitation accept name',
      () =>
        app.app.request(
          '/api/v1/invitations/accept',
          json({ token: 'x'.repeat(20), name: `Ann${NUL}`, password: 'correct horse battery' })
        ),
      'validation_error'
    ],
    [
      'NUL in the CLI key name',
      () =>
        app.app.request(
          '/api/v1/cli/auth/complete',
          json({ email: 'a@b.io', otp: '123456', keyName: `laptop${NUL}` })
        ),
      'validation_error'
    ],
    [
      'deeply nested JSON on a public route',
      () =>
        app.app.request('/api/v1/setup', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: nest(6000)
        }),
      'payload_too_deep'
    ],
    [
      'deeply nested JSON on the credential surface',
      () =>
        app.app.request('/api/v1/auth/sign-in/email', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: nest(6000)
        }),
      'payload_too_deep'
    ],
    [
      'deeply nested JSON on the anonymous share-token annotation API',
      () =>
        app.app.request(`/api/v1/viewer/${shareSecret}/annotations`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: nest(6000)
        }),
      'payload_too_deep'
    ]
  ];

  for (const [label, run, expectedCode] of cases) {
    it(label, async () => {
      const res = await run();
      // The specific status AND code: a bare "4xx" would be satisfied by a 404
      // or a 410 that never reached validation at all, which makes the case
      // prove nothing about the fix.
      expect(res.status).toBe(400);
      expect((await readJson(res)).error.code).toBe(expectedCode);
    });
  }

  /**
   * The most anonymously-reachable free-text write on the whole instance: a
   * share-link reviewer needs no account at all. Its schema is INLINE in
   * viewer/annotations-api.ts, NOT the contract's — so the contract-level
   * plainText sweep does not reach it, which is exactly why it is asserted
   * separately here.
   */
  it('NUL in an anonymous annotation body is a clean 4xx, not a database 500', async () => {
    const res = await app.app.request(`/api/v1/viewer/${shareSecret}/annotations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: `note${NUL}`, selection: {} })
    });
    // 400 specifically. "4xx" would also be satisfied by the 404 a wrong share
    // secret produces, which is exactly how this assertion can go vacuous.
    expect(res.status).toBe(400);
    // And the identical request WITHOUT the NUL succeeds — so the 400 is the
    // NUL, not the route being broken.
    const ok = await app.app.request(`/api/v1/viewer/${shareSecret}/annotations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'note', selection: {} })
    });
    expect(ok.status).toBe(201);
  });

  it('NUL in the anonymous reviewer display name is a clean 4xx too', async () => {
    const res = await app.app.request(`/api/v1/viewer/${shareSecret}/annotations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'fine', authorName: `Ann${NUL}`, selection: {} })
    });
    expect(res.status).toBe(400);
    const ok = await app.app.request(`/api/v1/viewer/${shareSecret}/annotations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'fine', authorName: 'Ann', selection: {} })
    });
    expect(ok.status).toBe(201);
  });

  it('NUL in a deck title is a clean 400', async () => {
    const res = await app.app.request(`/api/v1/presentations/${deckId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ title: `Deck${NUL}` })
    });
    expect(res.status).toBe(400);
  });

  it('deep JSON on an authenticated route is 400 payload_too_deep', async () => {
    const res = await app.app.request('/api/v1/api-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: nest(6000)
    });
    expect(res.status).toBe(400);
    expect((await readJson(res)).error.code).toBe('payload_too_deep');
  });
});

// ── DASH-5 + PLT-28 ─────────────────────────────────────────────────────────

describe('response headers', () => {
  it('marks authenticated JSON no-store', async () => {
    const res = await app.app.request('/api/v1/me', { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('marks the deck listing no-store too', async () => {
    const res = await app.app.request('/api/v1/presentations', { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('sends HSTS when the instance declares an https public origin', async () => {
    const res = await httpsApp.app.request('/healthz');
    expect(res.headers.get('strict-transport-security')).toBe('max-age=15552000; includeSubDomains');
  });

  it('sends no HSTS on an http instance (a browser would ignore it anyway)', async () => {
    const res = await app.app.request('/healthz');
    expect(res.headers.get('strict-transport-security')).toBeNull();
  });
});

// ── PLT-39 ──────────────────────────────────────────────────────────────────

describe('HEAD on file content', () => {
  it('answers the metadata headers with no body — the headOnly path really runs', async () => {
    const upload = await app.app.request('/api/v1/files?name=head-probe.txt', {
      method: 'POST',
      headers: { 'content-type': 'text/plain', cookie },
      body: 'hello head'
    });
    expect(upload.status).toBe(201);
    const fileId = (await readJson(upload)).file.id;

    const head = await app.app.request(`/api/v1/files/${fileId}/content`, {
      method: 'HEAD',
      headers: { cookie }
    });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe('10');
    expect(await head.text()).toBe('');

    const get = await app.app.request(`/api/v1/files/${fileId}/content`, { headers: { cookie } });
    expect(await get.text()).toBe('hello head');
  });
});

// ── AF-4 ────────────────────────────────────────────────────────────────────

describe('the login wall no longer bills successful sign-ins to the account', () => {
  it('lets one account sign in far past the bucket size from one IP', async () => {
    for (let i = 0; i < 15; i++) {
      const res = await app.app.request(
        '/api/v1/auth/sign-in/email',
        json({ email: OWNER.email, password: OWNER.password }, { 'x-forwarded-for': '198.51.100.7' })
      );
      expect(res.status).toBe(200);
    }
  });

  it('still walls off a brute-force run on the same account', async () => {
    let sawRateLimit = false;
    for (let i = 0; i < 15 && !sawRateLimit; i++) {
      const res = await app.app.request(
        '/api/v1/auth/sign-in/email',
        json({ email: 'brute@hard.test', password: `guess-${i}` }, { 'x-forwarded-for': '198.51.100.8' })
      );
      if (res.status === 429) sawRateLimit = true;
    }
    expect(sawRateLimit).toBe(true);
  });
});

// ── PLT-29 ──────────────────────────────────────────────────────────────────

/**
 * The switch has to DO something. `env.test.ts` only proves the variable
 * parses and defaults to true — with that as the whole coverage, replacing
 * `env.OAUTH_DYNAMIC_CLIENT_REGISTRATION` in identity/better-auth.ts with a
 * hardcoded `true` leaves the entire suite green (verified by mutation), i.e.
 * an operator setting it to false would get no protection and no warning.
 * These two cases pin the wiring at the endpoint, in both positions.
 */
describe('dynamic client registration honours the env switch', () => {
  it('mints a client with the default (unchanged) posture', async () => {
    const res = await registerClient(app);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { client_id?: string }).client_id).toBeTruthy();
  });

  it('refuses every caller when the switch is off', async () => {
    const res = await registerClient(dcrOffApp);
    expect(res.status).toBe(403);
    expect((await res.json()) as { error?: string }).toMatchObject({ error: 'access_denied' });
  });
});
