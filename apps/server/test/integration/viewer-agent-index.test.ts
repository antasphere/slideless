import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { AGENT_INDEX_MARKER } from '../../src/viewer/inject.js';
import {
  createDatabase,
  createTestApp,
  extractCookie,
  readJson,
  startPostgres,
  type TestApp
} from './helpers.js';

/**
 * SHARE LINKS READABLE BY AGENTS (PRDCT-2670) against the booted app.
 *
 * The same URL `/v/{secret}/` serves a browser the deck and anything else the
 * link's index: markdown by default, JSON on a JSON-only Accept or
 * `?format=json`, the byte-exact deck on `?raw` / `?format=html`. The index
 * lists only what the link allows (no downloads section with downloads off),
 * inlines AGENT.md, sits behind the password gate, counts as an agent read
 * (never a view, never a cookie), and is never indexable. A document that
 * carries a runtime points agents at it with a discovery `<link>`.
 */

const OWNER = { email: 'owner@agent-index.test', name: 'Index Owner', password: 'index-owner-password-1' };

const HTML = Buffer.from(
  '<!doctype html><html><head><title>Deck</title></head><body><h1>Quarterly review</h1>' +
    '<a href="pages/two.html">next</a></body></html>'
);
const HTML_PAGE2 = Buffer.from('<!doctype html><html><body><h1>Second page</h1></body></html>');
const CSS = Buffer.from('h1{color:#222}\n'.repeat(200));
const CSV = Buffer.from('quarter,revenue\nQ3,42\n');
const PDF = Buffer.from('%PDF-1.4 annex');
const AGENT_MD = Buffer.from('# About this deck\n\nThe Q3 review for the board. Figures are in EUR.\n');

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
/** "Quarterly review": two pages, a stylesheet, two attachments, AGENT.md. */
let deckId: string;
/** "Plain deck": one page, nothing else. */
let plainDeckId: string;

let ipCounter = 0;
const nextIp = () => `10.96.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp(), ...headers },
  body: JSON.stringify(body)
});

const get = (path: string, headers: Record<string, string> = {}) =>
  app.app.request(path, { headers: { 'x-forwarded-for': nextIp(), ...headers } });
const head = (path: string, headers: Record<string, string> = {}) =>
  app.app.request(path, { method: 'HEAD', headers: { 'x-forwarded-for': nextIp(), ...headers } });

/** A modern browser's top-level navigation. */
const NAV = { accept: 'text/html,application/xhtml+xml', 'sec-fetch-dest': 'document' };

const BASE = 'http://localhost:3000';

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

async function tokenOnWire(deck: string, tokenId: string) {
  const list = await readJson(await get(`/api/v1/presentations/${deck}/tokens`, { cookie }));
  return list.shareTokens.find((t: { id: string }) => t.id === tokenId) as Record<string, unknown>;
}

function expectIndexHeaders(res: Response, type: 'text/markdown' | 'application/json'): void {
  expect(res.headers.get('content-type')).toBe(`${type}; charset=utf-8`);
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(res.headers.get('vary')).toBe('accept');
  expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  expect(res.headers.get('etag')).toBeNull();
  expect(res.headers.get('set-cookie')).toBeNull();
}

beforeAll(async () => {
  container = await startPostgres();
  app = await createTestApp(await createDatabase(container, 'viewer_agent_index'));
  await app.app.request(
    '/api/v1/setup',
    json({ setupToken: 'integration-test-setup-token', instanceName: 'Index', owner: OWNER })
  );
  cookie = extractCookie(
    await app.app.request(
      '/api/v1/auth/sign-in/email',
      json({ email: OWNER.email, password: OWNER.password })
    )
  );
  await uploadAsset(HTML, 'text/html', 'index.html');
  await uploadAsset(HTML_PAGE2, 'text/html', 'pages/two.html');
  await uploadAsset(CSS, 'text/css', 'style.css');
  await uploadAsset(CSV, 'text/csv', 'figures.csv');
  await uploadAsset(PDF, 'application/pdf', 'annex.pdf');
  await uploadAsset(AGENT_MD, 'text/markdown', 'AGENT.md');
  deckId = await createDeck('Quarterly review', [
    entryOf('index.html', HTML, 'text/html'),
    entryOf('pages/two.html', HTML_PAGE2, 'text/html'),
    entryOf('style.css', CSS, 'text/css'),
    entryOf('AGENT.md', AGENT_MD, 'text/markdown'),
    entryOf('downloads/figures.csv', CSV, 'text/csv'),
    entryOf('downloads/annex.pdf', PDF, 'application/pdf')
  ]);
  plainDeckId = await createDeck('Plain deck', [entryOf('index.html', HTML, 'text/html')]);
}, 120_000);

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

// ═══ Content negotiation ═════════════════════════════════════════════════════

describe('one URL, two readers', () => {
  it('no Accept: the markdown index with the title, the file table and the sizes', async () => {
    const { secret } = await createToken(deckId, { name: 'curl' });
    const res = await get(`/v/${secret}/`);
    expect(res.status).toBe(200);
    expectIndexHeaders(res, 'text/markdown');
    const md = await res.text();
    const base = `${BASE}/v/${secret}/`;
    expect(md.startsWith('# Quarterly review\n')).toBe(true);
    expect(md).toContain(
      'A Slideless deck shared through a link. Version 1, follows the latest version. Kind: presentation.'
    );
    expect(md).toContain('## What this link allows');
    expect(md).toContain('- Downloads: yes');
    expect(md).toContain('- Annotations (notes on the deck): no');
    expect(md).toContain('- Form submissions: yes');
    expect(md).toContain('- PDF export: yes (an Export PDF action in the viewer prints it from a browser)');
    expect(md).toContain('- Expires: never');
    expect(md).toContain(
      `- Entry document: index.html (${HTML.length} bytes, text/html). Fetch it byte-exact at ${base}?raw`
    );
    expect(md).toContain(`- Every file of the deck is served at ${base}<path>`);
    // Every file NOT under downloads/, sorted by path, with absolute URLs.
    expect(md).toContain('## Files (4)');
    expect(md).toContain('| Path | Size | Type | URL |');
    expect(md).toContain(`| style.css | ${CSS.length} bytes (2.9 KB) | text/css | ${base}style.css |`);
    expect(md).toContain(
      `| pages/two.html | ${HTML_PAGE2.length} bytes | text/html | ${base}pages/two.html |`
    );
    const order = ['| AGENT.md', '| index.html', '| pages/two.html', '| style.css'].map((p) => md.indexOf(p));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(md).not.toMatch(/^\| downloads\//m);
    expect(md).toContain(`- Markdown index: ${base}?format=agent`);
    expect(md).toContain(`- JSON index: ${base}?format=json`);
    expect(md).toContain(
      '- A password-protected link answers 401 with password_required; send the password in the x-viewer-password header.'
    );
  });

  it('*/* is an agent too: the markdown', async () => {
    const { secret } = await createToken(deckId, { name: 'star' });
    const res = await get(`/v/${secret}/`, { accept: '*/*' });
    expect(res.status).toBe(200);
    expectIndexHeaders(res, 'text/markdown');
    expect(await res.text()).toContain('# Quarterly review');
  });

  it('application/json: the JSON twin with the documented shape', async () => {
    const { secret } = await createToken(deckId, { name: 'json' });
    const res = await get(`/v/${secret}/`, { accept: 'application/json' });
    expect(res.status).toBe(200);
    expectIndexHeaders(res, 'application/json');
    const body = await readJson(res);
    const base = `${BASE}/v/${secret}/`;
    expect(Object.keys(body).sort()).toEqual(
      ['agentDoc', 'deck', 'downloads', 'entry', 'files', 'index', 'link', 'version', 'zipUrl'].sort()
    );
    expect(body.deck).toEqual({ title: 'Quarterly review', kind: 'presentation' });
    expect(body.version).toEqual({ number: 1, mode: 'latest' });
    expect(body.link).toEqual({
      canDownload: true,
      canAnnotate: false,
      canSubmitForms: true,
      canExportPdf: true,
      expiresAt: null
    });
    expect(body.agentDoc).toBe(AGENT_MD.toString());
    expect(body.entry).toEqual({
      path: 'index.html',
      sizeBytes: HTML.length,
      contentType: 'text/html',
      url: base,
      rawUrl: `${base}?raw`
    });
    expect(body.files.map((f: { path: string }) => f.path)).toEqual([
      'AGENT.md',
      'index.html',
      'pages/two.html',
      'style.css'
    ]);
    expect(body.files[3]).toEqual({
      path: 'style.css',
      sizeBytes: CSS.length,
      contentType: 'text/css',
      url: `${base}style.css`
    });
    expect(body.downloads).toEqual([
      {
        name: 'figures.csv',
        sizeBytes: CSV.length,
        contentType: 'text/csv',
        url: `${base}downloads/figures.csv`
      },
      {
        name: 'annex.pdf',
        sizeBytes: PDF.length,
        contentType: 'application/pdf',
        url: `${base}downloads/annex.pdf`
      }
    ]);
    expect(body.zipUrl).toBe(`${base}downloads.zip`);
    expect(body.index).toEqual({ markdown: `${base}?format=agent`, json: `${base}?format=json` });
  });

  it('text/html (a browser navigation): the deck, not the index, never indexable', async () => {
    const { secret } = await createToken(deckId, { name: 'browser' });
    const res = await get(`/v/${secret}/`, NAV);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(await res.text()).toContain('Quarterly review</h1>');
  });

  it('a document navigation keeps the deck whatever it accepts (the fetch metadata is the browser)', async () => {
    const { secret } = await createToken(deckId, { name: 'nav' });
    const doc = await get(`/v/${secret}/`, { 'sec-fetch-dest': 'document' });
    expect(doc.status).toBe(200);
    expect(doc.headers.get('content-type')).toContain('text/html');
    expect(await doc.text()).toContain('<!doctype html>');
    const frame = await get(`/v/${secret}/`, { 'sec-fetch-dest': 'iframe', accept: '*/*' });
    expect(frame.headers.get('content-type')).toContain('text/html');
  });

  it('?format=agent and ?format=json win over a browser Accept', async () => {
    const { secret } = await createToken(deckId, { name: 'format' });
    const md = await get(`/v/${secret}/?format=agent`, NAV);
    expect(md.status).toBe(200);
    expectIndexHeaders(md, 'text/markdown');
    expect(await md.text()).toContain('# Quarterly review');
    const js = await get(`/v/${secret}/?format=json`, NAV);
    expect(js.status).toBe(200);
    expectIndexHeaders(js, 'application/json');
    expect((await readJson(js)).deck.title).toBe('Quarterly review');
  });

  it('?raw stays the byte-exact deck with its ETag, whatever the Accept', async () => {
    const { secret } = await createToken(deckId, { name: 'raw' });
    const res = await get(`/v/${secret}/?raw`);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(HTML)).toBe(true);
    expect(res.headers.get('etag')).toBe(`"${shaOf(HTML)}"`);
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  });
});

// ═══ What the index holds ════════════════════════════════════════════════════

describe('what the index says', () => {
  it('inlines AGENT.md when the version carries one, says so when it does not', async () => {
    const withDoc = await createToken(deckId, { name: 'doc' });
    const md = await (await get(`/v/${withDoc.secret}/`)).text();
    expect(md).toContain(
      '## Briefing for agents (AGENT.md)\n\n# About this deck\n\nThe Q3 review for the board.'
    );
    expect(md).not.toContain('This deck carries no AGENT.md.');

    const plain = await createToken(plainDeckId, { name: 'no doc' });
    const plainMd = await (await get(`/v/${plain.secret}/`)).text();
    expect(plainMd).toContain('This deck carries no AGENT.md.');
    expect((await readJson(await get(`/v/${plain.secret}/?format=json`))).agentDoc).toBeNull();
  });

  it('lists the downloads and the zip on a default link; the section is absent with downloads off', async () => {
    const on = await createToken(deckId, { name: 'dl on' });
    const base = `${BASE}/v/${on.secret}/`;
    const md = await (await get(`/v/${on.secret}/`)).text();
    expect(md).toContain('## Downloads (2)');
    expect(md).toContain('| File | Size | Type | URL |');
    expect(md).toContain(`| figures.csv | ${CSV.length} bytes | text/csv | ${base}downloads/figures.csv |`);
    expect(md).toContain(`All files as one zip: ${base}downloads.zip`);

    const off = await createToken(deckId, { name: 'dl off', canDownload: false });
    const offMd = await (await get(`/v/${off.secret}/`)).text();
    expect(offMd).toContain('- Downloads: no');
    expect(offMd).not.toContain('## Downloads');
    expect(offMd).not.toContain('figures.csv');
    expect(offMd).not.toContain('downloads.zip');
    expect(offMd.toLowerCase()).not.toContain('hidden');
    const offJson = await readJson(await get(`/v/${off.secret}/?format=json`));
    expect(offJson.downloads).toBeNull();
    expect(offJson.zipUrl).toBeNull();

    // A deck with no attachments has no section either, even with downloads on.
    const plain = await createToken(plainDeckId, { name: 'plain dl' });
    expect(await (await get(`/v/${plain.secret}/`)).text()).not.toContain('## Downloads');
  });

  it('a pinned link says so, and its capabilities follow the link', async () => {
    const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
    const { secret } = await createToken(deckId, {
      name: 'pinned',
      versionMode: 'pinned',
      pinnedVersion: 1,
      canAnnotate: true,
      canSubmitForms: false,
      canExportPdf: false,
      expiresAt
    });
    const md = await (await get(`/v/${secret}/`)).text();
    expect(md).toContain('Version 1, pinned to version 1.');
    expect(md).toContain('- Annotations (notes on the deck): yes');
    expect(md).toContain('- Form submissions: no');
    expect(md).toContain('- PDF export: no');
    expect(md).toContain(`- Expires: ${expiresAt}`);
    const body = await readJson(await get(`/v/${secret}/?format=json`));
    expect(body.version).toEqual({ number: 1, mode: 'pinned' });
    expect(body.link.expiresAt).toBe(expiresAt);
  });
});

// ═══ The gates ═══════════════════════════════════════════════════════════════

describe('the index sits behind the same gates', () => {
  it('a password link answers 401 with the header hint, then the index with x-viewer-password', async () => {
    const { secret } = await createToken(deckId, { name: 'locked', password: 'open-sesame' });
    const challenge = await get(`/v/${secret}/`);
    expect(challenge.status).toBe(401);
    expect(await readJson(challenge)).toEqual({
      error: {
        code: 'password_required',
        message: 'This share link is password-protected. Send the password in the x-viewer-password header.'
      }
    });
    const unlocked = await get(`/v/${secret}/`, { 'x-viewer-password': 'open-sesame' });
    expect(unlocked.status).toBe(200);
    expectIndexHeaders(unlocked, 'text/markdown');
    expect(await unlocked.text()).toContain('# Quarterly review');
    const wrong = await get(`/v/${secret}/`, { 'x-viewer-password': 'nope' });
    expect(wrong.status).toBe(401);
    expect((await readJson(wrong)).error.code).toBe('password_invalid');
  });

  it('revoked 403 and expired 410 are unchanged', async () => {
    const revokable = await createToken(deckId, { name: 'revoke me' });
    const revoke = await app.app.request(
      `/api/v1/presentations/${deckId}/tokens/${revokable.shareToken.id}`,
      {
        method: 'DELETE',
        headers: { cookie }
      }
    );
    expect(revoke.status).toBe(200);
    const revoked = await get(`/v/${revokable.secret}/`);
    expect(revoked.status).toBe(403);
    expect((await readJson(revoked)).error.code).toBe('revoked');

    const expired = await createToken(deckId, {
      name: 'expired',
      expiresAt: new Date(Date.now() - 60_000).toISOString()
    });
    const gone = await get(`/v/${expired.secret}/?format=agent`);
    expect(gone.status).toBe(410);
    expect((await readJson(gone)).error.code).toBe('expired');
  });
});

// ═══ Counting ════════════════════════════════════════════════════════════════

describe('an index read is an agent read, never a view', () => {
  it('each GET adds one agent read, accessCount does not move, no cookie; HEAD does not count', async () => {
    const created = await createToken(deckId, { name: 'counted' });
    const before = await tokenOnWire(deckId, created.shareToken.id);
    expect(before['agentReadCount']).toBe(0);
    expect(before['accessCount']).toBe(0);

    const first = await get(`/v/${created.secret}/`);
    expect(first.headers.get('set-cookie')).toBeNull();
    await first.text();
    await (await get(`/v/${created.secret}/?format=json`, { accept: 'application/json' })).text();
    expect((await tokenOnWire(deckId, created.shareToken.id))['agentReadCount']).toBe(2);

    const headRes = await head(`/v/${created.secret}/`);
    expect(headRes.status).toBe(200);
    expectIndexHeaders(headRes, 'text/markdown');
    expect(await headRes.text()).toBe('');

    const after = await tokenOnWire(deckId, created.shareToken.id);
    expect(after['agentReadCount']).toBe(2);
    expect(after['accessCount']).toBe(0);
    expect(after['lastAccessedAt']).toBeNull();

    // And a browser open is a view, not an agent read.
    await (await get(`/v/${created.secret}/`, NAV)).text();
    const viewed = await tokenOnWire(deckId, created.shareToken.id);
    expect(viewed['accessCount']).toBe(1);
    expect(viewed['agentReadCount']).toBe(2);
  });

  it("an owner preview's read is not counted", async () => {
    const res = await app.app.request(`/api/v1/presentations/${deckId}/preview-token`, json({}, { cookie }));
    expect(res.status).toBe(201);
    const preview = await readJson(res);
    const read = await get(`/v/${preview.secret}/`);
    expect(read.status).toBe(200);
    expect(await read.text()).toContain('# Quarterly review');
    const row = await tokenOnWire(deckId, preview.shareToken.id);
    if (row) {
      expect(row['agentReadCount']).toBe(0);
    } else {
      // Preview tokens may be hidden from the owner's list: read the row directly.
      const rows = await app.db.db.execute(
        sql`SELECT agent_read_count FROM share_tokens WHERE id = ${preview.shareToken.id}`
      );
      expect((rows.rows as Array<{ agent_read_count: number }>)[0]?.agent_read_count).toBe(0);
    }
  });
});

// ═══ Discovery ═══════════════════════════════════════════════════════════════

describe('no viewer refusal is indexable', () => {
  it('the JSON refusals carry x-robots-tag: unknown, locked, wrong password (verifier round 2, F2)', async () => {
    const unknown = await get('/v/not-a-real-secret-at-all-0000000000000000000000000000000000000000/');
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get('content-type')).toContain('application/json');
    expect(unknown.headers.get('x-robots-tag')).toBe('noindex, nofollow');

    const locked = await createToken(deckId, { name: 'robots-locked', password: 'open-sesame' });
    const challenge = await get(`/v/${locked.secret}/`);
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get('content-type')).toContain('application/json');
    expect(challenge.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    const wrong = await get(`/v/${locked.secret}/`, { 'x-viewer-password': 'not-it' });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  });
});

describe('the PDF switch on the row itself', () => {
  it('the column defaults to FALSE and the counter to 0: a row written without them reads off (verifier round 1, mutation 4)', async () => {
    // The API always sends the schema default (true), so only a raw insert
    // exercises the migration's DEFAULT: the value every link minted before
    // the switch existed received. A link in circulation must never gain
    // the Export PDF action without its owner's word.
    const inserted = await app.db.db.execute(sql`
      INSERT INTO share_tokens (workspace_id, presentation_id, name, token_hash)
      SELECT workspace_id, id, 'raw insert', 'raw-insert-hash-' || gen_random_uuid()::text
      FROM presentations WHERE id = ${deckId}
      RETURNING can_export_pdf, agent_read_count`);
    const row = (inserted.rows as Array<{ can_export_pdf: boolean; agent_read_count: number }>)[0];
    expect(row?.can_export_pdf).toBe(false);
    expect(row?.agent_read_count).toBe(0);
    // And such a row reads off on the wire and tells the bar so.
    const listed = await readJson(await get(`/api/v1/presentations/${deckId}/tokens`, { cookie }));
    const raw = listed.shareTokens.find((t: { name: string }) => t.name === 'raw insert');
    expect(raw?.canExportPdf).toBe(false);
    expect(raw?.agentReadCount).toBe(0);
  });
});

describe('the deck HTML points agents at the index', () => {
  it('a default link carries the discovery link in <head>; a showBar:false link stays byte-exact', async () => {
    const def = await createToken(deckId, { name: 'discover' });
    const html = await (await get(`/v/${def.secret}/`, NAV)).text();
    expect(html).toContain(
      `<head><link rel="alternate" type="text/markdown" href="/v/${def.secret}/?format=agent" ${AGENT_INDEX_MARKER}>` +
        `<!-- Agents: this deck's index is at /v/${def.secret}/?format=agent (markdown) or /v/${def.secret}/?format=json -->`
    );

    const bare = await createToken(deckId, { name: 'bare', showBar: false });
    const res = await get(`/v/${bare.secret}/`, NAV);
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.equals(HTML)).toBe(true);
    expect(bytes.toString()).not.toContain(AGENT_INDEX_MARKER);
    expect(res.headers.get('etag')).toBe(`"${shaOf(HTML)}"`);
  });
});

// ═══ The PDF switch on the token API ═════════════════════════════════════════

describe('canExportPdf and agentReadCount on the token API', () => {
  it('defaults on, honours false, flips on PATCH; the preview mint carries true; agentReadCount starts at 0', async () => {
    const on = await createToken(deckId, { name: 'pdf default' });
    expect(on.shareToken.canExportPdf).toBe(true);
    expect(on.shareToken.agentReadCount).toBe(0);

    const off = await createToken(deckId, { name: 'pdf off', canExportPdf: false });
    expect(off.shareToken.canExportPdf).toBe(false);

    const patched = await app.app.request(`/api/v1/presentations/${deckId}/tokens/${off.shareToken.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ canExportPdf: true })
    });
    expect(patched.status).toBe(200);
    expect((await readJson(patched)).canExportPdf).toBe(true);
    expect((await tokenOnWire(deckId, off.shareToken.id))['canExportPdf']).toBe(true);

    const preview = await app.app.request(
      `/api/v1/presentations/${deckId}/preview-token`,
      json({}, { cookie })
    );
    expect(preview.status).toBe(201);
    const minted = await readJson(preview);
    expect(minted.shareToken.canExportPdf).toBe(true);
    expect(minted.shareToken.agentReadCount).toBe(0);
  });
});
