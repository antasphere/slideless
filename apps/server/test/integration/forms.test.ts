import { createHash, createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import {
  auditLog,
  formResponseVersions,
  formResponses,
  presentations,
  presentationVersions,
  shareTokens
} from '@slideless/db';
import { deckMasterUrl } from '@slideless/contract';
import { VIEWER_CSP } from '../../src/viewer/routes.js';
import { FORMS_MARKER } from '../../src/viewer/forms-runtime.js';
import { FRAGMENT_CAPTURE_MARKER } from '../../src/viewer/inject.js';
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
 * ADR 022 — deck-embedded forms, end-to-end across all three surfaces:
 *
 *  - FORMS RUNTIME INJECTION: the served deck HTML carries the inline forms
 *    client exactly when (can_submit_forms × document OR frame navigation ×
 *    not ?raw / not agent-style), with the injected config stamping
 *    source/placement/emailAvailable — while ?raw, x-viewer-password
 *    fetches, and can_submit_forms=false links stay byte-exact;
 *  - the PUBLIC token-session write surface (/api/v1/viewer/…/forms/…):
 *    CORS, status mapping, capability + password proof, version integrity,
 *    payload caps, the one-time edit secret (read/update own row), the
 *    email leg via the recording driver, source/placement sanitization,
 *    the per-deck cap, and the spam bucket;
 *  - the OWNER management surface (/api/v1/presentations/{id}/responses):
 *    filters, keyset pagination, summary buckets, audited delete, member
 *    gating (404 on reads, 403 on delete), and the machine-scope split.
 */

const OWNER = { email: 'owner@forms.test', name: 'Forms Owner', password: 'forms-owner-pass-1' };

/** Must mirror createTestApp's AUTH_SECRET (helpers.ts) — the MAC key. */
const AUTH_SECRET = 'integration-test-secret-0123456789abcdef0123456789abcdef';

const HTML_V1 = Buffer.from(
  '<!doctype html><html><head><title>Deck</title></head><body>' +
    '<form data-slideless-form="rsvp"><input name="name"><input name="dish"></form>' +
    '<a href="guide/page2.html">next</a></body></html>'
);
const HTML_PAGE2 = Buffer.from(
  '<!doctype html><html><body><form data-slideless-form="feedback"><textarea name="note"></textarea></form></body></html>'
);
const HTML_V2 = Buffer.from('<!doctype html><html><body><h1>v2 content</h1></body></html>');
/** No marked form anywhere — PRDCT-1333's streaming-path regression pin. */
const HTML_NO_FORM = Buffer.from(
  '<!doctype html><html><head><title>Plain</title></head><body><h1>Just slides</h1></body></html>'
);
/** Two forms on one page — the cross-form corruption fixture (PRDCT-1334). */
const HTML_TWO_FORMS = Buffer.from(
  '<!doctype html><html><head></head><body>' +
    '<form data-slideless-form="rsvp"><input name="who"></form>' +
    '<form data-slideless-form="feedback"><input name="note"></form>' +
    '</body></html>'
);
/**
 * The external-bundle shape (PRDCT-1331/1334 residual): the page carries NO
 * marker, the bundled script injects the form at load. Detection that read
 * only HTML stamped this deck form-less and every submit stored nothing.
 */
const HTML_SHELL = Buffer.from(
  '<!doctype html><html><head><title>Shell</title></head><body><div id="deck"></div>' +
    '<script src="app.js"></script></body></html>'
);
const JS_BUNDLE = Buffer.from(
  "document.addEventListener('DOMContentLoaded',function(){" +
    'document.getElementById(\'deck\').innerHTML=\'<form data-slideless-form="bundled"><input name="note"></form>\';' +
    '});'
);
/** The marker's TEXT in a stylesheet: a stylesheet cannot author a form, so it must not arm the runtime. */
const CSS_DECOY = Buffer.from('/* data-slideless-form="decoy" */ body{margin:0}');
const shaOf = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const entryOf = (path: string, bytes: Buffer, contentType = 'text/html') => ({
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
let workspaceId: string;
let ownerUserId: string;

let ipCounter = 0;
const nextIp = () => `10.88.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body)
});

/** Simulates the injected runtime: cross-origin JSON POST from the opaque origin. */
const submit = (secret: string, form: string, body: unknown, headers: Record<string, string> = {}) =>
  app.app.request(`/api/v1/viewer/${secret}/forms/${form}/responses`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'null',
      'x-forwarded-for': nextIp(),
      ...headers
    },
    body: JSON.stringify(body)
  });

const getMe = (secret: string, form: string, headers: Record<string, string> = {}) =>
  app.app.request(`/api/v1/viewer/${secret}/forms/${form}/responses/me`, {
    headers: { origin: 'null', 'x-forwarded-for': nextIp(), ...headers }
  });

/** The form-agnostic resolve the runtime calls ONCE per page load with an arriving fragment secret. */
const resolveMe = (secret: string, headers: Record<string, string> = {}) =>
  app.app.request(`/api/v1/viewer/${secret}/forms/responses/me`, {
    headers: { origin: 'null', 'x-forwarded-for': nextIp(), ...headers }
  });

const putMe = (secret: string, form: string, body: unknown, headers: Record<string, string> = {}) =>
  app.app.request(`/api/v1/viewer/${secret}/forms/${form}/responses/me`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      origin: 'null',
      'x-forwarded-for': nextIp(),
      ...headers
    },
    body: JSON.stringify(body)
  });

const emailMe = (secret: string, form: string, body: unknown, headers: Record<string, string> = {}) =>
  app.app.request(`/api/v1/viewer/${secret}/forms/${form}/responses/me/email`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'null',
      'x-forwarded-for': nextIp(),
      ...headers
    },
    body: JSON.stringify(body)
  });

/**
 * Mints a link that does NOT remember its answers unless the body says so:
 * the suite below exercises the fragment-secret path, which is what every
 * link minted before PRDCT-2328 has, and its fixtures submit several rows
 * through one link. The contract default (remembering ON for a named link)
 * is pinned by its own test in the remembering block.
 */
async function createToken(
  body: Record<string, unknown>,
  deck: string = deckId
): Promise<{ secret: string; id: string }> {
  const res = await app.app.request(
    `/api/v1/presentations/${deck}/tokens`,
    json({ remembersResponses: false, ...body }, { cookie })
  );
  expect(res.status).toBe(201);
  const parsed = await readJson(res);
  return { secret: parsed.secret, id: parsed.shareToken.id };
}

const ownerDetail = async (deck: string, responseId: string) =>
  app.app.request(`/api/v1/presentations/${deck}/responses/${responseId}`, { headers: { cookie } });

/** The runtime's one probe per page load on a remembering link (PRDCT-2328). */
const remembered = (secret: string) =>
  app.app.request(`/api/v1/viewer/${secret}/forms/responses/remembered`, {
    headers: { origin: 'null', 'x-forwarded-for': nextIp() }
  });

/** The exact respondent wire (PRDCT-2329): never a revision, never a history, never an id beyond its own. */
const RESPONDENT_WIRE_KEYS = ['createdAt', 'formName', 'id', 'payload', 'updatedAt', 'version'];

const fetchEntry = (secret: string, headers: Record<string, string> = {}) =>
  app.app.request(`/v/${secret}/`, { headers: { accept: 'text/html', ...headers } });

const ownerList = async (deck: string, qs = '') =>
  readJson(await app.app.request(`/api/v1/presentations/${deck}/responses${qs}`, { headers: { cookie } }));

function expectSandboxHeaders(res: Response): void {
  expect(res.headers.get('content-security-policy')).toBe(VIEWER_CSP);
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  expect(res.headers.get('referrer-policy')).toBe('no-referrer');
}

async function uploadDeck(title: string, manifest: Array<ReturnType<typeof entryOf>>): Promise<string> {
  const reserve = await readJson(
    await app.app.request('/api/v1/presentations/uploads', { method: 'POST', headers: { cookie } })
  );
  const commit = await app.app.request(
    `/api/v1/presentations/uploads/${reserve.uploadSession.id}/commit`,
    json({ title, entryPath: 'index.html', manifest }, { cookie })
  );
  expect(commit.status).toBe(201);
  return reserve.uploadSession.presentationId;
}

beforeAll(async () => {
  container = await startPostgres();
  mail = new RecordingEmailDriver();
  app = await createTestApp(await createDatabase(container, 'forms_adr022'), {}, { email: mail });
  await app.app.request(
    '/api/v1/setup',
    json({ setupToken: 'integration-test-setup-token', instanceName: 'Forms', owner: OWNER })
  );
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
  await upload(HTML_PAGE2);
  await upload(HTML_V2);
  await upload(HTML_NO_FORM);
  await upload(HTML_TWO_FORMS);
  await upload(HTML_SHELL);
  await upload(JS_BUNDLE);
  await upload(CSS_DECOY);

  deckId = await uploadDeck('Forms Deck', [
    entryOf('index.html', HTML_V1),
    entryOf('guide/page2.html', HTML_PAGE2)
  ]);

  const me = await readJson(await app.app.request('/api/v1/me', { headers: { cookie } }));
  workspaceId = me.workspace.id;
  ownerUserId = me.user.id;
}, 120_000);

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

// ═══ Forms runtime injection ═════════════════════════════════════════════════

describe('forms runtime injection', () => {
  it('injects the runtime for a browser entry of a can_submit_forms token — sandbox headers intact, no ETag', async () => {
    const { secret } = await createToken({ name: 'Filler' }); // canSubmitForms defaults ON
    const res = await fetchEntry(secret);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(FORMS_MARKER);
    expect(html).not.toContain(OVERLAY_MARKER); // canAnnotate defaults off
    expect(html).toContain('data-slideless-form="rsvp"'); // the deck itself is untouched
    expect(html.toLowerCase().lastIndexOf('</body>')).toBeGreaterThan(html.indexOf(FORMS_MARKER));
    // The injected config: a direct link, no unlock, anonymous, mail available.
    expect(html).toContain('"source":"link"');
    expect(html).toContain('"unlock":null');
    // PRDCT-1331: the config carries no identity field of any kind.
    expect(html).not.toContain('assertion');
    expect(html).toContain('"emailAvailable":true');
    // PRDCT-1334 item 4: the early fragment stub runs before any deck script.
    expect(html).toContain(FRAGMENT_CAPTURE_MARKER);
    expect(html.indexOf(FRAGMENT_CAPTURE_MARKER)).toBeLessThan(html.indexOf(FORMS_MARKER));
    expect(html.indexOf(FRAGMENT_CAPTURE_MARKER)).toBeLessThan(html.indexOf('<form'));
    expect(html).toContain('"version":1');
    expectSandboxHeaders(res);
    expect(res.headers.get('etag')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('Sec-Fetch-Dest: iframe (the official embed) ALSO gets the runtime — source embed, overlay stays out', async () => {
    const { secret } = await createToken({ name: 'Embed Host', canAnnotate: true });
    const framed = await app.app.request(`/v/${secret}/?p=hero`, {
      headers: { accept: 'text/html', 'sec-fetch-dest': 'iframe' }
    });
    expect(framed.status).toBe(200);
    const html = await framed.text();
    expect(html).toContain(FORMS_MARKER);
    // ADR 021 policy holds: annotations never render in a frame, even for a
    // can-annotate link — only the forms runtime crosses into embeds.
    expect(html).not.toContain(OVERLAY_MARKER);
    expect(html).toContain('"source":"embed"');
    expect(html).toContain('"placement":"hero"');
    expect(html).not.toContain('assertion');
    expect(framed.headers.get('etag')).toBeNull();
    expectSandboxHeaders(framed);

    // Same for an HTML sub-page framed inside the embed (multi-page decks).
    const subFramed = await app.app.request(`/v/${secret}/guide/page2.html`, {
      headers: { accept: 'text/html', 'sec-fetch-dest': 'iframe' }
    });
    expect(subFramed.status).toBe(200);
    const subHtml = await subFramed.text();
    expect(subHtml).toContain(FORMS_MARKER);
    expect(subHtml).toContain('"source":"embed"');

    // An illegal ?p= label is sanitized to null at injection.
    const badLabel = await app.app.request(`/v/${secret}/?p=${encodeURIComponent('bad label!')}`, {
      headers: { accept: 'text/html', 'sec-fetch-dest': 'iframe' }
    });
    expect(await badLabel.text()).toContain('"placement":null');
  });

  it('?raw, agent password fetches, non-HTML accepts, and canSubmitForms=false stay byte-exact', async () => {
    const { secret } = await createToken({ name: 'Raw Check' });
    const raw = await app.app.request(`/v/${secret}/?raw`, { headers: { accept: 'text/html' } });
    expect(raw.status).toBe(200);
    expect(await raw.text()).not.toContain(FORMS_MARKER);
    expect(raw.headers.get('etag')).toBe(`"${shaOf(HTML_V1)}"`);

    const agent = await app.app.request(`/v/${secret}/`, { headers: { accept: '*/*' } });
    expect(agent.status).toBe(200);
    expect(await agent.text()).not.toContain(FORMS_MARKER);

    const pw = await createToken({ name: 'PW Agent', password: 'agent-pass-1' });
    const viaHeader = await app.app.request(`/v/${pw.secret}/`, {
      headers: { accept: 'text/html', 'x-viewer-password': 'agent-pass-1', 'x-forwarded-for': nextIp() }
    });
    expect(viaHeader.status).toBe(200);
    expect(await viaHeader.text()).not.toContain(FORMS_MARKER);
    expect(viaHeader.headers.get('etag')).toBe(`"${shaOf(HTML_V1)}"`);

    // showBar off too (PRDCT-2281): the recipient bar rides every browser
    // navigation by default, so the untransformed stream path on a browser
    // navigation is now the BARE link's. The forms pin is the marker.
    const noForms = await createToken({ name: 'No Forms', canSubmitForms: false, showBar: false });
    const plain = await fetchEntry(noForms.secret);
    expect(plain.status).toBe(200);
    expect(await plain.text()).not.toContain(FORMS_MARKER);
    // Untransformed entries keep streaming with their content-sha ETag.
    expect(plain.headers.get('etag')).toBe(`"${shaOf(HTML_V1)}"`);
    // With the bar on, a no-forms link still carries no forms runtime.
    const barred = await createToken({ name: 'No Forms, bar', canSubmitForms: false });
    expect(await (await fetchEntry(barred.secret)).text()).not.toContain(FORMS_MARKER);

    // Frame navigation of a no-forms token stays untouched too.
    const framed = await app.app.request(`/v/${noForms.secret}/`, {
      headers: { accept: 'text/html', 'sec-fetch-dest': 'iframe' }
    });
    expect(await framed.text()).not.toContain(FORMS_MARKER);
    expect(framed.headers.get('etag')).toBe(`"${shaOf(HTML_V1)}"`);
  });

  it('PRDCT-1331: a SIGNED-IN document navigation hands the deck nothing that identifies the viewer', async () => {
    const { secret, id: tokenId } = await createToken({ name: 'Signed-in' });
    const res = await fetchEntry(secret, { cookie });
    expect(res.status).toBe(200);
    const html = await res.text();
    const config = /<script data-slideless-forms>[\s\S]*?var CFG=(\{[^\n]*?\});/.exec(html)?.[1];
    expect(config).toBeDefined();
    // The injected config is a CLOSED set: version, unlock, source,
    // placement, emailAvailable, remembers. Anything else here is readable
    // by deck JS (ADR 012), which is exactly how leg 3 leaked a stranger's
    // identity. `remembers` (PRDCT-2328) is a BOOLEAN the deck could learn
    // by calling the remembered-answers route without a secret; it names
    // nobody and grants nothing the share secret in the URL does not.
    expect(Object.keys(JSON.parse(config!)).sort()).toEqual(
      ['emailAvailable', 'placement', 'remembers', 'source', 'unlock', 'version'].sort()
    );
    expect(JSON.parse(config!).remembers).toBe(false);
    // Nothing anywhere in the served document names the signed-in viewer.
    expect(html).not.toContain(ownerUserId);
    expect(html).not.toContain(OWNER.email);

    // …and no auto-mail fires on create for a signed-in viewer (the leg-3
    // mail never consulted the email limiter: 12 replays were 12 mails).
    const before = mail.sent.length;
    const created = await submit(secret, 'rsvp', { payload: { name: 'me' } }, { cookie });
    expect(created.status).toBe(201);
    expect((await readJson(created)).emailSent).toBe(false);
    expect(mail.sent.length).toBe(before);

    const listed = await ownerList(deckId, `?token=${tokenId}`);
    expect(listed.responses).toHaveLength(1);
    expect(listed.responses[0].respondentUserId).toBeUndefined();
    expect(listed.responses[0].respondentEmail).toBeUndefined();
  });

  it('PRDCT-1333: a FORM-LESS deck keeps the streaming path and its content-sha ETag', async () => {
    const plainDeck = await uploadDeck('Plain Deck', [entryOf('index.html', HTML_NO_FORM)]);
    // canSubmitForms defaults ON — the capability alone must not arm the
    // buffering/injecting seam, or every share link leaves the stream path.
    // The recipient bar (PRDCT-2281) DOES ride every browser navigation by
    // default — through the streaming injector, never a buffer — so the
    // stream-path pin is taken on a bare link, and the forms pin on both.
    const { secret } = await createToken({ name: 'Plain', showBar: false }, plainDeck);
    const res = await fetchEntry(secret);
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain(FORMS_MARKER);
    expect(res.headers.get('etag')).toBe(`"${shaOf(HTML_NO_FORM)}"`);
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    const withBar = await createToken({ name: 'Plain, bar' }, plainDeck);
    expect(await (await fetchEntry(withBar.secret)).text()).not.toContain(FORMS_MARKER);

    // The same deck's frame navigation stays on the stream path too.
    const framed = await app.app.request(`/v/${secret}/`, {
      headers: { accept: 'text/html', 'sec-fetch-dest': 'iframe' }
    });
    expect(await framed.text()).not.toContain(FORMS_MARKER);
    expect(framed.headers.get('etag')).toBe(`"${shaOf(HTML_NO_FORM)}"`);
  });

  it('PRDCT-1333: hasForms is stamped at commit, per version, and mirrored on the deck', async () => {
    const deck = await uploadDeck('Stamp Deck', [entryOf('index.html', HTML_NO_FORM)]);
    const [v1] = await app.db.db
      .select()
      .from(presentationVersions)
      .where(eq(presentationVersions.presentationId, deck));
    expect(v1!.hasForms).toBe(false);

    // v2 introduces a form → the flag flips forward…
    const push = await app.app.request(
      `/api/v1/presentations/${deck}/versions`,
      json(
        { expectedBaseVersion: 1, entryPath: 'index.html', manifest: [entryOf('index.html', HTML_V1)] },
        { cookie }
      )
    );
    expect(push.status).toBe(201);
    const [row] = await app.db.db.select().from(presentations).where(eq(presentations.id, deck));
    expect(row!.hasForms).toBe(true);
    const { secret } = await createToken({ name: 'Stamped' }, deck);
    expect(await (await fetchEntry(secret)).text()).toContain(FORMS_MARKER);

    // …and a sub-page-only form arms the whole version, not just that page.
    const subOnly = await uploadDeck('Sub Only', [
      entryOf('index.html', HTML_NO_FORM),
      entryOf('guide/page2.html', HTML_PAGE2)
    ]);
    const sub = await createToken({ name: 'Sub Only Link' }, subOnly);
    const page2 = await app.app.request(`/v/${sub.secret}/guide/page2.html`, {
      headers: { accept: 'text/html' }
    });
    expect(await page2.text()).toContain(FORMS_MARKER);
  });

  it('PRDCT-1331/1334 residual: a form injected by an EXTERNAL script bundle is detected at commit', async () => {
    // The page has no marker; app.js renders the form on load. Read only
    // the HTML and this deck is stamped form-less: no runtime, and its
    // native submit garbage-navigates the sandbox storing nothing. The
    // shape worked before detection existed, so it must work with it.
    const bundled = await uploadDeck('Bundled Deck', [
      entryOf('index.html', HTML_SHELL),
      entryOf('app.js', JS_BUNDLE, 'text/javascript')
    ]);
    const [row] = await app.db.db.select().from(presentations).where(eq(presentations.id, bundled));
    expect(row!.hasForms).toBe(true);
    const { secret } = await createToken({ name: 'Bundled' }, bundled);
    expect(await (await fetchEntry(secret)).text()).toContain(FORMS_MARKER);

    // The manifest's contentType is client-supplied: a mislabelled bundle
    // is still a script by extension (case-insensitively).
    const mislabelled = await uploadDeck('Mislabelled Bundle', [
      entryOf('index.html', HTML_SHELL),
      entryOf('APP.JS', JS_BUNDLE, 'application/octet-stream')
    ]);
    const [row2] = await app.db.db.select().from(presentations).where(eq(presentations.id, mislabelled));
    expect(row2!.hasForms).toBe(true);

    // A parameterized type is still a script (the contract allows any
    // plain-text contentType, so `; charset=` is a legal manifest value).
    const parameterized = await uploadDeck('Parameterized Bundle', [
      entryOf('index.html', HTML_SHELL),
      entryOf('bundle.txt', JS_BUNDLE, 'text/javascript; charset=utf-8')
    ]);
    const [row4] = await app.db.db.select().from(presentations).where(eq(presentations.id, parameterized));
    expect(row4!.hasForms).toBe(true);

    // A stylesheet carrying the marker's text cannot author a form: the
    // form-less streaming path (PRDCT-1333) is kept for it.
    const decoy = await uploadDeck('CSS Decoy', [
      entryOf('index.html', HTML_NO_FORM),
      entryOf('theme.css', CSS_DECOY, 'text/css')
    ]);
    const [row3] = await app.db.db.select().from(presentations).where(eq(presentations.id, decoy));
    expect(row3!.hasForms).toBe(false);
  });
});

// ═══ Public token-session surface: create ════════════════════════════════════

describe('public form submit (token-authed, cross-origin)', () => {
  it('answers the CORS preflight (X-Slideless-Response allowed) and stamps ACAO on responses', async () => {
    const { secret } = await createToken({ name: 'CORS' });
    const preflight = await app.app.request(`/api/v1/viewer/${secret}/forms/rsvp/responses`, {
      method: 'OPTIONS',
      headers: { origin: 'null', 'access-control-request-method': 'POST' }
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
    const allowHeaders = preflight.headers.get('access-control-allow-headers') ?? '';
    // The runtime's whole header vocabulary: the edit secret, the unlock
    // proof, and the agent-style password.
    expect(allowHeaders).toContain('X-Slideless-Response');
    expect(allowHeaders).toContain('X-Slideless-Unlock');
    expect(allowHeaders).toContain('X-Viewer-Password');
    // GET/PUT /responses/me preflights through the same middleware.
    expect(preflight.headers.get('access-control-allow-methods')).toContain('PUT');

    const created = await submit(secret, 'rsvp', { payload: { name: 'cors' } });
    expect(created.status).toBe(201);
    expect(created.headers.get('access-control-allow-origin')).toBe('*');
    expect(created.headers.get('cache-control')).toBe('no-store');
  });

  it('creates a response: respondent wire + one-time edit secret; the owner sees the full row', async () => {
    const { secret, id: tokenId } = await createToken({ name: 'Alice Link' });
    const res = await submit(secret, 'rsvp', {
      payload: { name: 'Ada', dish: ['salad', 'bread'] }
    });
    expect(res.status).toBe(201);
    const body = await readJson(res);
    // 48 bytes base64url, returned exactly once.
    expect(body.editSecret).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect(body.emailSent).toBe(false); // anonymous: nothing to auto-mail
    // The respondent wire is the deliberate subset — no foreign ids, ever.
    expect(Object.keys(body.response).sort()).toEqual(
      ['createdAt', 'formName', 'id', 'payload', 'updatedAt', 'version'].sort()
    );
    expect(body.response).toMatchObject({
      formName: 'rsvp',
      version: 1,
      payload: { name: 'Ada', dish: ['salad', 'bread'] }
    });

    const listed = await ownerList(deckId, `?token=${tokenId}`);
    expect(listed.responses).toHaveLength(1);
    expect(listed.responses[0]).toMatchObject({
      id: body.response.id,
      presentationId: deckId,
      formName: 'rsvp',
      shareTokenId: tokenId,
      shareTokenName: 'Alice Link',
      source: 'link',
      placement: null,
      payload: { name: 'Ada', dish: ['salad', 'bread'] }
    });
    // PRDCT-1331: identity is off the owner wire entirely, so a
    // presentations:read machine key cannot harvest respondent addresses.
    expect(listed.responses[0]).not.toHaveProperty('respondentUserId');
    expect(listed.responses[0]).not.toHaveProperty('respondentEmail');
    // The edit secret never appears in any owner-facing bytes.
    expect(JSON.stringify(listed)).not.toContain(body.editSecret);
  });

  it('maps dead tokens: unknown 404, revoked 403, expired 410, forms-disabled 403', async () => {
    const unknown = await submit('A'.repeat(64), 'rsvp', { payload: {} });
    expect(unknown.status).toBe(404);

    const revoked = await createToken({ name: 'Revoked' });
    await app.app.request(`/api/v1/presentations/${deckId}/tokens/${revoked.id}`, {
      method: 'DELETE',
      headers: { cookie }
    });
    const deadWrite = await submit(revoked.secret, 'rsvp', { payload: {} });
    expect(deadWrite.status).toBe(403);
    expect((await readJson(deadWrite)).error.code).toBe('revoked');

    const expiring = await createToken({
      name: 'Expired',
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    await app.app.request(`/api/v1/presentations/${deckId}/tokens/${expiring.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ expiresAt: new Date(Date.now() - 1000).toISOString() })
    });
    const gone = await submit(expiring.secret, 'rsvp', { payload: {} });
    expect(gone.status).toBe(410);

    const noForms = await createToken({ name: 'Forms Off', canSubmitForms: false });
    const denied = await submit(noForms.secret, 'rsvp', { payload: {} });
    expect(denied.status).toBe(403);
    expect((await readJson(denied)).error.code).toBe('forms_disabled');
  });

  it('password-protected tokens: 401 without proof; injected unlock MAC works; x-viewer-password works', async () => {
    const pw = await createToken({ name: 'Locked', password: 'filler-pass-9' });

    const noProof = await submit(pw.secret, 'rsvp', { payload: {} });
    expect(noProof.status).toBe(401);
    expect((await readJson(noProof)).error.code).toBe('password_required');

    // Browser dance: unlock via the form → cookie → injected forms runtime
    // carries the unlock MAC → the MAC authenticates the submit.
    const form = await app.app.request(`/v/${pw.secret}/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'text/html',
        'x-forwarded-for': nextIp()
      },
      body: 'password=filler-pass-9'
    });
    expect(form.status).toBe(303);
    const unlockCookie = extractCookie(form);
    const entry = await app.app.request(`/v/${pw.secret}/`, {
      headers: { accept: 'text/html', cookie: unlockCookie }
    });
    expect(entry.status).toBe(200);
    const html = await entry.text();
    expect(html).toContain(FORMS_MARKER);
    const unlock = /"unlock":"([^"]+)"/.exec(html)?.[1];
    expect(unlock).toBeDefined();

    const viaMac = await submit(
      pw.secret,
      'rsvp',
      { payload: { name: 'mac' } },
      { 'x-slideless-unlock': unlock! }
    );
    expect(viaMac.status).toBe(201);

    const viaPassword = await submit(
      pw.secret,
      'rsvp',
      { payload: { name: 'pw' } },
      { 'x-viewer-password': 'filler-pass-9' }
    );
    expect(viaPassword.status).toBe(201);

    const wrong = await submit(pw.secret, 'rsvp', { payload: {} }, { 'x-viewer-password': 'nope' });
    expect(wrong.status).toBe(401);
    expect((await readJson(wrong)).error.code).toBe('password_invalid');
  });

  it('wrong password attempts burn the bucket: the 11th try 429s even with the right password', async () => {
    const pw = await createToken({ name: 'Burn', password: 'burn-pass-7' });
    const ip = nextIp(); // ONE fixed ip: the bucket is per IP + token
    for (let i = 0; i < 10; i++) {
      const res = await submit(
        pw.secret,
        'rsvp',
        { payload: {} },
        { 'x-viewer-password': 'wrong-pass', 'x-forwarded-for': ip }
      );
      expect(res.status).toBe(401);
      expect((await readJson(res)).error.code).toBe('password_invalid');
    }
    const exhausted = await submit(
      pw.secret,
      'rsvp',
      { payload: {} },
      { 'x-viewer-password': 'burn-pass-7', 'x-forwarded-for': ip }
    );
    expect(exhausted.status).toBe(429);
    expect((await readJson(exhausted)).error.code).toBe('rate_limited');
  });
});

// ═══ Version integrity ═══════════════════════════════════════════════════════

describe('version integrity (the annotations discipline)', () => {
  it('pins, rejects foreign versions, and stores the echoed served version', async () => {
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
      versionMode: 'pinned',
      pinnedVersion: 1
    });
    const mismatch = await submit(pinned.secret, 'rsvp', { payload: {}, version: 2 });
    expect(mismatch.status).toBe(400);
    expect((await readJson(mismatch)).error.code).toBe('invalid_version');

    const ok = await submit(pinned.secret, 'rsvp', { payload: { a: 'pin' }, version: 1 });
    expect(ok.status).toBe(201);
    expect((await readJson(ok)).response.version).toBe(1);

    // A latest-mode token may echo an OLDER version it was actually served
    // (a mid-fill push must not corrupt attribution)…
    const latest = await createToken({ name: 'Latest' });
    const older = await submit(latest.secret, 'rsvp', { payload: { a: 'old' }, version: 1 });
    expect(older.status).toBe(201);
    expect((await readJson(older)).response.version).toBe(1);
    // …defaults to the resolved latest…
    const dflt = await submit(latest.secret, 'rsvp', { payload: { a: 'now' } });
    expect((await readJson(dflt)).response.version).toBe(2);
    // …and can never claim a version that does not exist.
    const future = await submit(latest.secret, 'rsvp', { payload: {}, version: 99 });
    expect(future.status).toBe(400);
    expect((await readJson(future)).error.code).toBe('invalid_version');
  });
});

// ═══ Input validation: names, payload caps, source/placement ═════════════════

describe('input validation', () => {
  let secret: string;

  beforeAll(async () => {
    ({ secret } = await createToken({ name: 'Valid' }));
  });

  it('validates the form name (slug, 1-64 chars)', async () => {
    const bad = await submit(secret, encodeURIComponent('bad name!'), { payload: {} });
    expect(bad.status).toBe(400);
    expect((await readJson(bad)).error.code).toBe('validation_error');

    const tooLong = await submit(secret, 'a'.repeat(65), { payload: {} });
    expect(tooLong.status).toBe(400);

    const ok = await submit(secret, 'RSVP_2.go-x', { payload: { q: 'yes' } });
    expect(ok.status).toBe(201);
    expect((await readJson(ok)).response.formName).toBe('RSVP_2.go-x');
  });

  it('caps the payload: >128 fields, >128-char keys, non-flat values, >32 KiB serialized', async () => {
    const manyFields = Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`k${i}`, 'v']));
    const fat = await submit(secret, 'rsvp', { payload: manyFields });
    expect(fat.status).toBe(400);
    expect((await readJson(fat)).error.code).toBe('validation_error');

    const longKey = await submit(secret, 'rsvp', { payload: { ['k'.repeat(129)]: 'v' } });
    expect(longKey.status).toBe(400);

    const nested = await submit(secret, 'rsvp', { payload: { a: { b: 'c' } } });
    expect(nested.status).toBe(400);

    const numeric = await submit(secret, 'rsvp', { payload: { a: 7 } });
    expect(numeric.status).toBe(400);

    const oversized = await submit(secret, 'rsvp', { payload: { essay: 'y'.repeat(33 * 1024) } });
    expect(oversized.status).toBe(400);
    expect((await readJson(oversized)).error.code).toBe('payload_too_large');

    const notJson = await app.app.request(`/api/v1/viewer/${secret}/forms/rsvp/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'null', 'x-forwarded-for': nextIp() },
      body: 'not json'
    });
    expect(notJson.status).toBe(400);
  });

  it('sanitizes placement (illegal label → null) and enum-validates source', async () => {
    const { secret: s, id: tokenId } = await createToken({ name: 'Attribution' });
    const legal = await submit(s, 'rsvp', {
      payload: { a: '1' },
      source: 'embed',
      placement: 'hero-embed'
    });
    expect(legal.status).toBe(201);

    const illegal = await submit(s, 'rsvp', {
      payload: { a: '2' },
      placement: 'bad label!'
    });
    expect(illegal.status).toBe(201);

    const badSource = await submit(s, 'rsvp', { payload: {}, source: 'popup' });
    expect(badSource.status).toBe(400);
    expect((await readJson(badSource)).error.code).toBe('validation_error');

    const listed = await ownerList(deckId, `?token=${tokenId}`);
    expect(listed.responses).toHaveLength(2);
    const [second, first] = listed.responses; // newest first
    expect(first).toMatchObject({ source: 'embed', placement: 'hero-embed' });
    expect(second).toMatchObject({ source: 'link', placement: null });
  });
});

// ═══ The respondent's own row (edit secret) ══════════════════════════════════

describe('own-row read/update via the edit secret', () => {
  let secretA: string;
  let secretB: string;
  let editSecret: string;
  let responseId: string;
  let createdUpdatedAt: string;

  beforeAll(async () => {
    ({ secret: secretA } = await createToken({ name: 'Own A' }));
    ({ secret: secretB } = await createToken({ name: 'Own B' }));
    const res = await submit(secretA, 'rsvp', { payload: { name: 'Eve', dish: 'pie' } });
    expect(res.status).toBe(201);
    const body = await readJson(res);
    editSecret = body.editSecret;
    responseId = body.response.id;
    createdUpdatedAt = body.response.updatedAt;
  });

  it('GET /responses/me prefills the own row with the edit secret', async () => {
    const res = await getMe(secretA, 'rsvp', { 'x-slideless-response': editSecret });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.response).toMatchObject({
      id: responseId,
      formName: 'rsvp',
      payload: { name: 'Eve', dish: 'pie' }
    });
    expect(Object.keys(body.response).sort()).toEqual(
      ['createdAt', 'formName', 'id', 'payload', 'updatedAt', 'version'].sort()
    );
  });

  it('an invalid share secret answers 404 before the form name is even looked at', async () => {
    // Same order as the create route: token session first. A bad share
    // secret must never learn that its form name was malformed (400).
    const bad = 'A'.repeat(64);
    expect((await getMe(bad, 'not a name!', { 'x-slideless-response': editSecret })).status).toBe(404);
    expect(
      (await putMe(bad, 'not a name!', { payload: {} }, { 'x-slideless-response': editSecret })).status
    ).toBe(404);
    // …and with a valid share secret, the malformed name is the 400 it always was.
    expect((await getMe(secretA, 'not a name!', { 'x-slideless-response': editSecret })).status).toBe(400);
  });

  it('404s a missing, malformed, or unknown edit secret', async () => {
    expect((await getMe(secretA, 'rsvp')).status).toBe(404);
    expect((await getMe(secretA, 'rsvp', { 'x-slideless-response': 'short' })).status).toBe(404);
    expect((await getMe(secretA, 'rsvp', { 'x-slideless-response': 'A'.repeat(64) })).status).toBe(404);
  });

  it("PRDCT-1331/1334 residual: the form-agnostic resolve route names the row's form, once per page load", async () => {
    // The runtime resolves an arriving #slr= ONCE through this route and
    // offers the resume prompt only on the form the row names — instead of
    // probing the form-bound route once PER FORM, which burned the submit
    // bucket N times per page load on a bogus fragment.
    const res = await resolveMe(secretA, { 'x-slideless-response': editSecret });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.response).toMatchObject({
      id: responseId,
      formName: 'rsvp',
      payload: { name: 'Eve', dish: 'pie' }
    });
    // Same wire shape as the form-bound read: nothing extra leaks here.
    expect(Object.keys(body.response).sort()).toEqual(
      ['createdAt', 'formName', 'id', 'payload', 'updatedAt', 'version'].sort()
    );
    // Missing / malformed / unknown / foreign-token secrets: the same 404.
    expect((await resolveMe(secretA)).status).toBe(404);
    expect((await resolveMe(secretA, { 'x-slideless-response': 'short' })).status).toBe(404);
    expect((await resolveMe(secretA, { 'x-slideless-response': 'A'.repeat(64) })).status).toBe(404);
    expect((await resolveMe(secretB, { 'x-slideless-response': editSecret })).status).toBe(404);
    // And it is a read: the row is untouched.
    const again = await readJson(await getMe(secretA, 'rsvp', { 'x-slideless-response': editSecret }));
    expect(again.response.updatedAt).toBe(createdUpdatedAt);
  });

  it('PRDCT-1331/1334 residual: an unresolvable resolve probe still burns the submit bucket (guessing stays expensive)', async () => {
    // One probe per page load is the CLIENT's discipline; the server keeps
    // charging a bogus secret so the route is no free oracle. 30 bogus
    // probes from one IP drain the bucket; the next submit from it is 429.
    const { secret } = await createToken({ name: 'Probe Drain' });
    const ip = nextIp();
    for (let i = 0; i < 30; i++) {
      const probe = await resolveMe(secret, {
        'x-slideless-response': 'B'.repeat(48),
        'x-forwarded-for': ip
      });
      expect(probe.status).toBe(404);
    }
    const limited = await submit(secret, 'rsvp', { payload: { who: 'late' } }, { 'x-forwarded-for': ip });
    expect(limited.status).toBe(429);
    // A different IP on the same link is unaffected.
    expect((await submit(secret, 'rsvp', { payload: { who: 'other' } })).status).toBe(201);
  });

  it('PRDCT-1334: the own-row routes are FORM-SCOPED — a valid secret cannot reach another form', async () => {
    // Two forms, one page, one respondent: the runtime used to keep a single
    // module-level secret, so editing `rsvp` filed the edit under
    // `feedback` and destroyed that answer while the card said "updated".
    // The routes now name the form and the server refuses the mismatch,
    // whatever the client sends.
    const twoFormDeck = await uploadDeck('Two Forms', [entryOf('index.html', HTML_TWO_FORMS)]);
    const { secret } = await createToken({ name: 'Two Forms Link' }, twoFormDeck);
    const rsvp = await readJson(await submit(secret, 'rsvp', { payload: { who: 'Ada' } }));
    const feedback = await readJson(await submit(secret, 'feedback', { payload: { note: 'good' } }));

    // The rsvp secret on the feedback route: 404, and nothing is written.
    const crossGet = await getMe(secret, 'feedback', { 'x-slideless-response': rsvp.editSecret });
    expect(crossGet.status).toBe(404);
    // …and it does NOT burn the submit bucket: the caller already holds the
    // capability, so the mismatch is no oracle. 31 of them from one IP would
    // exhaust a 30-point bucket if they charged; the submit still lands.
    const ip = nextIp();
    for (let i = 0; i < 31; i++) {
      expect(
        (await getMe(secret, 'feedback', { 'x-slideless-response': rsvp.editSecret, 'x-forwarded-for': ip }))
          .status
      ).toBe(404);
    }
    expect(
      (await submit(secret, 'rsvp', { payload: { who: 'Bob' } }, { 'x-forwarded-for': ip })).status
    ).toBe(201);
    const crossPut = await putMe(
      secret,
      'feedback',
      { payload: { note: 'HIJACKED' } },
      { 'x-slideless-response': rsvp.editSecret }
    );
    expect(crossPut.status).toBe(404);
    const crossMail = await emailMe(
      secret,
      'feedback',
      { email: 'cross@forms.test' },
      { 'x-slideless-response': rsvp.editSecret }
    );
    expect(crossMail.status).toBe(404);

    // Both rows are exactly as their own respondents left them.
    const listed = await ownerList(twoFormDeck);
    const byForm = Object.fromEntries(
      listed.responses.map((r: { formName: string; payload: unknown; id: string }) => [r.formName, r])
    );
    expect(byForm['feedback'].payload).toEqual({ note: 'good' });
    expect(byForm['feedback'].id).toBe(feedback.response.id);
    expect(byForm['rsvp'].payload).toEqual({ who: 'Ada' });

    // Each secret still works on its OWN form.
    const own = await putMe(
      secret,
      'rsvp',
      { payload: { who: 'Ada again' } },
      { 'x-slideless-response': rsvp.editSecret }
    );
    expect(own.status).toBe(200);
  });

  it("404s an edit secret presented through ANOTHER token's session (no foreign-row oracle)", async () => {
    const foreignGet = await getMe(secretB, 'rsvp', { 'x-slideless-response': editSecret });
    expect(foreignGet.status).toBe(404);
    const foreignPut = await putMe(
      secretB,
      'rsvp',
      { payload: { name: 'hijack' } },
      { 'x-slideless-response': editSecret }
    );
    expect(foreignPut.status).toBe(404);
    // The row is untouched.
    const still = await readJson(await getMe(secretA, 'rsvp', { 'x-slideless-response': editSecret }));
    expect(still.response.payload).toEqual({ name: 'Eve', dish: 'pie' });
  });

  it('PUT /responses/me replaces the payload and bumps updatedAt (one evolving answer)', async () => {
    await sleep(20);
    const res = await putMe(
      secretA,
      'rsvp',
      { payload: { name: 'Eve', dish: 'cake' } },
      { 'x-slideless-response': editSecret }
    );
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.response.id).toBe(responseId); // same row, not a new one
    expect(body.response.payload).toEqual({ name: 'Eve', dish: 'cake' });
    expect(new Date(body.response.updatedAt).getTime()).toBeGreaterThan(new Date(createdUpdatedAt).getTime());

    // Validation applies to updates too.
    const nested = await putMe(
      secretA,
      'rsvp',
      { payload: { a: { deep: true } } },
      { 'x-slideless-response': editSecret }
    );
    expect(nested.status).toBe(400);
    const oversized = await putMe(
      secretA,
      'rsvp',
      { payload: { essay: 'z'.repeat(33 * 1024) } },
      { 'x-slideless-response': editSecret }
    );
    expect(oversized.status).toBe(400);
    expect((await readJson(oversized)).error.code).toBe('payload_too_large');

    // A resubmit WITHOUT the secret is a new row, never an overwrite.
    const fresh = await submit(secretA, 'rsvp', { payload: { name: 'Someone Else' } });
    expect(fresh.status).toBe(201);
    expect((await readJson(fresh)).response.id).not.toBe(responseId);
  });
});

// ═══ The email leg (leg 2) ═══════════════════════════════════════════════════

describe('email-me-my-link', () => {
  let secret: string;
  let editSecret: string;

  beforeAll(async () => {
    ({ secret } = await createToken({ name: 'Mail Link' }));
    const res = await submit(secret, 'rsvp', { payload: { name: 'Mailer' } });
    editSecret = (await readJson(res)).editSecret;
  });

  it('mails the edit link to the given address (lowercased), via the recording driver', async () => {
    const before = mail.sent.length;
    const res = await emailMe(
      secret,
      'rsvp',
      { email: 'MiXed@Forms.TEST' },
      { 'x-slideless-response': editSecret }
    );
    expect(res.status).toBe(200);
    expect((await readJson(res)).emailSent).toBe(true);
    expect(mail.sent.length).toBe(before + 1);
    const sent = mail.sent[before]!;
    expect(sent.to).toBe('mixed@forms.test');
    expect(sent.subject.toLowerCase()).toContain('form response');
    // The mail carries the personal edit link: viewer URL + fragment secret.
    expect(sent.text).toContain(`/v/${secret}/#slr=${editSecret}`);
  });

  it('rejects an invalid address and requires the edit secret', async () => {
    const bad = await emailMe(
      secret,
      'rsvp',
      { email: 'not-an-email' },
      { 'x-slideless-response': editSecret }
    );
    expect(bad.status).toBe(400);
    expect((await readJson(bad)).error.code).toBe('validation_error');
    const noSecret = await emailMe(secret, 'rsvp', { email: 'a@b.test' });
    expect(noSecret.status).toBe(404);
  });

  it('drains the tight per-IP+token bucket (5, then 429)', async () => {
    const { secret: s } = await createToken({ name: 'Mail Drain' });
    const minted = await readJson(await submit(s, 'rsvp', { payload: { d: '1' } }));
    const ip = nextIp(); // ONE fixed ip for the burst
    for (let i = 0; i < 5; i++) {
      const res = await emailMe(
        s,
        'rsvp',
        { email: `drain${i}@forms.test` },
        { 'x-slideless-response': minted.editSecret, 'x-forwarded-for': ip }
      );
      expect(res.status).toBe(200);
    }
    const limited = await emailMe(
      s,
      'rsvp',
      { email: 'drain-final@forms.test' },
      { 'x-slideless-response': minted.editSecret, 'x-forwarded-for': ip }
    );
    expect(limited.status).toBe(429);
    expect((await readJson(limited)).error.code).toBe('rate_limited');
  });

  it('drains the per-ADDRESS dimension independently of the IP', async () => {
    const { secret: s } = await createToken({ name: 'Mail Addr Drain' });
    const minted = await readJson(await submit(s, 'rsvp', { payload: { d: '2' } }));
    for (let i = 0; i < 5; i++) {
      const res = await emailMe(
        s,
        'rsvp',
        { email: 'shared@forms.test' }, // same address…
        { 'x-slideless-response': minted.editSecret } // …rotating IPs (nextIp)
      );
      expect(res.status).toBe(200);
    }
    const limited = await emailMe(
      s,
      'rsvp',
      { email: 'shared@forms.test' },
      { 'x-slideless-response': minted.editSecret }
    );
    expect(limited.status).toBe(429);
  });
});

// ═══ Mail driver 'none' (a second boot: the driver is a boot-time fact) ══════

describe("mail driver 'none'", () => {
  let app2: TestApp;
  let cookie2: string;
  let deck2: string;
  let secret2: string;

  beforeAll(async () => {
    // No email override: EMAIL_DRIVER defaults to the non-delivering driver.
    app2 = await createTestApp(await createDatabase(container, 'forms_nomail'));
    await app2.app.request(
      '/api/v1/setup',
      json({ setupToken: 'integration-test-setup-token', instanceName: 'NoMail', owner: OWNER })
    );
    cookie2 = extractCookie(
      await app2.app.request(
        '/api/v1/auth/sign-in/email',
        json({ email: OWNER.email, password: OWNER.password })
      )
    );
    const form = new FormData();
    form.set('sha256', shaOf(HTML_V1));
    form.set('file', new Blob([new Uint8Array(HTML_V1)], { type: 'text/html' }), 'index.html');
    const upload = await app2.app.request('/api/v1/presentations/assets', {
      method: 'POST',
      headers: { cookie: cookie2 },
      body: form
    });
    expect(upload.status).toBe(201);
    const reserve = await readJson(
      await app2.app.request('/api/v1/presentations/uploads', {
        method: 'POST',
        headers: { cookie: cookie2 }
      })
    );
    deck2 = reserve.uploadSession.presentationId;
    const commit = await app2.app.request(
      `/api/v1/presentations/uploads/${reserve.uploadSession.id}/commit`,
      json(
        { title: 'NoMail Deck', entryPath: 'index.html', manifest: [entryOf('index.html', HTML_V1)] },
        { cookie: cookie2 }
      )
    );
    expect(commit.status).toBe(201);
    const token = await readJson(
      await app2.app.request(
        `/api/v1/presentations/${deck2}/tokens`,
        // The block exercises the email-me-my-link leg, which belongs to
        // the fragment path: a link that does not remember (PRDCT-2328).
        json({ name: 'NM', remembersResponses: false }, { cookie: cookie2 })
      )
    );
    secret2 = token.secret;
  }, 120_000);

  afterAll(async () => {
    await app2?.stop();
  });

  it('PRDCT-2330: the owner notifier is a no-op on the none driver, and the submit still lands', async () => {
    // Its own non-remembering link: the block's shared link (remembering by
    // the contract default) must reach the next test with no row yet.
    const own = await readJson(
      await app2.app.request(
        `/api/v1/presentations/${deck2}/tokens`,
        json({ name: 'NM quiet', remembersResponses: false }, { cookie: cookie2 })
      )
    );
    const created = await app2.app.request(`/api/v1/viewer/${own.secret}/forms/rsvp/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'null', 'x-forwarded-for': nextIp() },
      body: JSON.stringify({ payload: { name: 'quiet' } })
    });
    expect(created.status).toBe(201);
    await app2.formsNotifier.drain();
    const [row] = await app2.db.db
      .select()
      .from(formResponses)
      .where(eq(formResponses.id, (await readJson(created)).response.id))
      .limit(1);
    expect(row).toBeDefined();
    expect(await app2.formsNotifier.notify({ kind: 'new', row: row!, shareTokenName: 'x' })).toBe(false);
    expect(await app2.formsNotifier.notify({ kind: 'edited', row: row!, shareTokenName: 'x' })).toBe(false);
  });

  it('hides the opt-in (emailAvailable:false), 400s the email leg, and never auto-mails', async () => {
    const entry = await app2.app.request(`/v/${secret2}/`, { headers: { accept: 'text/html' } });
    expect(await entry.text()).toContain('"emailAvailable":false');

    const created = await app2.app.request(`/api/v1/viewer/${secret2}/forms/rsvp/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'null', 'x-forwarded-for': nextIp() },
      body: JSON.stringify({ payload: { name: 'quiet' } })
    });
    expect(created.status).toBe(201);
    const body = await readJson(created);
    expect(body.emailSent).toBe(false);

    const denied = await app2.app.request(`/api/v1/viewer/${secret2}/forms/rsvp/responses/me/email`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'null',
        'x-forwarded-for': nextIp(),
        'x-slideless-response': body.editSecret
      },
      body: JSON.stringify({ email: 'someone@forms.test' })
    });
    expect(denied.status).toBe(400);
    expect((await readJson(denied)).error.code).toBe('email_unavailable');
  });
});

// ═══ Leg 3 is GONE (PRDCT-1331) ══════════════════════════════════════════════

describe('no respondent identity, by construction', () => {
  let secret: string;
  let tokenId: string;

  beforeAll(async () => {
    ({ secret, id: tokenId } = await createToken({ name: 'Anonymous Only' }));
  });

  it('stores anonymously whatever assertion-shaped input a submit carries', async () => {
    // Anything a client claims about identity is stripped by the schema and
    // never reaches a column. The shapes below are the exact ones leg 3
    // accepted, including one minted with the real MAC label and auth
    // secret — the value type that used to work.
    const exp = Date.now() + 60_000;
    const encoded = Buffer.from(ownerUserId, 'utf8').toString('base64url');
    // Exactly the value leg 3 minted and verified: the real MAC label, the
    // real auth secret, a live expiry. It must still store anonymously.
    const macd = createHmac('sha256', AUTH_SECRET)
      .update(`viewer-respondent\n${tokenId}\n${ownerUserId}\n${exp}`)
      .digest('base64url');
    const shapes: Array<Record<string, unknown>> = [
      { assertion: `${encoded}.${exp}.${macd}` },
      { assertion: 'garbage' },
      { respondentUserId: ownerUserId },
      { respondent_user_id: ownerUserId },
      { respondentEmail: OWNER.email }
    ];
    const before = mail.sent.length;
    for (const extra of shapes) {
      const res = await submit(secret, 'rsvp', { payload: { who: 'anon' }, ...extra });
      expect(res.status).toBe(201);
      expect((await readJson(res)).emailSent).toBe(false);
    }
    // No auto-mail for any of them: the leg-3 mail never consulted the email
    // limiter, so a replayed submit was a mail amplifier at a stranger.
    expect(mail.sent.length).toBe(before);

    // Rows are anonymous in the database itself, not merely on the wire.
    const rows = await app.db.db.select().from(formResponses).where(eq(formResponses.shareTokenId, tokenId));
    expect(rows).toHaveLength(shapes.length);
    for (const row of rows) expect(row.respondentUserId).toBeNull();
  });

  it('a signed-in browser submit is anonymous too (the cookie can no longer be turned into an identity)', async () => {
    const { secret: s, id } = await createToken({ name: 'Cookied' });
    const res = await submit(s, 'rsvp', { payload: { who: 'signed-in' } }, { cookie });
    expect(res.status).toBe(201);
    const [row] = await app.db.db.select().from(formResponses).where(eq(formResponses.shareTokenId, id));
    expect(row!.respondentUserId).toBeNull();
  });
});

// ═══ Attribution re-stamped on update (PRDCT-1332) ═══════════════════════════

describe('update re-stamps attribution', () => {
  it("an edit from a different source and placement no longer keeps the creator's", async () => {
    // The link cannot change (an edit secret is bound to its token — the
    // cross-token 404 above), but source and placement can: the same link
    // read directly, then edited from inside an embed on a blog post.
    const deck = await uploadDeck('Restamp Deck', [entryOf('index.html', HTML_V1)]);
    const link = await createToken({ name: 'One Link' }, deck);

    const first = await readJson(
      await submit(link.secret, 'rsvp', { payload: { a: '1' }, source: 'link', placement: 'launch' })
    );
    expect((await ownerList(deck)).responses[0]).toMatchObject({
      source: 'link',
      placement: 'launch'
    });

    const put = await putMe(
      link.secret,
      'rsvp',
      { payload: { a: '2' }, source: 'embed', placement: 'blog-post' },
      { 'x-slideless-response': first.editSecret }
    );
    expect(put.status).toBe(200);

    const listed = await ownerList(deck);
    expect(listed.responses).toHaveLength(1);
    expect(listed.responses[0]).toMatchObject({
      id: first.response.id,
      shareTokenId: link.id,
      source: 'embed',
      placement: 'blog-post',
      payload: { a: '2' }
    });

    // An illegal placement on an edit is sanitized like any other.
    const dirty = await putMe(
      link.secret,
      'rsvp',
      { payload: { a: '3' }, placement: 'bad label!' },
      { 'x-slideless-response': first.editSecret }
    );
    expect(dirty.status).toBe(200);
    expect((await ownerList(deck)).responses[0].placement).toBeNull();
  });

  it('an update cannot claim a version the editing link never served', async () => {
    const deck = await uploadDeck('Restamp Pin', [entryOf('index.html', HTML_V1)]);
    const { secret } = await createToken({ name: 'Pinned Edit' }, deck);
    const created = await readJson(await submit(secret, 'rsvp', { payload: { a: '1' } }));
    const bad = await putMe(
      secret,
      'rsvp',
      { payload: { a: '2' }, version: 99 },
      { 'x-slideless-response': created.editSecret }
    );
    expect(bad.status).toBe(400);
    expect((await readJson(bad)).error.code).toBe('invalid_version');
  });
});

// ═══ Per-deck cap ════════════════════════════════════════════════════════════

describe('per-deck response cap', () => {
  it('403s responses_full once the deck holds 10,000 responses', async () => {
    // The cap is a constant (FORM_RESPONSES_MAX_PER_DECK), so fill a
    // dedicated deck by inserting rows directly — the submit path then
    // exercises the real indexed COUNT check.
    const capDeck = await uploadDeck('Cap Deck', [entryOf('index.html', HTML_V1)]);
    const { secret } = await createToken({ name: 'Cap' }, capDeck);

    const batch = 1000;
    for (let b = 0; b < 10; b++) {
      await app.db.db.insert(formResponses).values(
        Array.from({ length: batch }, (_, i) => ({
          workspaceId,
          presentationId: capDeck,
          version: 1,
          formName: 'cap',
          responseSecretHash: `cap-fill-${b}-${i}`, // never resolved, just unique
          payload: {}
        }))
      );
    }

    const res = await submit(secret, 'rsvp', { payload: { one: 'more' } });
    expect(res.status).toBe(403);
    expect((await readJson(res)).error.code).toBe('responses_full');
  }, 60_000);
});

// ═══ Submit rate limit ═══════════════════════════════════════════════════════

describe('submit spam bucket', () => {
  it('rate-limits creates per IP+token: exactly 30, then 429', async () => {
    const { secret } = await createToken({ name: 'Spam' });
    const ip = nextIp(); // ONE fixed ip for the whole burst
    let successes = 0;
    let limited = false;
    for (let i = 0; i < 35 && !limited; i++) {
      const res = await submit(secret, 'rsvp', { payload: { i: String(i) } }, { 'x-forwarded-for': ip });
      if (res.status === 429) limited = true;
      else {
        expect(res.status).toBe(201);
        successes++;
      }
    }
    expect(limited).toBe(true);
    expect(successes).toBe(30); // the viewerFormSubmit bucket size, pinned
  });
});

// ═══ Owner management surface ════════════════════════════════════════════════

describe('owner responses surface (list / summary / delete)', () => {
  let ownerDeck: string;
  let tokenA: { secret: string; id: string };
  let tokenB: { secret: string; id: string };
  const rowIds: string[] = []; // r1..r4, creation order
  let sinceCutoff = '';

  beforeAll(async () => {
    ownerDeck = await uploadDeck('Owner Deck', [entryOf('index.html', HTML_V1)]);
    tokenA = await createToken({ name: 'Link A' }, ownerDeck);
    tokenB = await createToken({ name: 'Link B' }, ownerDeck);

    const seed = async (secret: string, form: string, body: Record<string, unknown>) => {
      const res = await submit(secret, form, body);
      expect(res.status).toBe(201);
      rowIds.push((await readJson(res)).response.id);
      await sleep(30); // distinct createdAt ordering for the since filter
    };
    await seed(tokenA.secret, 'rsvp', { payload: { n: '1' } });
    await seed(tokenA.secret, 'rsvp', { payload: { n: '2' }, source: 'embed', placement: 'hero' });
    await seed(tokenA.secret, 'feedback', { payload: { n: '3' }, placement: 'site' });
    await seed(tokenB.secret, 'rsvp', { payload: { n: '4' } });
  });

  it('lists newest first with the full owner wire', async () => {
    const listed = await ownerList(ownerDeck);
    expect(listed.responses.map((r: { id: string }) => r.id)).toEqual([...rowIds].reverse());
    expect(listed.nextCursor).toBeNull();
    expect(listed.responses[0]).toMatchObject({
      formName: 'rsvp',
      shareTokenId: tokenB.id,
      shareTokenName: 'Link B',
      source: 'link',
      placement: null,
      payload: { n: '4' }
    });
    sinceCutoff = listed.responses[1].createdAt; // r3's instant
  });

  it('filters by form, token, source, and placement', async () => {
    const byForm = await ownerList(ownerDeck, '?form=rsvp');
    expect(byForm.responses.map((r: { id: string }) => r.id)).toEqual([rowIds[3], rowIds[1], rowIds[0]]);

    const byToken = await ownerList(ownerDeck, `?token=${tokenB.id}`);
    expect(byToken.responses.map((r: { id: string }) => r.id)).toEqual([rowIds[3]]);

    const bySource = await ownerList(ownerDeck, '?source=embed');
    expect(bySource.responses.map((r: { id: string }) => r.id)).toEqual([rowIds[1]]);

    const byPlacement = await ownerList(ownerDeck, '?placement=hero');
    expect(byPlacement.responses.map((r: { id: string }) => r.id)).toEqual([rowIds[1]]);

    // Filters compose.
    const combined = await ownerList(ownerDeck, `?form=rsvp&token=${tokenA.id}&source=link`);
    expect(combined.responses.map((r: { id: string }) => r.id)).toEqual([rowIds[0]]);
  });

  it('filters by since (created at or after the instant)', async () => {
    const since = await ownerList(ownerDeck, `?since=${encodeURIComponent(sinceCutoff)}`);
    expect(since.responses.map((r: { id: string }) => r.id)).toEqual([rowIds[3], rowIds[2]]);
  });

  it('rejects malformed filters at the contract', async () => {
    const badToken = await app.app.request(`/api/v1/presentations/${ownerDeck}/responses?token=not-a-uuid`, {
      headers: { cookie }
    });
    expect(badToken.status).toBe(400);
    const badSource = await app.app.request(`/api/v1/presentations/${ownerDeck}/responses?source=popup`, {
      headers: { cookie }
    });
    expect(badSource.status).toBe(400);
    const badSince = await app.app.request(`/api/v1/presentations/${ownerDeck}/responses?since=yesterday`, {
      headers: { cookie }
    });
    expect(badSince.status).toBe(400);
  });

  it('keyset-paginates without overlap', async () => {
    const page1 = await ownerList(ownerDeck, '?limit=2');
    expect(page1.responses.map((r: { id: string }) => r.id)).toEqual([rowIds[3], rowIds[2]]);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await ownerList(ownerDeck, `?limit=2&cursor=${encodeURIComponent(page1.nextCursor)}`);
    expect(page2.responses.map((r: { id: string }) => r.id)).toEqual([rowIds[1], rowIds[0]]);
    expect(page2.nextCursor).toBeNull();
  });

  it('summarizes per form × link × source × placement with the deck total', async () => {
    const summary = await ownerList(ownerDeck, '/summary');
    expect(summary.total).toBe(4);
    expect(summary.buckets).toHaveLength(4);
    expect(summary.buckets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          formName: 'rsvp',
          shareTokenId: tokenA.id,
          shareTokenName: 'Link A',
          source: 'link',
          placement: null,
          count: 1
        }),
        expect.objectContaining({
          formName: 'rsvp',
          shareTokenId: tokenA.id,
          source: 'embed',
          placement: 'hero',
          count: 1
        }),
        expect.objectContaining({ formName: 'feedback', placement: 'site', count: 1 }),
        expect.objectContaining({ formName: 'rsvp', shareTokenId: tokenB.id, count: 1 })
      ])
    );
    for (const bucket of summary.buckets) {
      expect(new Date(bucket.lastResponseAt).getTime()).toBeGreaterThan(0);
    }
  });

  it('hides the surface from a plain member: reads AND delete answer 404', async () => {
    const invited = await readJson(
      await app.app.request(
        '/api/v1/invitations',
        json({ email: 'member@forms.test', role: 'member' }, { cookie })
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
        json({ email: 'member@forms.test', password: 'member-pass-12345' })
      )
    );

    const list = await app.app.request(`/api/v1/presentations/${ownerDeck}/responses`, {
      headers: { cookie: memberCookie }
    });
    expect(list.status).toBe(404);
    const summary = await app.app.request(`/api/v1/presentations/${ownerDeck}/responses/summary`, {
      headers: { cookie: memberCookie }
    });
    expect(summary.status).toBe(404);
    const del = await app.app.request(`/api/v1/presentations/${ownerDeck}/responses/${rowIds[0]}`, {
      method: 'DELETE',
      headers: { cookie: memberCookie }
    });
    // Same 404 as the reads (AUTH-5, PRDCT-1393): the delete probe must not
    // confirm the deck exists either.
    expect(del.status).toBe(404);
    expect((await readJson(del)).error.code).toBe('not_found');
  });

  it('deletes a response (audited); repeats 404; malformed ids 400', async () => {
    const del = await app.app.request(`/api/v1/presentations/${ownerDeck}/responses/${rowIds[0]}`, {
      method: 'DELETE',
      headers: { cookie }
    });
    expect(del.status).toBe(200);
    expect((await readJson(del)).id).toBe(rowIds[0]);

    const listed = await ownerList(ownerDeck);
    expect(listed.responses.map((r: { id: string }) => r.id)).not.toContain(rowIds[0]);
    const summary = await ownerList(ownerDeck, '/summary');
    expect(summary.total).toBe(3);

    // The global audit middleware wrote the moderation row.
    const audits = await app.db.db.select().from(auditLog).where(eq(auditLog.resourceId, rowIds[0]!));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'presentation.form_response_delete',
      resourceType: 'form_response'
    });

    const again = await app.app.request(`/api/v1/presentations/${ownerDeck}/responses/${rowIds[0]}`, {
      method: 'DELETE',
      headers: { cookie }
    });
    expect(again.status).toBe(404);
    const malformed = await app.app.request(`/api/v1/presentations/${ownerDeck}/responses/not-a-uuid`, {
      method: 'DELETE',
      headers: { cookie }
    });
    expect(malformed.status).toBe(400);
  });

  it('machine split: presentations:read reads list+summary; delete needs write; the viewer surface is machine-dead', async () => {
    const minted = await readJson(
      await app.app.request(
        '/api/v1/api-keys',
        json({ name: 'forms-ro', scopes: ['presentations:read'] }, { cookie })
      )
    );
    const list = await app.app.request(`/api/v1/presentations/${ownerDeck}/responses`, {
      headers: { authorization: `Bearer ${minted.key}` }
    });
    expect(list.status).toBe(200);
    const summary = await app.app.request(`/api/v1/presentations/${ownerDeck}/responses/summary`, {
      headers: { authorization: `Bearer ${minted.key}` }
    });
    expect(summary.status).toBe(200);

    const del = await app.app.request(`/api/v1/presentations/${ownerDeck}/responses/${rowIds[1]}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${minted.key}` }
    });
    expect(del.status).toBe(403);
    expect((await readJson(del)).error.code).toBe('insufficient_scope');

    // A credentialed machine call to the PUBLIC token surface dies at the
    // fail-closed scope gate — /viewer/* is deliberately unlisted.
    const viaKey = await app.app.request(`/api/v1/viewer/${tokenA.secret}/forms/rsvp/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${minted.key}`,
        'x-forwarded-for': nextIp()
      },
      body: JSON.stringify({ payload: {} })
    });
    expect(viaKey.status).toBe(403);
    expect((await readJson(viaKey)).error.code).toBe('endpoint_not_allowed');
    const readViaKey = await app.app.request(`/api/v1/viewer/${tokenA.secret}/forms/rsvp/responses/me`, {
      headers: { authorization: `Bearer ${minted.key}` }
    });
    expect(readViaKey.status).toBe(403);
  });
});

// ═══ A link that remembers its answers (PRDCT-2328) ══════════════════════════

describe('remembering links (PRDCT-2328)', () => {
  let deck: string;
  const respondentKeys = (wire: Record<string, unknown>) => Object.keys(wire).sort();

  beforeAll(async () => {
    deck = await uploadDeck('Remember Deck', [
      entryOf('index.html', HTML_V1),
      entryOf('guide/page2.html', HTML_PAGE2)
    ]);
  });

  it('the contract default is ON for a named link; the preview mint is OFF; PATCH flips it', async () => {
    const res = await app.app.request(
      `/api/v1/presentations/${deck}/tokens`,
      json({ name: 'Alice' }, { cookie })
    );
    expect(res.status).toBe(201);
    const { shareToken } = await readJson(res);
    expect(shareToken.remembersResponses).toBe(true);

    const off = await app.app.request(`/api/v1/presentations/${deck}/tokens/${shareToken.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ remembersResponses: false })
    });
    expect(off.status).toBe(200);
    expect((await readJson(off)).remembersResponses).toBe(false);

    const preview = await app.app.request(
      `/api/v1/presentations/${deck}/preview-token`,
      json({}, { cookie })
    );
    expect(preview.status).toBe(201);
    expect((await readJson(preview)).shareToken.remembersResponses).toBe(false);
  });

  it('hands the deck document exactly one boolean: remembers true on a remembering link', async () => {
    const { secret } = await createToken({ name: 'Alice', remembersResponses: true }, deck);
    const html = await (await fetchEntry(secret)).text();
    const config = /<script data-slideless-forms>[\s\S]*?var CFG=(\{[^\n]*?\});/.exec(html)?.[1];
    expect(config).toBeDefined();
    const cfg = JSON.parse(config!);
    expect(cfg.remembers).toBe(true);
    expect(Object.keys(cfg).sort()).toEqual(
      ['emailAvailable', 'placement', 'remembers', 'source', 'unlock', 'version'].sort()
    );
    // Nothing identifying anywhere in the served document, remembering or not.
    expect(html).not.toContain(ownerUserId);
    expect(html).not.toContain(OWNER.email);
  });

  it('a submit without any secret creates the link’s remembered row; the next one updates it in place', async () => {
    const { secret, id: tokenId } = await createToken({ name: 'Alice', remembersResponses: true }, deck);
    const first = await submit(secret, 'rsvp', { payload: { name: 'Alice', dish: 'pie' } });
    expect(first.status).toBe(201);
    const c = await readJson(first);
    expect(c.remembered).toBe(true);
    expect(c.edited).toBe(false);
    expect(c.editSecret).toBeUndefined(); // the LINK is the handle
    expect(respondentKeys(c.response)).toEqual(RESPONDENT_WIRE_KEYS);

    const second = await submit(secret, 'rsvp', { payload: { name: 'Alice', dish: 'tart' } });
    expect(second.status).toBe(200);
    const u = await readJson(second);
    expect(u.remembered).toBe(true);
    expect(u.edited).toBe(true);
    expect(u.response.id).toBe(c.response.id);
    expect(u.response.payload).toEqual({ name: 'Alice', dish: 'tart' });

    // One row on the link, at revision 2, in the owner's list.
    const listed = await ownerList(deck, `?token=${tokenId}`);
    expect(listed.responses).toHaveLength(1);
    expect(listed.responses[0].revision).toBe(2);
    expect(listed.responses[0].payload).toEqual({ name: 'Alice', dish: 'tart' });

    // The probe brings the answers back — and only the respondent's own envelope.
    const probe = await remembered(secret);
    expect(probe.status).toBe(200);
    const rows = (await readJson(probe)).responses;
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toEqual({ name: 'Alice', dish: 'tart' });
    expect(respondentKeys(rows[0])).toEqual(RESPONDENT_WIRE_KEYS);

    // The form-bound own-row routes resolve by the link alone too.
    const me = await getMe(secret, 'rsvp');
    expect(me.status).toBe(200);
    expect((await readJson(me)).response.id).toBe(c.response.id);
    const put = await putMe(secret, 'rsvp', { payload: { name: 'Alice', dish: 'soup' } });
    expect(put.status).toBe(200);
    expect((await readJson(await getMe(secret, 'rsvp'))).response.payload).toEqual({
      name: 'Alice',
      dish: 'soup'
    });
    // …but a form the link never answered is a plain 404, and the email leg needs the fragment secret.
    expect((await getMe(secret, 'feedback')).status).toBe(404);
    expect((await emailMe(secret, 'rsvp', { email: 'a@b.co' })).status).toBe(404);
  });

  it('PROPERTY 1: a respondent on one remembering link can never read or restore another’s answers', async () => {
    const alice = await createToken({ name: 'Alice', remembersResponses: true }, deck);
    const bob = await createToken({ name: 'Bob', remembersResponses: true }, deck);
    expect((await submit(alice.secret, 'rsvp', { payload: { name: 'Alice' } })).status).toBe(201);
    expect((await submit(bob.secret, 'rsvp', { payload: { name: 'Bob' } })).status).toBe(201);

    // Each link's probe lists its own row and nothing else.
    const aliceRows = (await readJson(await remembered(alice.secret))).responses;
    const bobRows = (await readJson(await remembered(bob.secret))).responses;
    expect(aliceRows.map((r: { payload: unknown }) => r.payload)).toEqual([{ name: 'Alice' }]);
    expect(bobRows.map((r: { payload: unknown }) => r.payload)).toEqual([{ name: 'Bob' }]);

    // Bob's next submit updates BOB's row; Alice's stays.
    expect((await submit(bob.secret, 'rsvp', { payload: { name: 'Bob 2' } })).status).toBe(200);
    expect((await readJson(await getMe(alice.secret, 'rsvp'))).response.payload).toEqual({ name: 'Alice' });
    expect((await readJson(await getMe(bob.secret, 'rsvp'))).response.payload).toEqual({ name: 'Bob 2' });

    // A link that does not remember gets nothing from either: 404 on the
    // probe, a fresh row on submit, and no way to name another link's row.
    const plain = await createToken({ name: 'Plain' }, deck);
    expect((await remembered(plain.secret)).status).toBe(404);
    expect((await getMe(plain.secret, 'rsvp')).status).toBe(404);
    const fresh = await submit(plain.secret, 'rsvp', { payload: { name: 'Nobody' } });
    expect(fresh.status).toBe(201);
    expect((await readJson(fresh)).remembered).toBe(false);
    expect((await readJson(await getMe(alice.secret, 'rsvp'))).response.payload).toEqual({ name: 'Alice' });

    // The database holds exactly one remembered row per (link, form).
    const rows = await app.db.db
      .select({
        token: formResponses.shareTokenId,
        form: formResponses.formName,
        remembered: formResponses.remembered
      })
      .from(formResponses)
      .where(eq(formResponses.presentationId, deck));
    const remembering = rows.filter((r) => r.remembered);
    const keys = remembering.map((r) => `${r.token}:${r.form}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('PROPERTY 2: a preview token never creates or resolves a remembered response, even with its columns forced', async () => {
    const preview = await app.app.request(
      `/api/v1/presentations/${deck}/preview-token`,
      json({}, { cookie })
    );
    const { secret, shareToken } = await readJson(preview);
    // As minted: forms off, so the surface refuses outright.
    expect((await submit(secret, 'rsvp', { payload: { x: '1' } })).status).toBe(403);
    expect((await remembered(secret)).status).toBe(403);
    // Belt and braces: force the columns a bug might set, keep the purpose.
    await app.db.db
      .update(shareTokens)
      .set({ canSubmitForms: true, remembersResponses: true })
      .where(eq(shareTokens.id, shareToken.id));
    expect((await remembered(secret)).status).toBe(404);
    const res = await submit(secret, 'rsvp', { payload: { x: '1' } });
    expect(res.status).toBe(201);
    expect((await readJson(res)).remembered).toBe(false);
    const rows = await app.db.db
      .select({ remembered: formResponses.remembered })
      .from(formResponses)
      .where(eq(formResponses.shareTokenId, shareToken.id));
    expect(rows.every((r) => !r.remembered)).toBe(true);
    await app.db.db.delete(formResponses).where(eq(formResponses.shareTokenId, shareToken.id));
  });

  it('an embed submission on a remembering link is its own row and never touches the remembered one', async () => {
    const { secret, id: tokenId } = await createToken({ name: 'Alice', remembersResponses: true }, deck);
    expect((await submit(secret, 'rsvp', { payload: { name: 'Alice' } })).status).toBe(201);
    const visitor = await submit(secret, 'rsvp', {
      payload: { name: 'Visitor' },
      source: 'embed',
      placement: 'site'
    });
    expect(visitor.status).toBe(201);
    const v = await readJson(visitor);
    expect(v.remembered).toBe(false);
    expect(v.editSecret).toBeDefined();
    const listed = await ownerList(deck, `?token=${tokenId}`);
    expect(listed.responses).toHaveLength(2);
    expect((await readJson(await getMe(secret, 'rsvp'))).response.payload).toEqual({ name: 'Alice' });
    // And the visitor's fragment path still reaches ONLY the visitor's row.
    const own = await getMe(secret, 'rsvp', { 'x-slideless-response': v.editSecret });
    expect((await readJson(own)).response.payload).toEqual({ name: 'Visitor' });
  });

  it('a fragment secret minted before the link remembered keeps working through the link', async () => {
    const { secret, id: tokenId } = await createToken({ name: 'Alice' }, deck);
    const created = await readJson(await submit(secret, 'rsvp', { payload: { name: 'early' } }));
    await app.app.request(`/api/v1/presentations/${deck}/tokens/${tokenId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ remembersResponses: true })
    });
    const put = await putMe(
      secret,
      'rsvp',
      { payload: { name: 'later' } },
      { 'x-slideless-response': created.editSecret }
    );
    expect(put.status).toBe(200);
    // The old row was never remembered, so the link still has no remembered row of its own.
    expect((await remembered(secret)).status).toBe(200);
    expect((await readJson(await remembered(secret))).responses).toEqual([]);
  });

  it('two concurrent first submits on one remembering link end as ONE row, both answers kept as revisions', async () => {
    const { secret, id: tokenId } = await createToken({ name: 'Race', remembersResponses: true }, deck);
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, i) => submit(secret, 'rsvp', { payload: { n: String(i) } }))
    );
    for (const r of results) expect([200, 201]).toContain(r.status);
    const listed = await ownerList(deck, `?token=${tokenId}`);
    expect(listed.responses).toHaveLength(1);
    expect(listed.responses[0].revision).toBe(4);
  });
});

// ═══ Every edit is a version (PRDCT-2329) ════════════════════════════════════

describe('edit history (PRDCT-2329)', () => {
  let deck: string;
  beforeAll(async () => {
    deck = await uploadDeck('History Deck', [entryOf('index.html', HTML_V1)]);
  });

  it('the create is revision 1, each edit appends; the owner reads the history newest first with its attribution', async () => {
    const { secret } = await createToken({ name: 'Alice' }, deck);
    const created = await readJson(
      await submit(secret, 'rsvp', { payload: { dish: 'pie' }, placement: 'first' })
    );
    expect(created.response.revision).toBeUndefined(); // never on the respondent wire
    const put = await putMe(
      secret,
      'rsvp',
      { payload: { dish: 'tart' }, placement: 'second' },
      { 'x-slideless-response': created.editSecret }
    );
    expect(put.status).toBe(200);
    expect(Object.keys((await readJson(put)).response).sort()).toEqual(RESPONDENT_WIRE_KEYS);

    const res = await ownerDetail(deck, created.response.id);
    expect(res.status).toBe(200);
    const detail = await readJson(res);
    expect(detail.response.revision).toBe(2);
    expect(detail.response.payload).toEqual({ dish: 'tart' });
    expect(detail.versions.map((v: { revision: number }) => v.revision)).toEqual([2, 1]);
    expect(detail.versions[0].payload).toEqual({ dish: 'tart' });
    expect(detail.versions[0].placement).toBe('second');
    expect(detail.versions[1].payload).toEqual({ dish: 'pie' });
    expect(detail.versions[1].placement).toBe('first');
    expect(detail.versions[1].shareTokenName).toBe('Alice');
    // No identity, on any revision.
    for (const v of detail.versions) {
      expect(v.respondentUserId).toBeUndefined();
      expect(v.respondentEmail).toBeUndefined();
    }
  });

  it('PROPERTY 3: nothing on the respondent wire carries the history or a revision, on any route', async () => {
    const { secret } = await createToken({ name: 'Alice', remembersResponses: true }, deck);
    const first = await readJson(await submit(secret, 'rsvp', { payload: { a: '1' } }));
    const second = await readJson(await submit(secret, 'rsvp', { payload: { a: '2' } }));
    const probe = await readJson(await remembered(secret));
    const me = await readJson(await getMe(secret, 'rsvp'));
    for (const wire of [first.response, second.response, probe.responses[0], me.response]) {
      expect(Object.keys(wire).sort()).toEqual(RESPONDENT_WIRE_KEYS);
    }
    for (const body of [first, second, probe, me]) {
      expect(JSON.stringify(body)).not.toContain('"revision"');
      expect(JSON.stringify(body)).not.toContain('"versions"');
    }
    // After the edit, the earlier answer is nowhere on the respondent wire.
    for (const body of [second, probe, me]) {
      expect(JSON.stringify(body)).not.toContain('"a":"1"');
    }
  });

  it('an edited response resurfaces: the list orders by last activity, the summary’s last activity is the edit, since reads activity', async () => {
    const listDeck = await uploadDeck('Activity Deck', [entryOf('index.html', HTML_V1)]);
    const { secret } = await createToken({ name: 'L' }, listDeck);
    const r1 = await readJson(await submit(secret, 'rsvp', { payload: { n: '1' } }));
    await sleep(15);
    const r2 = await readJson(await submit(secret, 'rsvp', { payload: { n: '2' } }));
    await sleep(15);
    const cutoff = new Date().toISOString();
    await sleep(15);
    const edit = await putMe(
      secret,
      'rsvp',
      { payload: { n: '1b' } },
      { 'x-slideless-response': r1.editSecret }
    );
    expect(edit.status).toBe(200);
    const editedAt = (await readJson(edit)).response.updatedAt;

    const listed = await ownerList(listDeck);
    expect(listed.responses.map((r: { id: string }) => r.id)).toEqual([r1.response.id, r2.response.id]);

    const summary = await readJson(
      await app.app.request(`/api/v1/presentations/${listDeck}/responses/summary`, { headers: { cookie } })
    );
    expect(summary.buckets[0].lastResponseAt).toBe(editedAt);

    // `since` after both creates and before the edit: only the edited one.
    const since = await ownerList(listDeck, `?since=${encodeURIComponent(cutoff)}`);
    expect(since.responses.map((r: { id: string }) => r.id)).toEqual([r1.response.id]);

    // Keyset pagination on the activity order stays gap-free.
    const page1 = await ownerList(listDeck, '?limit=1');
    expect(page1.responses.map((r: { id: string }) => r.id)).toEqual([r1.response.id]);
    const page2 = await ownerList(listDeck, `?limit=1&cursor=${page1.nextCursor}`);
    expect(page2.responses.map((r: { id: string }) => r.id)).toEqual([r2.response.id]);
    expect(page2.nextCursor).toBeNull();
  });

  it('keeps at most 100 revisions: the first and the latest 99 survive a hundred and one edits', async () => {
    const { secret } = await createToken({ name: 'Editor' }, deck);
    const created = await readJson(await submit(secret, 'rsvp', { payload: { n: '1' } }));
    for (let i = 2; i <= 102; i++) {
      const res = await putMe(
        secret,
        'rsvp',
        { payload: { n: String(i) } },
        { 'x-slideless-response': created.editSecret }
      );
      expect(res.status).toBe(200);
    }
    const detail = await readJson(await ownerDetail(deck, created.response.id));
    expect(detail.response.revision).toBe(102);
    const revisions = detail.versions.map((v: { revision: number }) => v.revision);
    expect(revisions).toHaveLength(100);
    expect(revisions[0]).toBe(102);
    expect(revisions[revisions.length - 1]).toBe(1);
    expect(revisions).not.toContain(2);
    expect(revisions).not.toContain(3);
    expect(revisions).toContain(4);
    expect(detail.versions[revisions.length - 1].payload).toEqual({ n: '1' });
  }, 60_000);

  it('deleting a response removes its history; a plain member never sees the detail', async () => {
    const { secret } = await createToken({ name: 'Gone' }, deck);
    const created = await readJson(await submit(secret, 'rsvp', { payload: { n: '1' } }));
    await putMe(secret, 'rsvp', { payload: { n: '2' } }, { 'x-slideless-response': created.editSecret });
    const before = await app.db.db
      .select({ id: formResponseVersions.id })
      .from(formResponseVersions)
      .where(eq(formResponseVersions.responseId, created.response.id));
    expect(before).toHaveLength(2);
    const del = await app.app.request(`/api/v1/presentations/${deck}/responses/${created.response.id}`, {
      method: 'DELETE',
      headers: { cookie }
    });
    expect(del.status).toBe(200);
    const after = await app.db.db
      .select({ id: formResponseVersions.id })
      .from(formResponseVersions)
      .where(eq(formResponseVersions.responseId, created.response.id));
    expect(after).toHaveLength(0);
    expect((await ownerDetail(deck, created.response.id)).status).toBe(404);
  });
});

// ═══ The owner is told (PRDCT-2330) ══════════════════════════════════════════

describe('owner mails (PRDCT-2330)', () => {
  let mailApp: TestApp;
  let mailBox: RecordingEmailDriver;
  let mailCookie: string;
  let mailWorkspace: string;
  const M_OWNER = { email: 'owner@mail.test', name: 'Mail Owner', password: 'mail-owner-pass-1' };
  const COOLDOWN_MS = 400;

  const mSubmit = (secret: string, form: string, body: unknown, headers: Record<string, string> = {}) =>
    mailApp.app.request(`/api/v1/viewer/${secret}/forms/${form}/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'null',
        'x-forwarded-for': nextIp(),
        ...headers
      },
      body: JSON.stringify(body)
    });
  const mPut = (secret: string, form: string, body: unknown, headers: Record<string, string> = {}) =>
    mailApp.app.request(`/api/v1/viewer/${secret}/forms/${form}/responses/me`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        origin: 'null',
        'x-forwarded-for': nextIp(),
        ...headers
      },
      body: JSON.stringify(body)
    });
  async function mDeck(title: string): Promise<string> {
    const bytes = HTML_V1;
    const form = new FormData();
    form.set('sha256', shaOf(bytes));
    form.set('file', new Blob([new Uint8Array(bytes)], { type: 'text/html' }), 'index.html');
    await mailApp.app.request('/api/v1/presentations/assets', {
      method: 'POST',
      headers: { cookie: mailCookie },
      body: form
    });
    const reserve = await readJson(
      await mailApp.app.request('/api/v1/presentations/uploads', {
        method: 'POST',
        headers: { cookie: mailCookie }
      })
    );
    const commit = await mailApp.app.request(
      `/api/v1/presentations/uploads/${reserve.uploadSession.id}/commit`,
      json(
        { title, entryPath: 'index.html', manifest: [entryOf('index.html', bytes)] },
        { cookie: mailCookie }
      )
    );
    expect(commit.status).toBe(201);
    return reserve.uploadSession.presentationId;
  }
  async function mToken(deck: string, body: Record<string, unknown>): Promise<string> {
    const res = await mailApp.app.request(
      `/api/v1/presentations/${deck}/tokens`,
      json(body, { cookie: mailCookie })
    );
    expect(res.status).toBe(201);
    return (await readJson(res)).secret;
  }
  const drained = async () => {
    await mailApp.formsNotifier.drain();
    return mailBox.sent;
  };

  beforeAll(async () => {
    mailBox = new RecordingEmailDriver();
    mailApp = await createTestApp(
      await createDatabase(container, 'forms_mail'),
      { PUBLIC_BASE_URL: 'https://decks.example.test' },
      { email: mailBox, formsMailCooldownMs: COOLDOWN_MS }
    );
    await mailApp.app.request(
      '/api/v1/setup',
      json({ setupToken: 'integration-test-setup-token', instanceName: 'Mail', owner: M_OWNER })
    );
    mailCookie = extractCookie(
      await mailApp.app.request(
        '/api/v1/auth/sign-in/email',
        json({ email: M_OWNER.email, password: M_OWNER.password })
      )
    );
    const me = await readJson(await mailApp.app.request('/api/v1/me', { headers: { cookie: mailCookie } }));
    mailWorkspace = me.workspace.id;
    void mailWorkspace;
  }, 120_000);

  afterAll(async () => {
    await mailApp?.stop();
  });

  it('mails the deck owner on a new response, and a DIFFERENT mail on an edit — never the answers', async () => {
    const deck = await mDeck('Kituo questionnaire');
    const secret = await mToken(deck, { name: 'Client contact', remembersResponses: false });
    const created = await readJson(
      await mSubmit(secret, 'rsvp', { payload: { name: 'Secret Person', dish: 'pie' } })
    );
    let sent = await drained();
    expect(sent).toHaveLength(1);
    const first = sent[0]!;
    expect(first.to).toBe(M_OWNER.email);
    expect(first.subject).toBe('New response on "Kituo questionnaire"');
    expect(first.html).toContain('Kituo questionnaire');
    expect(first.html).toContain('rsvp');
    expect(first.html).toContain('Client contact');
    expect(first.html).toContain(deckMasterUrl('https://decks.example.test', deck));
    for (const body of [first.html, first.text ?? '']) {
      expect(body).not.toContain('Secret Person');
      expect(body).not.toContain('pie');
    }

    await sleep(COOLDOWN_MS + 50);
    const edit = await mPut(
      secret,
      'rsvp',
      { payload: { name: 'Secret Person', dish: 'tart' } },
      { 'x-slideless-response': created.editSecret }
    );
    expect(edit.status).toBe(200);
    sent = await drained();
    expect(sent).toHaveLength(2);
    const second = sent[1]!;
    expect(second.subject).toBe('A response on "Kituo questionnaire" was edited');
    expect(second.subject).not.toBe(first.subject);
    expect(second.html).toContain('revision 2');
    expect(second.html).not.toContain('tart');
    expect(second.text).not.toContain('tart');
  });

  it('one mail per deck per window: a burst inside the window is counted and carried by the next mail', async () => {
    const deck = await mDeck('RSVP wall');
    const secret = await mToken(deck, { name: 'Public', remembersResponses: false });
    const before = mailBox.sent.length;
    expect((await mSubmit(secret, 'rsvp', { payload: { n: '1' } })).status).toBe(201);
    await drained();
    expect(mailBox.sent.length).toBe(before + 1);
    // Three more inside the window: no mail, all counted.
    const held = await readJson(await mSubmit(secret, 'rsvp', { payload: { n: '2' } }));
    expect((await mSubmit(secret, 'rsvp', { payload: { n: '3' } })).status).toBe(201);
    expect(
      (await mPut(secret, 'rsvp', { payload: { n: '2b' } }, { 'x-slideless-response': held.editSecret }))
        .status
    ).toBe(200);
    await drained();
    expect(mailBox.sent.length).toBe(before + 1);
    // After the window, the next event mails and says what was held back.
    await sleep(COOLDOWN_MS + 50);
    expect((await mSubmit(secret, 'rsvp', { payload: { n: '4' } })).status).toBe(201);
    await drained();
    expect(mailBox.sent.length).toBe(before + 2);
    const digest = mailBox.sent[mailBox.sent.length - 1]!;
    expect(digest.subject).toBe('New response on "RSVP wall"');
    expect(digest.text).toContain('2 other new responses and 1 other edit arrived too');
  });

  it('the per-deck switch silences the mails without touching forms; the wire carries it; PATCH alone flips it', async () => {
    const deck = await mDeck('Quiet deck');
    const read = await readJson(
      await mailApp.app.request(`/api/v1/presentations/${deck}`, { headers: { cookie: mailCookie } })
    );
    expect(read.notifyOnResponse).toBe(true);
    const off = await mailApp.app.request(`/api/v1/presentations/${deck}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: mailCookie },
      body: JSON.stringify({ notifyOnResponse: false })
    });
    expect(off.status).toBe(200);
    expect((await readJson(off)).notifyOnResponse).toBe(false);

    const secret = await mToken(deck, { name: 'Alice' });
    const before = mailBox.sent.length;
    expect((await mSubmit(secret, 'rsvp', { payload: { n: '1' } })).status).toBe(201);
    expect((await mSubmit(secret, 'rsvp', { payload: { n: '2' } })).status).toBe(200);
    await drained();
    expect(mailBox.sent.length).toBe(before);

    const on = await mailApp.app.request(`/api/v1/presentations/${deck}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: mailCookie },
      body: JSON.stringify({ notifyOnResponse: true })
    });
    expect((await readJson(on)).notifyOnResponse).toBe(true);
    expect((await mSubmit(secret, 'rsvp', { payload: { n: '3' } })).status).toBe(200);
    await drained();
    expect(mailBox.sent.length).toBe(before + 1);
    expect(mailBox.sent[mailBox.sent.length - 1]!.subject).toBe('A response on "Quiet deck" was edited');
  });

  it('a remembering link’s first submit is a new-response mail, its later submits are edit mails', async () => {
    const deck = await mDeck('Remembering deck');
    const secret = await mToken(deck, { name: 'Alice' });
    const before = mailBox.sent.length;
    expect((await mSubmit(secret, 'rsvp', { payload: { n: '1' } })).status).toBe(201);
    await drained();
    expect(mailBox.sent[before]!.subject).toBe('New response on "Remembering deck"');
    await sleep(COOLDOWN_MS + 50);
    expect((await mSubmit(secret, 'rsvp', { payload: { n: '2' } })).status).toBe(200);
    await drained();
    expect(mailBox.sent[before + 1]!.subject).toBe('A response on "Remembering deck" was edited');
  });
});
