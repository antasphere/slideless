import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { VIEWER_CSP } from '../../src/viewer/routes.js';
import { OVERLAY_MARKER } from '../../src/viewer/overlay.js';
import { TOPBAR_MARKER } from '../../src/viewer/topbar.js';
import {
  createDatabase,
  createTestApp,
  extractCookie,
  readJson,
  startPostgres,
  type TestApp
} from './helpers.js';

/**
 * The recipient TOP BAR (PRDCT-2281) against the booted app:
 *
 *  - the per-link switch `showBar`, on by default, on the create and patch
 *    surfaces and on the wire shape;
 *  - injection on browser DOCUMENT navigations only — the entry and an HTML
 *    sub-page opened top-level — with the sandbox header set intact and no
 *    ETag; a frame navigation, ?raw, an agent fetch and an agent password
 *    unlock stay byte-exact; a `showBar:false` link streams byte-exact with
 *    its ETag;
 *  - the password gate and the error shells (404, 403, 410) never carry it;
 *  - the injected config is a CLOSED set (title, version, unlock,
 *    downloads): a deck title cannot break out of the script tag, the
 *    download hint is off on a plain deck and on a link with downloads off,
 *    the unlock proof rides a password link once unlocked.
 */

const OWNER = { email: 'owner@topbar.test', name: 'Bar Owner', password: 'bar-owner-password-1' };

const HTML = Buffer.from(
  '<!doctype html><html><head><title>Deck</title></head><body><h1 style="height:100vh">Quarterly review</h1>' +
    '<a href="pages/two.html">next</a></body></html>'
);
const HTML_PAGE2 = Buffer.from('<!doctype html><html><body><h1>Second page</h1></body></html>');
const CSV = Buffer.from('quarter,revenue\nQ3,42\n');
const PDF = Buffer.from('%PDF-1.4 annex');

const shaOf = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const entryOf = (path: string, bytes: Buffer, contentType: string) => ({
  path,
  sha256: shaOf(bytes),
  sizeBytes: bytes.length,
  contentType
});

let container: StartedPostgreSqlContainer;
let app: TestApp;
let cookie: string;
/** "Quarterly review": two pages, two attachments. */
let deckId: string;
/** "Plain deck": one page, no downloads/ folder. */
let plainDeckId: string;
/** A deck whose title tries to close the script tag. */
let hostileDeckId: string;

let ipCounter = 0;
const nextIp = () => `10.97.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp(), ...headers },
  body: JSON.stringify(body)
});

const get = (path: string, headers: Record<string, string> = {}) =>
  app.app.request(path, { headers: { 'x-forwarded-for': nextIp(), ...headers } });

/** A modern browser's top-level navigation. */
const NAV = { accept: 'text/html,application/xhtml+xml', 'sec-fetch-dest': 'document' };
/** The same browser loading the deck inside an iframe (an embed). */
const FRAMED = { accept: 'text/html', 'sec-fetch-dest': 'iframe' };

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

async function createDeck(title: string, manifest: ReturnType<typeof entryOf>[]): Promise<string> {
  const reserve = await readJson(
    await app.app.request('/api/v1/presentations/uploads', { method: 'POST', headers: { cookie } })
  );
  const commit = await app.app.request(
    `/api/v1/presentations/uploads/${reserve.uploadSession.id}/commit`,
    json({ title, entryPath: 'index.html', manifest }, { cookie })
  );
  expect(commit.status).toBe(201);
  return (await readJson(commit)).presentation.id as string;
}

async function createToken(deck: string, body: Record<string, unknown>) {
  const res = await app.app.request(`/api/v1/presentations/${deck}/tokens`, json(body, { cookie }));
  expect(res.status).toBe(201);
  return readJson(res);
}

function expectSandboxHeaders(res: Response): void {
  expect(res.headers.get('content-security-policy')).toBe(VIEWER_CSP);
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  expect(res.headers.get('referrer-policy')).toBe('no-referrer');
}

/** The injected config object, or null when the bar is not in the document. */
function configOf(html: string): Record<string, unknown> | null {
  const m = /<script data-slideless-topbar>[\s\S]*?var CFG=(\{[^\n]*?\});/.exec(html);
  return m ? (JSON.parse(m[1]!) as Record<string, unknown>) : null;
}

beforeAll(async () => {
  container = await startPostgres();
  app = await createTestApp(await createDatabase(container, 'viewer_topbar'));
  await app.app.request(
    '/api/v1/setup',
    json({ setupToken: 'integration-test-setup-token', instanceName: 'Bar', owner: OWNER })
  );
  cookie = extractCookie(
    await app.app.request(
      '/api/v1/auth/sign-in/email',
      json({ email: OWNER.email, password: OWNER.password })
    )
  );
  await uploadAsset(HTML, 'text/html', 'index.html');
  await uploadAsset(HTML_PAGE2, 'text/html', 'pages/two.html');
  await uploadAsset(CSV, 'text/csv', 'figures.csv');
  await uploadAsset(PDF, 'application/pdf', 'annex.pdf');
  deckId = await createDeck('Quarterly review', [
    entryOf('index.html', HTML, 'text/html'),
    entryOf('pages/two.html', HTML_PAGE2, 'text/html'),
    entryOf('downloads/figures.csv', CSV, 'text/csv'),
    entryOf('downloads/annex.pdf', PDF, 'application/pdf')
  ]);
  plainDeckId = await createDeck('Plain deck', [entryOf('index.html', HTML, 'text/html')]);
  hostileDeckId = await createDeck('</script><script>alert(1)</script>', [
    entryOf('index.html', HTML, 'text/html')
  ]);
}, 120_000);

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

// ═══ The switch ══════════════════════════════════════════════════════════════

describe('showBar, the per-link switch', () => {
  it('is on by default, off when asked, and on the wire shape of every list', async () => {
    const on = await createToken(deckId, { name: 'default' });
    expect(on.shareToken.showBar).toBe(true);
    const off = await createToken(deckId, { name: 'bare', showBar: false });
    expect(off.shareToken.showBar).toBe(false);
    const list = await readJson(await get(`/api/v1/presentations/${deckId}/tokens`, { cookie }));
    const byId = new Map(list.shareTokens.map((t: { id: string; showBar: boolean }) => [t.id, t.showBar]));
    expect(byId.get(on.shareToken.id)).toBe(true);
    expect(byId.get(off.shareToken.id)).toBe(false);
  });

  it('the column itself defaults to true: a row written without it reads on (verifier round 2, F6)', async () => {
    // The API always sends the schema default, so only a raw insert exercises
    // the migration's DEFAULT — the value every pre-existing link received.
    const inserted = await app.db.db.execute(sql`
      INSERT INTO share_tokens (workspace_id, presentation_id, name, token_hash)
      SELECT workspace_id, id, 'raw insert', 'raw-insert-hash-' || gen_random_uuid()::text
      FROM presentations WHERE id = ${deckId}
      RETURNING show_bar, can_download`);
    const row = (inserted.rows as Array<{ show_bar: boolean; can_download: boolean }>)[0];
    expect(row?.show_bar).toBe(true);
    expect(row?.can_download).toBe(true);
  });

  it('flips on a PATCH and is recorded on the create audit row', async () => {
    const created = await createToken(deckId, { name: 'flip' });
    const patched = await app.app.request(`/api/v1/presentations/${deckId}/tokens/${created.shareToken.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ showBar: false })
    });
    expect(patched.status).toBe(200);
    expect((await readJson(patched)).showBar).toBe(false);
    // The deck now streams bare on a browser navigation.
    const bare = await get(`/v/${created.secret}/`, NAV);
    expect(bare.status).toBe(200);
    expect(await bare.text()).not.toContain(TOPBAR_MARKER);

    const audit = await readJson(await get('/api/v1/audit?limit=50', { cookie }));
    const row = audit.entries.find(
      (e: { action: string; resourceId: string }) =>
        e.action === 'presentation.share_token_create' && e.resourceId === created.shareToken.id
    );
    expect(row?.metadata?.showBar).toBe(true);
  });
});

// ═══ Injection ═══════════════════════════════════════════════════════════════

describe('the bar rides top-level document navigations', () => {
  it('a default link on a browser navigation: the bar, sandbox headers intact, no ETag, no-store', async () => {
    const { secret } = await createToken(deckId, { name: 'browser' });
    const res = await get(`/v/${secret}/`, NAV);
    expect(res.status).toBe(200);
    expectSandboxHeaders(res);
    expect(res.headers.get('etag')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-disposition')).toBe('inline');
    const html = await res.text();
    expect(html).toContain('Quarterly review</h1>'); // the deck itself is untouched
    expect(html).toContain(TOPBAR_MARKER);
    expect(html).not.toContain(OVERLAY_MARKER); // not an annotator link
    // Injected before the LAST </body>, after the deck's own content.
    expect(html.toLowerCase().lastIndexOf('</body>')).toBeGreaterThan(html.indexOf(TOPBAR_MARKER));
    expect(html.indexOf(TOPBAR_MARKER)).toBeGreaterThan(html.indexOf('</a>'));
    // The injected config is a CLOSED set: title, version, unlock, downloads.
    // Adding a key is a trust-boundary decision (viewer/topbar.ts), not a
    // convenience — this assertion is what makes it deliberate.
    const cfg = configOf(html);
    expect(cfg).not.toBeNull();
    expect(Object.keys(cfg!).sort()).toEqual(['downloads', 'pdf', 'title', 'unlock', 'version']);
    expect(cfg).toEqual({ title: 'Quarterly review', version: 1, unlock: null, downloads: true, pdf: true });
  });

  it('an HTML sub-page opened as a document carries it too; older engines ride the Accept heuristic', async () => {
    const { secret } = await createToken(deckId, { name: 'sub-page' });
    const sub = await get(`/v/${secret}/pages/two.html`, NAV);
    expect(sub.status).toBe(200);
    expectSandboxHeaders(sub);
    expect(sub.headers.get('etag')).toBeNull();
    const html = await sub.text();
    expect(html).toContain('Second page');
    expect(html).toContain(TOPBAR_MARKER);
    // No Sec-Fetch-Dest at all (older engines): an HTML Accept is a navigation.
    const legacy = await get(`/v/${secret}/`, { accept: 'text/html' });
    expect(await legacy.text()).toContain(TOPBAR_MARKER);
  });

  it('a frame navigation is bare: an embed or an iframe shows the deck without the bar', async () => {
    const { secret } = await createToken(deckId, { name: 'framed' });
    const entry = await get(`/v/${secret}/`, FRAMED);
    expect(entry.status).toBe(200);
    expectSandboxHeaders(entry);
    expect(Buffer.from(await entry.arrayBuffer()).equals(HTML)).toBe(true);
    expect(entry.headers.get('etag')).toBe(`"${shaOf(HTML)}"`);
    const sub = await get(`/v/${secret}/pages/two.html`, FRAMED);
    expect(Buffer.from(await sub.arrayBuffer()).equals(HTML_PAGE2)).toBe(true);
  });

  it('the other sub-resource destinations stay byte-exact too: embed, object, empty (verifier round 2, F5)', async () => {
    const { secret } = await createToken(deckId, { name: 'sub-resources' });
    for (const dest of ['embed', 'object', 'empty']) {
      const res = await get(`/v/${secret}/`, { accept: 'text/html', 'sec-fetch-dest': dest });
      expect(res.status, dest).toBe(200);
      expect(Buffer.from(await res.arrayBuffer()).equals(HTML), dest).toBe(true);
      expect(res.headers.get('etag'), dest).toBe(`"${shaOf(HTML)}"`);
    }
  });

  it('?raw, agent fetches and agent password unlocks stay byte-exact', async () => {
    const { secret } = await createToken(deckId, { name: 'agents' });
    const raw = await get(`/v/${secret}/?raw`, NAV);
    expect(Buffer.from(await raw.arrayBuffer()).equals(HTML)).toBe(true);
    const format = await get(`/v/${secret}/?format=html`, NAV);
    expect(Buffer.from(await format.arrayBuffer()).equals(HTML)).toBe(true);
    // No HTML Accept, no fetch metadata: an SDK or curl.
    const agent = await get(`/v/${secret}/`);
    expect(Buffer.from(await agent.arrayBuffer()).equals(HTML)).toBe(true);
    expect(agent.headers.get('etag')).toBe(`"${shaOf(HTML)}"`);

    const locked = await createToken(deckId, { name: 'agent-locked', password: 'open-sesame' });
    const viaHeader = await get(`/v/${locked.secret}/`, { ...NAV, 'x-viewer-password': 'open-sesame' });
    expect(viaHeader.status).toBe(200);
    expect(Buffer.from(await viaHeader.arrayBuffer()).equals(HTML)).toBe(true);
  });

  it('a showBar:false link streams byte-exact with its ETag on a browser navigation', async () => {
    const { secret } = await createToken(deckId, { name: 'bare', showBar: false });
    const res = await get(`/v/${secret}/`, NAV);
    expect(res.status).toBe(200);
    expectSandboxHeaders(res);
    expect(Buffer.from(await res.arrayBuffer()).equals(HTML)).toBe(true);
    expect(res.headers.get('etag')).toBe(`"${shaOf(HTML)}"`);
    // The attachments list still answers: the bar is a display switch, not a
    // download switch.
    const list = await readJson(await get(`/api/v1/viewer/${secret}/attachments`));
    expect(list.attachments.map((a: { name: string }) => a.name)).toEqual(['figures.csv', 'annex.pdf']);
  });

  it('precedes the overlay on an annotator link, and the overlay reads the bar offset', async () => {
    const { secret } = await createToken(deckId, { name: 'annotator', canAnnotate: true });
    const html = await (await get(`/v/${secret}/`, NAV)).text();
    expect(html).toContain(TOPBAR_MARKER);
    expect(html).toContain(OVERLAY_MARKER);
    expect(html.indexOf(TOPBAR_MARKER)).toBeLessThan(html.indexOf(OVERLAY_MARKER));
    // The overlay's top slots add the bar's published height (PRDCT-2281).
    expect(html).toContain("var TOP_OFFSET = 'var(--slideless-topbar, 0px)';");
    expect(html).toContain("'top-left': { top: 'calc(20px + ' + TOP_OFFSET + ')', left: '20px' }");
  });
});

// ═══ The shells ══════════════════════════════════════════════════════════════

describe('the password gate and the error shells never carry the bar', () => {
  it('the password challenge is a bare first-party form; the unlocked entry carries the bar with the proof', async () => {
    const { secret } = await createToken(deckId, { name: 'locked', password: 'open-sesame' });
    const challenge = await get(`/v/${secret}/`, NAV);
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get('content-security-policy')).not.toContain('sandbox');
    const gate = await challenge.text();
    expect(gate).toContain('This presentation is protected');
    expect(gate).not.toContain(TOPBAR_MARKER);
    expect(gate).not.toContain('data-slideless');

    // The browser dance: the form sets the unlock cookie; the entry then
    // carries the bar, and its config the signed proof the list call needs.
    const form = new URLSearchParams({ password: 'open-sesame' });
    const post = await app.app.request(`/v/${secret}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': nextIp() },
      body: form.toString()
    });
    expect(post.status).toBe(303);
    const unlockCookie = extractCookie(post);
    const entry = await get(`/v/${secret}/`, { ...NAV, cookie: unlockCookie });
    expect(entry.status).toBe(200);
    const cfg = configOf(await entry.text());
    expect(cfg).not.toBeNull();
    expect(typeof cfg!['unlock']).toBe('string');
    expect((cfg!['unlock'] as string).length).toBeGreaterThan(20);
    // That proof authenticates the ONE call the bar makes.
    const list = await get(`/api/v1/viewer/${secret}/attachments`, {
      'x-slideless-unlock': cfg!['unlock'] as string
    });
    expect(list.status).toBe(200);
    expect((await readJson(list)).attachments).toHaveLength(2);
    // Without it the list is refused, so the proof is the bar's whole credential.
    expect((await get(`/api/v1/viewer/${secret}/attachments`)).status).toBe(401);
  });

  it('unknown → 404, revoked → 403, expired → 410: readable shells, none with the bar', async () => {
    const unknown = await get(`/v/${'A'.repeat(64)}/`, NAV);
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).not.toContain('data-slideless');

    const revokable = await createToken(deckId, { name: 'revoke me' });
    const revoke = await app.app.request(
      `/api/v1/presentations/${deckId}/tokens/${revokable.shareToken.id}`,
      {
        method: 'DELETE',
        headers: { cookie }
      }
    );
    expect(revoke.status).toBe(200);
    const revoked = await get(`/v/${revokable.secret}/`, NAV);
    expect(revoked.status).toBe(403);
    const revokedHtml = await revoked.text();
    expect(revokedHtml).toContain('Nothing to see here');
    expect(revokedHtml).not.toContain('data-slideless');

    const expired = await createToken(deckId, {
      name: 'expired',
      expiresAt: new Date(Date.now() - 60_000).toISOString()
    });
    const gone = await get(`/v/${expired.secret}/`, NAV);
    expect(gone.status).toBe(410);
    expect(await gone.text()).not.toContain('data-slideless');
  });
});

// ═══ The config ══════════════════════════════════════════════════════════════

describe('what the bar is told', () => {
  it('a plain deck and a link with downloads off both get downloads:false, so no list is fetched', async () => {
    const plain = await createToken(plainDeckId, { name: 'plain' });
    const plainCfg = configOf(await (await get(`/v/${plain.secret}/`, NAV)).text());
    expect(plainCfg).toEqual({ title: 'Plain deck', version: 1, unlock: null, downloads: false, pdf: true });

    const noDl = await createToken(deckId, { name: 'no downloads', canDownload: false });
    const noDlCfg = configOf(await (await get(`/v/${noDl.secret}/`, NAV)).text());
    expect(noDlCfg).toEqual({
      title: 'Quarterly review',
      version: 1,
      unlock: null,
      downloads: false,
      pdf: true
    });
    // And were it to ask anyway, the list would be empty, never a 403.
    const list = await readJson(await get(`/api/v1/viewer/${noDl.secret}/attachments`));
    expect(list.attachments).toEqual([]);
  });

  it('the version is the one the link resolves to: a pinned link keeps its number after a push', async () => {
    const pinned = await createToken(deckId, { name: 'pinned', versionMode: 'pinned', pinnedVersion: 1 });
    const latest = await createToken(deckId, { name: 'latest' });
    const push = await app.app.request(
      `/api/v1/presentations/${deckId}/versions`,
      json(
        {
          expectedBaseVersion: 1,
          entryPath: 'index.html',
          manifest: [
            entryOf('index.html', HTML, 'text/html'),
            entryOf('downloads/figures.csv', CSV, 'text/csv')
          ]
        },
        { cookie }
      )
    );
    expect(push.status).toBe(201);
    expect(configOf(await (await get(`/v/${pinned.secret}/`, NAV)).text())!['version']).toBe(1);
    expect(configOf(await (await get(`/v/${latest.secret}/`, NAV)).text())!['version']).toBe(2);
  });

  it('a deck title cannot close the script tag: `<` is escaped in the config', async () => {
    const { secret } = await createToken(hostileDeckId, { name: 'hostile title' });
    const res = await get(`/v/${secret}/`, NAV);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('</script><script>alert(1)');
    expect(html).toContain('\\u003c/script>\\u003cscript>alert(1)');
    expect(configOf(html)!['title']).toBe('</script><script>alert(1)</script>');
    // The deck's own tags plus exactly one injected script: nothing opened by the title.
    const deckScripts = (HTML.toString().match(/<\/script>/g) ?? []).length;
    expect((html.match(/<\/script>/g) ?? []).length).toBe(deckScripts + 1);
  });
});
