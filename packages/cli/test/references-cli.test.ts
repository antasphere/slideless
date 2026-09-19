import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/index.js';
import { readLink, writeLink } from '../src/manifest.js';
import { readFrontmatter, readReferenceLink, referenceDirFor } from '../src/references.js';
import { DECK, routedHarness, VERSION_ROW, type Route } from './harness.js';

/**
 * PRDCT-2420 end to end through the in-process runner: `reference`, `brand`
 * and `template` (list, pull, new, push, publish, unpublish, default,
 * start), plus `push --brand/--template` and the automatic provenance of a
 * pulled reference sitting in `.slideless/<type>/`. The fake instance
 * answers the wire shapes of `packages/contract`; every assertion is on the
 * requests the CLI made (`h.calls`) or on what it wrote to disk.
 */

const URL_ = 'http://x';
const KEY = 'slk_k_s';
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

const SESSION_ID = '33333333-3333-3333-3333-333333333333';
const HOUSE = 'aaaaaaaa-1111-4111-8111-111111111111';
const HARBOUR = 'bbbbbbbb-1111-4111-8111-111111111111';
const MONTHLY = 'cccccccc-1111-4111-8111-111111111111';
const DECK_ID = DECK.id;

/** A Presentation as the wire carries it now: the three reference fields and metadata. */
function refDeck(id: string, title: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...DECK,
    id,
    title,
    currentVersion: 3,
    reference: { type: 'brand' },
    audience: 'workspace',
    defaultReference: false,
    metadata: {},
    ...over
  };
}

const HOUSE_ROW = refDeck(HOUSE, 'House brand', { defaultReference: true });
const HARBOUR_ROW = refDeck(HARBOUR, 'Harbour brand');
const MONTHLY_ROW = refDeck(MONTHLY, 'Monthly update', { reference: { type: 'template' } });

const argv = (...rest: string[]) => [...rest, '--url', URL_, '--api-key', KEY];

/** The `?type=…`/`?default=…` query of a recorded presentations list call. */
const listQueries = (calls: Array<{ method: string; path: string }>): string[] =>
  calls
    .filter((c) => c.method === 'GET' && c.path.startsWith('/api/v1/presentations?'))
    .map((c) => c.path.slice('/api/v1/presentations'.length));

/** The list route: answers from `rows`, honouring `type` and `default=true`. */
function listRoute(rows: Array<Record<string, unknown>>, nextCursor: string | null = null): Route {
  return {
    method: 'GET',
    path: /\/api\/v1\/presentations$/,
    reply: ({ path }) => {
      const query = new URLSearchParams(path.split('?')[1] ?? '');
      const type = query.get('type');
      let out = rows;
      if (type && type !== 'reference') {
        out = out.filter((r) => (r.reference as { type: string } | null)?.type === type);
      }
      if (query.get('default') === 'true') out = out.filter((r) => r.defaultReference === true);
      const cursor = query.get('cursor');
      return { body: { presentations: cursor ? [] : out, nextCursor: cursor ? null : nextCursor } };
    }
  };
}

/** The PATCH route: echoes the patch onto the row, recording nothing else. */
function patchRoute(rows: Array<Record<string, unknown>>, refusal?: { status: number; code: string }): Route {
  return {
    method: 'PATCH',
    path: /\/api\/v1\/presentations\/[^/]+$/,
    reply: ({ path, body }) => {
      if (refusal) {
        return { status: refusal.status, body: { error: { code: refusal.code, message: refusal.code } } };
      }
      const id = path.split('?')[0]!.split('/').pop()!;
      const row = rows.find((r) => r.id === id) ?? refDeck(id, 'Unknown');
      return { body: { ...row, ...(body as Record<string, unknown>) } };
    }
  };
}

// ── The download side (reference pull / start) ───────────────────────────────

interface Bundle {
  manifest: Array<{ path: string; sha256: string; sizeBytes: number; contentType: string }>;
  blobs: Record<string, Buffer>;
}

function bundle(files: Record<string, string>): Bundle {
  const manifest: Bundle['manifest'] = [];
  const blobs: Record<string, Buffer> = {};
  for (const [path, content] of Object.entries(files)) {
    const bytes = Buffer.from(content);
    const hash = sha(bytes);
    manifest.push({
      path,
      sha256: hash,
      sizeBytes: bytes.length,
      contentType: path.endsWith('.html') ? 'text/html' : 'text/markdown'
    });
    blobs[hash] = bytes;
  }
  return { manifest, blobs };
}

function downloadRoutes(deckId: string, versions: Record<number, Bundle>): Route[] {
  const all: Record<string, Buffer> = {};
  for (const b of Object.values(versions)) Object.assign(all, b.blobs);
  return [
    {
      method: 'GET',
      path: new RegExp(`/api/v1/presentations/${deckId}/versions/\\d+$`),
      reply: ({ path }) => {
        const n = Number(path.split('?')[0]!.split('/').pop());
        const b = versions[n];
        if (!b) return { status: 404, body: { error: { code: 'not_found', message: 'no version' } } };
        return {
          body: { ...VERSION_ROW, presentationId: deckId, version: n, manifest: b.manifest }
        };
      }
    },
    {
      method: 'GET',
      path: new RegExp(`/api/v1/presentations/${deckId}/assets/`),
      reply: ({ path }) => {
        const hash = path.split('?')[0]!.split('/').pop()!;
        return { raw: new Response(all[hash], { status: 200 }) };
      }
    }
  ];
}

const BRAND_AGENT = '---\ntype: Brand\ntitle: House brand\ndescription: the look\n---\n\n# House brand\n';
const BRAND_BUNDLE = bundle({ 'AGENT.md': BRAND_AGENT, 'index.html': '<html>brand v3</html>' });
const BRAND_V1 = bundle({ 'index.html': '<html>brand v1</html>' });

// ── The push side ────────────────────────────────────────────────────────────

function pushRoutes(
  commit: (body: unknown) => Record<string, unknown>,
  opts: { missing?: string[]; existing?: { id: string; currentVersion: number } } = {}
): Route[] {
  const routes: Route[] = [
    {
      method: 'POST',
      path: /\/api\/v1\/presentations\/precheck$/,
      reply: () => ({ body: { missing: opts.missing ?? [] } })
    },
    {
      method: 'POST',
      path: /\/api\/v1\/presentations\/assets$/,
      reply: ({ body }) => ({
        status: 201,
        body: { sha256: (body as { sha256: string }).sha256, sizeBytes: 1, deduplicated: false }
      })
    },
    {
      method: 'POST',
      path: /\/api\/v1\/presentations\/uploads$/,
      reply: () => ({
        status: 201,
        body: {
          uploadSession: {
            id: SESSION_ID,
            presentationId: DECK_ID,
            expiresAt: '2026-01-01T01:00:00.000Z',
            createdAt: '2026-01-01T00:00:00.000Z'
          }
        }
      })
    },
    {
      method: 'POST',
      path: new RegExp(`/api/v1/presentations/uploads/${SESSION_ID}/commit$`),
      reply: ({ body }) => ({ status: 201, body: commit(body) })
    }
  ];
  if (opts.existing) {
    const { id, currentVersion } = opts.existing;
    routes.push(
      {
        method: 'GET',
        path: new RegExp(`/api/v1/presentations/${id}$`),
        reply: () => ({ body: refDeck(id, 'Existing', { currentVersion }) })
      },
      {
        method: 'POST',
        path: new RegExp(`/api/v1/presentations/${id}/versions$`),
        reply: ({ body }) => ({ status: 201, body: commit(body) })
      }
    );
  }
  return routes;
}

/** A commit answer: the deck plus the version row, with the reference fields spelled out. */
function committed(
  presentation: Record<string, unknown>,
  version: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    presentation,
    version: {
      ...VERSION_ROW,
      presentationId: presentation.id,
      reference: null,
      referenceWarning: null,
      ...version
    }
  };
}

async function tempDeck(
  files: Record<string, string> = { 'index.html': '<html>deck</html>' }
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'slideless-refcli-'));
  for (const [path, content] of Object.entries(files)) {
    const abs = join(dir, path);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, content);
  }
  return dir;
}

const emptyDir = () => mkdtemp(join(tmpdir(), 'slideless-refcli-empty-'));

// `reference pull` with no --into writes into the CWD; restore it after.
const cwd = process.cwd();
afterEach(() => process.chdir(cwd));

// ── list ─────────────────────────────────────────────────────────────────────

describe('reference list', () => {
  const rows = [HOUSE_ROW, HARBOUR_ROW, MONTHLY_ROW];

  it('`reference list` asks for type=reference and marks the default with *', async () => {
    const h = routedHarness([listRoute(rows)]);
    expect(await run(argv('reference', 'list'), h.io)).toBe(0);
    expect(h.err()).toBe('');
    expect(listQueries(h.calls)).toEqual(['?type=reference']);
    const out = h.out();
    expect(out).toContain('House brand');
    expect(out).toContain('Monthly update');
    // The default row, and only it, opens with the star.
    const star = out.split('\n').find((l) => l.includes('House brand'))!;
    expect(star.startsWith('*')).toBe(true);
    expect(
      out
        .split('\n')
        .find((l) => l.includes('Harbour brand'))!
        .startsWith('*')
    ).toBe(false);
    expect(out).toContain("* = the workspace's default of its type");
  });

  it('`brand list` asks for type=brand, `template list` for type=template', async () => {
    const hb = routedHarness([listRoute(rows)]);
    expect(await run(argv('brand', 'list'), hb.io)).toBe(0);
    expect(listQueries(hb.calls)).toEqual(['?type=brand']);
    expect(hb.out()).not.toContain('Monthly update');

    const ht = routedHarness([listRoute(rows)]);
    expect(await run(argv('template', 'list'), ht.io)).toBe(0);
    expect(listQueries(ht.calls)).toEqual(['?type=template']);
    expect(ht.out()).toContain('Monthly update');
    expect(ht.out()).not.toContain('House brand');
  });

  it('--json prints { references, nextCursor }', async () => {
    const h = routedHarness([listRoute(rows, 'next-page')]);
    expect(await run(argv('brand', 'list', '--json'), h.io)).toBe(0);
    const parsed = JSON.parse(h.out()) as { references: Array<{ id: string }>; nextCursor: string | null };
    expect(parsed.nextCursor).toBe('next-page');
    expect(parsed.references.map((r) => r.id)).toEqual([HOUSE, HARBOUR]);
  });

  it('--all follows the cursor and reports no nextCursor', async () => {
    const h = routedHarness([listRoute(rows, 'next-page')]);
    expect(await run(argv('brand', 'list', '--all', '--json'), h.io)).toBe(0);
    const queries = listQueries(h.calls);
    expect(queries).toHaveLength(2);
    expect(queries[1]).toContain('cursor=next-page');
    expect((JSON.parse(h.out()) as { nextCursor: null }).nextCursor).toBeNull();
  });

  it('`brand list --type brand` is refused: the family already names the type', async () => {
    const h = routedHarness([listRoute(rows)]);
    expect(await run(argv('brand', 'list', '--type', 'brand'), h.io)).toBe(1);
    // A shortcut family never registers --type at all (`withType` in
    // commands/references.ts hands the command back untouched), so commander
    // is the one that refuses; `typeOf`'s "already names the type" sentence is
    // unreachable from the command line. Either way: exit 1, nothing on the wire.
    expect(h.err()).toContain("unknown option '--type'");
    expect(h.calls).toHaveLength(0);
  });

  it('an unknown --type on the open family names the known ones', async () => {
    const h = routedHarness([listRoute(rows)]);
    expect(await run(argv('reference', 'list', '--type', 'colour'), h.io)).toBe(1);
    expect(h.err()).toContain('brand, template');
    expect(h.calls).toHaveLength(0);
  });

  it('an empty workspace says so', async () => {
    const h = routedHarness([listRoute([])]);
    expect(await run(argv('brand', 'list'), h.io)).toBe(0);
    expect(h.out()).toBe('No brands.\n');
  });
});

// ── pull ─────────────────────────────────────────────────────────────────────

describe('reference pull', () => {
  const routes = () => [
    listRoute([HOUSE_ROW, HARBOUR_ROW, MONTHLY_ROW]),
    ...downloadRoutes(HOUSE, { 3: BRAND_BUNDLE, 1: BRAND_V1 })
  ];

  it('no ref: asks for the default of the type and writes into .slideless/brand/', async () => {
    const deck = await tempDeck();
    process.chdir(deck);
    const h = routedHarness(routes());
    expect(await run(argv('brand', 'pull'), h.io)).toBe(0);
    expect(h.err()).toBe('');

    expect(listQueries(h.calls).some((q) => q.includes('type=brand') && q.includes('default=true'))).toBe(
      true
    );
    const dest = referenceDirFor(deck, 'brand');
    expect(await readFile(join(dest, 'AGENT.md'), 'utf8')).toBe(BRAND_AGENT);
    expect(await readFile(join(dest, 'index.html'), 'utf8')).toBe('<html>brand v3</html>');
    expect(await readReferenceLink(dest)).toEqual({
      presentationId: HOUSE,
      baseUrl: URL_,
      reference: { type: 'brand', version: 3 }
    });
    expect(h.out()).toContain('Pulled brand "House brand" v3');
  });

  it('no default: exit 1 naming `slideless brand default`, nothing written', async () => {
    const dest = join(await emptyDir(), 'out');
    const h = routedHarness([listRoute([HARBOUR_ROW])]);
    expect(await run(argv('brand', 'pull', '--into', dest), h.io)).toBe(1);
    expect(h.err()).toContain('no default brand');
    expect(h.err()).toContain('slideless brand default');
    await expect(stat(dest)).rejects.toThrow();
  });

  it('a title prefix resolves against the type=brand list; --at pins the version', async () => {
    const dest = join(await emptyDir(), 'out');
    // A unique prefix resolves: "harb" reaches Harbour, whose id the version
    // request then carries (no download routes for it here — the resolution
    // is what this line pins).
    const h = routedHarness(routes());
    expect(await run(argv('brand', 'pull', 'harb', '--into', dest), h.io)).toBe(1);
    expect(h.calls.some((c) => c.path.includes(`/presentations/${HARBOUR}/versions/3`))).toBe(true);

    const h2 = routedHarness(routes());
    expect(await run(argv('brand', 'pull', 'house', '--at', '1', '--into', dest), h2.io)).toBe(0);
    expect(h2.err()).toBe('');
    expect(listQueries(h2.calls).every((q) => q.includes('type=brand'))).toBe(true);
    expect(h2.calls.some((c) => c.path.endsWith('/versions/1'))).toBe(true);
    expect(await readFile(join(dest, 'index.html'), 'utf8')).toBe('<html>brand v1</html>');
    expect((await readReferenceLink(dest))!.reference.version).toBe(1);
  });

  it('--at beyond the reference’s currentVersion is refused before any download', async () => {
    const dest = join(await emptyDir(), 'out');
    const h = routedHarness(routes());
    expect(await run(argv('brand', 'pull', 'house', '--at', '9', '--into', dest), h.io)).toBe(1);
    expect(h.err()).toContain('is at version 3');
    expect(h.calls.some((c) => c.path.includes('/versions/'))).toBe(false);
  });

  it('a second pull into the same --into REPLACES the folder', async () => {
    const dest = join(await emptyDir(), 'out');
    const first = routedHarness(routes());
    expect(await run(argv('brand', 'pull', 'house', '--into', dest), first.io)).toBe(0);
    // A file the first pull left behind that v1 does not carry.
    expect(await readFile(join(dest, 'AGENT.md'), 'utf8')).toBe(BRAND_AGENT);

    const second = routedHarness(routes());
    expect(await run(argv('brand', 'pull', 'house', '--at', '1', '--into', dest), second.io)).toBe(0);
    expect(second.err()).toBe('');
    // v1 carries only index.html: the stale AGENT.md of v3 is gone.
    expect(await readdir(dest)).toEqual(expect.arrayContaining(['index.html', '.slideless.json']));
    await expect(readFile(join(dest, 'AGENT.md'), 'utf8')).rejects.toThrow();
  });

  it('a non-empty --into that is not a pulled reference is refused, nothing written', async () => {
    const dest = await tempDeck({ 'mine.txt': 'my own notes' });
    const h = routedHarness(routes());
    expect(await run(argv('brand', 'pull', 'house', '--into', dest), h.io)).toBe(1);
    expect(h.err()).toContain('not a folder a previous pull wrote');
    expect(await readFile(join(dest, 'mine.txt'), 'utf8')).toBe('my own notes');
    expect(h.calls.some((c) => c.path.includes('/versions/'))).toBe(false);
  });

  it('a deck folder linked by .slideless.json is refused as a pull target', async () => {
    const dest = await tempDeck({ 'index.html': '<html>deck</html>' });
    await writeLink(dest, { presentationId: DECK_ID, baseUrl: URL_ });
    const h = routedHarness(routes());
    expect(await run(argv('brand', 'pull', 'house', '--into', dest), h.io)).toBe(1);
    expect(h.err()).toContain('is a deck folder linked by');
    expect(await readFile(join(dest, 'index.html'), 'utf8')).toBe('<html>deck</html>');
  });

  it('a folder whose link names ANOTHER instance is refused', async () => {
    const dest = await tempDeck({ 'index.html': '<html>old</html>' });
    await writeLink(dest, {
      presentationId: HOUSE,
      baseUrl: 'http://other',
      reference: { type: 'brand', version: 1 }
    });
    const h = routedHarness(routes());
    expect(await run(argv('brand', 'pull', 'house', '--into', dest), h.io)).toBe(1);
    expect(h.err()).toContain('http://other');
    expect(await readFile(join(dest, 'index.html'), 'utf8')).toBe('<html>old</html>');
  });

  it('`reference pull` with no ref and no --type is refused', async () => {
    const h = routedHarness(routes());
    expect(await run(argv('reference', 'pull'), h.io)).toBe(1);
    expect(h.err()).toContain('--type');
    expect(h.calls).toHaveLength(0);
  });
});

// ── new ──────────────────────────────────────────────────────────────────────

describe('reference new', () => {
  it('scaffolds a template with the title, with no network at all', async () => {
    const dest = join(await emptyDir(), 'quarterly');
    const h = routedHarness([]);
    expect(
      await run(['reference', 'new', dest, '--type', 'template', '--title', 'Quarterly review'], h.io)
    ).toBe(0);
    expect(h.err()).toBe('');
    expect(h.calls).toHaveLength(0);

    const agent = await readFile(join(dest, 'AGENT.md'), 'utf8');
    expect(readFrontmatter(agent)).toMatchObject({ type: 'template', title: 'Quarterly review' });
    expect(await readFile(join(dest, 'index.html'), 'utf8')).toContain('Quarterly review');
    expect((await stat(join(dest, 'assets'))).isDirectory()).toBe(true);
    expect(h.out()).toContain('Scaffolded a template');
  });

  it('`brand new` needs no --type', async () => {
    const dest = join(await emptyDir(), 'house');
    const h = routedHarness([]);
    expect(await run(['brand', 'new', dest], h.io)).toBe(0);
    expect(readFrontmatter(await readFile(join(dest, 'AGENT.md'), 'utf8')).type).toBe('brand');
    expect((await stat(join(dest, 'assets', 'fonts'))).isDirectory()).toBe(true);
  });

  it('`reference new` without --type is refused', async () => {
    const dest = join(await emptyDir(), 'nope');
    const h = routedHarness([]);
    expect(await run(['reference', 'new', dest], h.io)).toBe(1);
    expect(h.err()).toContain('Pass --type brand|template');
    await expect(stat(dest)).rejects.toThrow();
  });

  it('a non-empty dir is refused and left untouched', async () => {
    const dest = await tempDeck({ 'mine.txt': 'keep me' });
    const h = routedHarness([]);
    expect(await run(['brand', 'new', dest], h.io)).toBe(1);
    expect(h.err()).toContain('exists and is not empty');
    expect(await readdir(dest)).toEqual(['mine.txt']);
  });

  it('--json prints the path, the type, the files and the dirs', async () => {
    const dest = join(await emptyDir(), 'house');
    const h = routedHarness([]);
    expect(await run(['brand', 'new', dest, '--json'], h.io)).toBe(0);
    expect(JSON.parse(h.out())).toMatchObject({
      type: 'brand',
      files: ['AGENT.md', 'index.html'],
      dirs: ['assets', 'assets/fonts']
    });
  });
});

// ── reference push ───────────────────────────────────────────────────────────

describe('reference push', () => {
  const refused = async (files: Record<string, string>, command: string[], fragment: string) => {
    const dir = await tempDeck(files);
    const h = routedHarness(pushRoutes(() => committed(refDeck(DECK_ID, 'X'))));
    expect(await run(argv(...command, dir), h.io)).toBe(1);
    expect(h.err()).toContain(fragment);
    // The whole point: refused BEFORE the first byte leaves.
    expect(h.calls).toHaveLength(0);
  };

  it('refuses a folder with no AGENT.md, before any request', async () => {
    await refused({ 'index.html': '<html>x</html>' }, ['reference', 'push'], 'has no AGENT.md');
  });

  it('refuses an AGENT.md with no frontmatter, before any request', async () => {
    await refused(
      { 'index.html': '<html>x</html>', 'AGENT.md': '# House\n\nno block here\n' },
      ['reference', 'push'],
      'has no frontmatter'
    );
  });

  it('refuses a frontmatter with no type: line, before any request', async () => {
    await refused(
      { 'index.html': '<html>x</html>', 'AGENT.md': '---\ntitle: House\n---\n' },
      ['reference', 'push'],
      'no `type:` line'
    );
  });

  it('refuses an unknown type, naming it and the known ones', async () => {
    await refused(
      { 'index.html': '<html>x</html>', 'AGENT.md': '---\ntype: Colour\n---\n' },
      ['reference', 'push'],
      'names the type "Colour"'
    );
  });

  it('`brand push` refuses a folder declaring a template', async () => {
    await refused(
      { 'index.html': '<html>x</html>', 'AGENT.md': '---\ntype: Template\ntitle: Monthly\n---\n' },
      ['brand', 'push'],
      'declares a template, and this command pushes a brand'
    );
  });

  it('refuses a file rather than a folder', async () => {
    const dir = await tempDeck({ 'index.html': '<html>x</html>' });
    const h = routedHarness([]);
    expect(await run(argv('brand', 'push', join(dir, 'index.html')), h.io)).toBe(1);
    expect(h.err()).toContain('is a file');
    expect(h.calls).toHaveLength(0);
  });

  it('a good folder pushes and prints the classification the commit answered', async () => {
    const dir = await tempDeck({
      'index.html': '<html>brand</html>',
      'AGENT.md': '---\ntype: Brand\ntitle: House brand\n---\n\n# House brand\n'
    });
    const h = routedHarness(
      pushRoutes(() =>
        committed(refDeck(HOUSE, 'House brand', { currentVersion: 1, audience: 'workspace' }), {
          reference: { type: 'brand', title: 'House brand' }
        })
      )
    );
    expect(await run(argv('brand', 'push', dir), h.io)).toBe(0);
    expect(h.err()).toBe('');
    const paths = h.calls.map((c) => `${c.method} ${c.path.split('?')[0]}`);
    expect(paths).toContain('POST /api/v1/presentations/uploads');
    expect(paths).toContain(`POST /api/v1/presentations/uploads/${SESSION_ID}/commit`);
    expect(h.out()).toContain('reference: brand "House brand"');
    expect(h.out()).toContain('published to the workspace');
    expect(h.out()).not.toContain('classified this push as an ordinary deck');
  });

  it('a NEW reference is named after the frontmatter title, and --title wins', async () => {
    const files = {
      'index.html': '<html>brand</html>',
      'AGENT.md': '---\ntype: Brand\ntitle: "Acme: the 2026 look"\n---\n'
    };
    const commit = () =>
      committed(refDeck(HOUSE, 'Acme: the 2026 look', { currentVersion: 1 }), {
        reference: { type: 'brand', title: 'Acme: the 2026 look' }
      });

    const h = routedHarness(pushRoutes(commit));
    expect(await run(argv('brand', 'push', await tempDeck(files)), h.io)).toBe(0);
    const body = h.calls.find((c) => c.path.includes('/commit'))!.body as { title: string };
    expect(body.title).toBe('Acme: the 2026 look');

    const h2 = routedHarness(pushRoutes(commit));
    expect(await run(argv('brand', 'push', await tempDeck(files), '--title', 'Chosen'), h2.io)).toBe(0);
    expect((h2.calls.find((c) => c.path.includes('/commit'))!.body as { title: string }).title).toBe(
      'Chosen'
    );
  });

  it('prints the warning the commit answer carried', async () => {
    const dir = await tempDeck({
      'index.html': '<html>brand</html>',
      'AGENT.md': '---\ntype: Brand\ntitle: House brand\n---\n'
    });
    const h = routedHarness(
      pushRoutes(() =>
        committed(refDeck(HOUSE, 'House brand', { currentVersion: 1 }), {
          reference: { type: 'brand', title: 'House brand' },
          referenceWarning: 'the frontmatter names no colors'
        })
      )
    );
    expect(await run(argv('brand', 'push', dir), h.io)).toBe(0);
    expect(h.out()).toContain('warning: the frontmatter names no colors');
  });

  it('a commit that classified nothing prints the "ordinary deck" warning', async () => {
    const dir = await tempDeck({
      'index.html': '<html>brand</html>',
      'AGENT.md': '---\ntype: Brand\ntitle: House brand\n---\n'
    });
    const h = routedHarness(
      pushRoutes(() => committed(refDeck(HOUSE, 'House brand', { currentVersion: 1 })))
    );
    expect(await run(argv('brand', 'push', dir), h.io)).toBe(0);
    expect(h.out()).toContain('classified this push as an ordinary deck, not a brand');
  });

  it('a pulled reference whose commit answers 404 says it is not yours to push', async () => {
    const dir = await tempDeck({
      'index.html': '<html>brand</html>',
      'AGENT.md': '---\ntype: Brand\ntitle: House brand\n---\n'
    });
    await writeLink(dir, {
      presentationId: HOUSE,
      baseUrl: URL_,
      reference: { type: 'brand', version: 3 }
    });
    const routes = pushRoutes(() => ({}), { existing: { id: HOUSE, currentVersion: 3 } });
    routes.splice(
      routes.findIndex((r) => r.path.source.endsWith('/versions$')),
      1,
      {
        method: 'POST',
        path: new RegExp(`/api/v1/presentations/${HOUSE}/versions$`),
        reply: () => ({ status: 404, body: { error: { code: 'not_found', message: 'Not found' } } })
      }
    );
    const h = routedHarness(routes);
    expect(await run(argv('brand', 'push', dir), h.io)).toBe(1);
    expect(h.err()).toContain('not yours to push');
    expect(h.err()).toContain('slideless brand start');
  });
});

// ── push --brand / --template (the provenance) ───────────────────────────────

describe('push records the references a deck was made from', () => {
  /** A deck whose commit answer already carries a template provenance and a client key. */
  const commitWithMetadata = () =>
    committed(
      refDeck(DECK_ID, 'Q1 deck', {
        reference: null,
        audience: 'private',
        currentVersion: 1,
        metadata: { client: 'Acme', references: [{ type: 'template', id: 't', version: 1 }] }
      })
    );

  const provenanceRoutes = (rows = [HOUSE_ROW, HARBOUR_ROW, MONTHLY_ROW]) => [
    listRoute(rows),
    ...pushRoutes(commitWithMetadata),
    patchRoute(rows)
  ];

  it('--brand <ref>@2 PATCHes metadata keeping the other keys and the other type', async () => {
    const dir = await tempDeck();
    const h = routedHarness(provenanceRoutes());
    expect(await run(argv('push', dir, '--brand', 'house@2'), h.io)).toBe(0);
    expect(h.err()).toBe('');

    const patch = h.calls.find((c) => c.method === 'PATCH')!;
    expect(patch.path.split('?')[0]).toBe(`/api/v1/presentations/${DECK_ID}`);
    const metadata = (patch.body as { metadata: Record<string, unknown> }).metadata;
    expect(metadata.client).toBe('Acme');
    expect(metadata.references).toEqual([
      { type: 'template', id: 't', version: 1 },
      { type: 'brand', id: HOUSE, version: 2 }
    ]);
    expect(h.out()).toContain(`references: brand ${HOUSE}@2`);
  });

  it('--brand with no @n records the reference’s current version', async () => {
    const dir = await tempDeck();
    const h = routedHarness(provenanceRoutes());
    expect(await run(argv('push', dir, '--brand', 'House brand'), h.io)).toBe(0);
    const metadata = (
      h.calls.find((c) => c.method === 'PATCH')!.body as {
        metadata: { references: unknown[] };
      }
    ).metadata;
    expect(metadata.references).toContainEqual({ type: 'brand', id: HOUSE, version: 3 });
  });

  it('--brand and --template together record one entry each', async () => {
    const dir = await tempDeck();
    const h = routedHarness(provenanceRoutes());
    expect(await run(argv('push', dir, '--brand', 'harbour', '--template', 'monthly'), h.io)).toBe(0);
    const metadata = (
      h.calls.find((c) => c.method === 'PATCH')!.body as {
        metadata: { references: unknown[] };
      }
    ).metadata;
    expect(metadata.references).toEqual([
      { type: 'brand', id: HARBOUR, version: 3 },
      { type: 'template', id: MONTHLY, version: 3 }
    ]);
  });

  it('a version beyond the reference’s currentVersion is refused before any upload', async () => {
    const dir = await tempDeck();
    const h = routedHarness(provenanceRoutes());
    expect(await run(argv('push', dir, '--brand', 'house@9'), h.io)).toBe(1);
    expect(h.err()).toContain('there is no version 9');
    expect(h.calls.some((c) => c.method === 'POST')).toBe(false);
    expect(await readLink(dir)).toBeNull();
  });

  it('an unresolvable --brand is refused before any upload', async () => {
    const dir = await tempDeck();
    const h = routedHarness(provenanceRoutes());
    expect(await run(argv('push', dir, '--brand', 'nowhere'), h.io)).toBe(1);
    expect(h.err()).toContain('No brand named "nowhere"');
    expect(h.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('automatic: a pulled brand in .slideless/brand/ from THIS instance is recorded with no flag', async () => {
    const dir = await tempDeck();
    const brandDir = referenceDirFor(dir, 'brand');
    await mkdir(brandDir, { recursive: true });
    await writeLink(brandDir, {
      presentationId: HOUSE,
      baseUrl: URL_,
      reference: { type: 'brand', version: 3 }
    });
    const h = routedHarness(provenanceRoutes());
    expect(await run(argv('push', dir), h.io)).toBe(0);
    expect(h.err()).toBe('');
    // No list call was needed: the link file says which reference and which version.
    expect(listQueries(h.calls)).toEqual([]);
    const metadata = (
      h.calls.find((c) => c.method === 'PATCH')!.body as {
        metadata: { references: unknown[] };
      }
    ).metadata;
    expect(metadata.references).toContainEqual({ type: 'brand', id: HOUSE, version: 3 });
  });

  it('automatic: a brand pulled from ANOTHER instance is not recorded, and a Note goes to stderr', async () => {
    const dir = await tempDeck();
    const brandDir = referenceDirFor(dir, 'brand');
    await mkdir(brandDir, { recursive: true });
    await writeLink(brandDir, {
      presentationId: HOUSE,
      baseUrl: 'http://other',
      reference: { type: 'brand', version: 3 }
    });
    const h = routedHarness(provenanceRoutes());
    expect(await run(argv('push', dir), h.io)).toBe(0);
    expect(h.err()).toContain('Note:');
    expect(h.err()).toContain('http://other');
    expect(h.calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('no reference anywhere: no PATCH at all', async () => {
    const dir = await tempDeck();
    const h = routedHarness(provenanceRoutes());
    expect(await run(argv('push', dir), h.io)).toBe(0);
    expect(h.calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('--json carries `references` when this push recorded some', async () => {
    const dir = await tempDeck();
    const h = routedHarness(provenanceRoutes());
    expect(await run(argv('push', dir, '--brand', 'house@2', '--json'), h.io)).toBe(0);
    const parsed = JSON.parse(h.out()) as { references?: unknown[] };
    expect(parsed.references).toEqual([{ type: 'brand', id: HOUSE, version: 2 }]);

    const h2 = routedHarness(provenanceRoutes());
    expect(await run(argv('push', await tempDeck(), '--json'), h2.io)).toBe(0);
    expect((JSON.parse(h2.out()) as { references?: unknown[] }).references).toBeUndefined();
  });
});

// ── publish / unpublish / default ────────────────────────────────────────────

describe('the audience and default switches', () => {
  const rows = [HOUSE_ROW, HARBOUR_ROW, MONTHLY_ROW];

  it('`brand publish` PATCHes audience: workspace', async () => {
    const h = routedHarness([listRoute(rows), patchRoute(rows)]);
    expect(await run(argv('brand', 'publish', 'harbour'), h.io)).toBe(0);
    const patch = h.calls.find((c) => c.method === 'PATCH')!;
    expect(patch.path.split('?')[0]).toBe(`/api/v1/presentations/${HARBOUR}`);
    expect(patch.body).toEqual({ audience: 'workspace' });
    expect(h.out()).toContain('is published');
  });

  it('`brand unpublish` PATCHes audience: private', async () => {
    const h = routedHarness([listRoute(rows), patchRoute(rows)]);
    expect(await run(argv('brand', 'unpublish', 'harbour'), h.io)).toBe(0);
    expect(h.calls.find((c) => c.method === 'PATCH')!.body).toEqual({ audience: 'private' });
    expect(h.out()).toContain('is private again');
  });

  it('`brand default <ref>` PATCHes defaultReference: true', async () => {
    const h = routedHarness([listRoute(rows), patchRoute(rows)]);
    expect(await run(argv('brand', 'default', 'harbour'), h.io)).toBe(0);
    expect(h.calls.find((c) => c.method === 'PATCH')!.body).toEqual({ defaultReference: true });
    expect(h.out()).toContain("is the workspace's default brand");
  });

  it('`brand default <ref> --clear` PATCHes defaultReference: false', async () => {
    const h = routedHarness([listRoute(rows), patchRoute(rows)]);
    expect(await run(argv('brand', 'default', 'house', '--clear'), h.io)).toBe(0);
    const patch = h.calls.find((c) => c.method === 'PATCH')!;
    expect(patch.path.split('?')[0]).toBe(`/api/v1/presentations/${HOUSE}`);
    expect(patch.body).toEqual({ defaultReference: false });
    expect(h.out()).toContain('is no longer the default brand');
  });

  it('`brand default --clear` with no ref looks the current default up first', async () => {
    const h = routedHarness([listRoute(rows), patchRoute(rows)]);
    expect(await run(argv('brand', 'default', '--clear'), h.io)).toBe(0);
    expect(listQueries(h.calls).some((q) => q.includes('default=true'))).toBe(true);
    const patch = h.calls.find((c) => c.method === 'PATCH')!;
    expect(patch.path.split('?')[0]).toBe(`/api/v1/presentations/${HOUSE}`);
    expect(patch.body).toEqual({ defaultReference: false });
  });

  it('`brand default --clear` with nothing set says so and PATCHes nothing', async () => {
    const h = routedHarness([listRoute([HARBOUR_ROW]), patchRoute(rows)]);
    expect(await run(argv('brand', 'default', '--clear'), h.io)).toBe(0);
    expect(h.out()).toContain('has no default brand; nothing to clear');
    expect(h.calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('`brand default` with no ref and no --clear is refused', async () => {
    const h = routedHarness([listRoute(rows), patchRoute(rows)]);
    expect(await run(argv('brand', 'default'), h.io)).toBe(1);
    expect(h.err()).toContain('Name the brand to make the default, or pass --clear');
    expect(h.calls).toHaveLength(0);
  });

  it('clearing a reference that is not the default PATCHes nothing', async () => {
    const h = routedHarness([listRoute(rows), patchRoute(rows)]);
    expect(await run(argv('brand', 'default', 'harbour', '--clear'), h.io)).toBe(0);
    expect(h.out()).toContain('is not the default brand; nothing to clear');
    expect(h.calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  for (const [code, status, fragment] of [
    ['not_a_reference', 422, 'is an ordinary deck, not a brand'],
    ['audience_private', 409, 'a default must be readable by the workspace'],
    ['default_reference', 409, 'cannot go private while it is'],
    ['forbidden', 403, 'Only a workspace admin or owner sets the default brand']
  ] as const) {
    it(`the server's ${code} becomes a sentence on stderr, exit 1`, async () => {
      const h = routedHarness([listRoute(rows), patchRoute(rows, { status, code })]);
      expect(await run(argv('brand', 'default', 'harbour'), h.io)).toBe(1);
      expect(h.err()).toContain(fragment);
    });
  }

  it('a `forbidden` on an audience change names the owner rule instead', async () => {
    const h = routedHarness([listRoute(rows), patchRoute(rows, { status: 403, code: 'forbidden' })]);
    expect(await run(argv('brand', 'publish', 'harbour'), h.io)).toBe(1);
    expect(h.err()).toContain('changes who reads it');
  });
});

// ── start ────────────────────────────────────────────────────────────────────

describe('reference start', () => {
  const routes = () => [listRoute([HOUSE_ROW, HARBOUR_ROW]), ...downloadRoutes(HOUSE, { 3: BRAND_BUNDLE })];

  it('copies the files into a fresh dir, strips the type line, writes no link', async () => {
    const dest = join(await emptyDir(), 'q1');
    const h = routedHarness(routes());
    expect(await run(argv('brand', 'start', 'house', dest), h.io)).toBe(0);
    expect(h.err()).toBe('');

    const agent = await readFile(join(dest, 'AGENT.md'), 'utf8');
    expect(readFrontmatter(agent)).toMatchObject({ frontmatter: true, type: null, declared: null });
    // The rest of the briefing survives.
    expect(agent).toContain('title: House brand');
    expect(agent).toContain('description: the look');
    expect(await readFile(join(dest, 'index.html'), 'utf8')).toBe('<html>brand v3</html>');
    await expect(stat(join(dest, '.slideless.json'))).rejects.toThrow();
    expect(await readLink(dest)).toBeNull();

    expect(h.out()).toContain('slideless push --new');
    expect(h.out()).toContain(`--brand ${HOUSE}@3`);
  });

  it('a non-empty dir is refused, nothing downloaded', async () => {
    const dest = await tempDeck({ 'mine.txt': 'keep me' });
    const h = routedHarness(routes());
    expect(await run(argv('brand', 'start', 'house', dest), h.io)).toBe(1);
    expect(h.err()).toContain('exists and is not empty');
    expect(await readdir(dest)).toEqual(['mine.txt']);
    expect(h.calls.some((c) => c.path.includes('/versions/'))).toBe(false);
  });

  it('--json names the reference it started from and writes no link', async () => {
    const dest = join(await emptyDir(), 'q1');
    const h = routedHarness(routes());
    expect(await run(argv('brand', 'start', 'house', dest, '--json'), h.io)).toBe(0);
    expect(JSON.parse(h.out())).toMatchObject({
      from: { type: 'brand', id: HOUSE, version: 3 },
      files: 2
    });
    expect(await readLink(dest)).toBeNull();
  });
});

// ── get ──────────────────────────────────────────────────────────────────────

describe('get shows the reference facts', () => {
  const getRoute = (row: Record<string, unknown>): Route => ({
    method: 'GET',
    path: /\/api\/v1\/presentations\/[^/]+$/,
    reply: () => ({ body: row })
  });

  it('a deck whose metadata carries references prints a `made from:` line', async () => {
    const h = routedHarness([
      getRoute(
        refDeck(DECK_ID, 'Q1 deck', {
          reference: null,
          audience: 'private',
          metadata: {
            references: [
              { type: 'brand', id: HOUSE, version: 2 },
              { type: 'template', id: MONTHLY, version: 1 }
            ]
          }
        })
      )
    ]);
    expect(await run(argv('get', DECK_ID), h.io)).toBe(0);
    expect(h.out()).toContain(`made from: brand ${HOUSE}@2, template ${MONTHLY}@1`);
    expect(h.out()).toContain('reference: no (an ordinary deck)');
  });

  it('a reference deck prints its type, its audience and the default mark', async () => {
    const h = routedHarness([getRoute(HOUSE_ROW)]);
    expect(await run(argv('get', HOUSE), h.io)).toBe(0);
    expect(h.out()).toContain('reference: brand · workspace · the workspace default');
    expect(h.out()).not.toContain('made from:');
  });
});
