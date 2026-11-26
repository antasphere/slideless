import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { updateConfig } from '../src/cli.js';
import { run } from '../src/index.js';
import { readLink, writeLink } from '../src/manifest.js';
import { readReferenceLink, referenceDirFor } from '../src/references.js';
import { DECK, routedHarness, tempConfigEnv, VERSION_ROW, type Route } from './harness.js';

/**
 * R6 (PRDCT-5248) through the in-process runner: a deck's folder decides its
 * site. Two sites, routed by origin, and a machine with two saved profiles,
 * each holding its own site's key: `a` at site A, `b` at site B, `b` the
 * default. The deck folder is linked to A. Every command the folder routes
 * must reach A only, with A's key; every refusal must send nothing at all,
 * discovery included.
 */

const SITE_A = 'http://site-a';
/** Site A as a link file may spell it: the same instance, not the same string. */
const SITE_A_SPELT = 'HTTP://Site-A/';
const SITE_B = 'http://site-b';
const SITE_C = 'http://site-c';
const KEY_A = 'slk_a_own_0123456789abcdef';
const KEY_B = 'slk_b_own_0123456789abcdef';
const KEY_LINE = 'slk_line_0123456789abcdef';

/** A's deck (the one the folder is linked to), a deck of B, and the deck a first push creates. */
const DECK_A = DECK.id;
const DECK_B = '22222222-2222-4222-8222-222222222222';
const NEW_DECK = '44444444-4444-4444-8444-444444444444';
const SESSION_ID = '33333333-3333-3333-3333-333333333333';
const PROJECT = 'aaaaaaaa-2222-4222-8222-222222222222';
const HOUSE = 'aaaaaaaa-1111-4111-8111-111111111111';

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const PULLED = Buffer.from('<html>pulled</html>');
const MANIFEST = [
  { path: 'index.html', sha256: sha(PULLED), sizeBytes: PULLED.length, contentType: 'text/html' }
];

/** A deck row as a site answers it. */
const deckRow = (id: string, over: Record<string, unknown> = {}) => ({
  ...DECK,
  id,
  currentVersion: 3,
  metadata: {},
  ...over
});

const HOUSE_ROW = deckRow(HOUSE, {
  title: 'House brand',
  reference: { type: 'brand' },
  audience: 'workspace',
  defaultReference: true
});

/** The deck id of a `/api/v1/presentations/<id>…` path. */
const deckOf = (path: string): string => path.split('?')[0]!.split('/')[4]!;

/** Everything the folder verbs ask of a site, answered at `origin` only. */
function siteRoutes(origin: string): Route[] {
  const routes: Route[] = [
    {
      method: 'GET',
      path: /^\/api\/v1\/instance$/,
      reply: () => ({ body: { name: 'Site', edition: 'oss' } })
    },
    {
      method: 'GET',
      path: /^\/api\/v1\/presentations$/,
      reply: () => ({ body: { presentations: [HOUSE_ROW], nextCursor: null } })
    },
    {
      method: 'POST',
      path: /^\/api\/v1\/presentations\/precheck$/,
      reply: () => ({ body: { missing: [] } })
    },
    {
      method: 'POST',
      path: /^\/api\/v1\/presentations\/uploads$/,
      reply: () => ({
        status: 201,
        body: {
          uploadSession: {
            id: SESSION_ID,
            presentationId: NEW_DECK,
            expiresAt: '2026-01-01T01:00:00.000Z',
            createdAt: '2026-01-01T00:00:00.000Z'
          }
        }
      })
    },
    {
      method: 'POST',
      path: /^\/api\/v1\/presentations\/uploads\/[^/]+\/commit$/,
      reply: () => ({
        status: 201,
        body: {
          presentation: deckRow(NEW_DECK, { currentVersion: 1 }),
          version: { ...VERSION_ROW, presentationId: NEW_DECK }
        }
      })
    },
    {
      method: 'GET',
      path: /^\/api\/v1\/presentations\/[^/]+$/,
      reply: ({ path }) => ({ body: deckRow(deckOf(path)) })
    },
    {
      // The provenance write after a push that records a reference.
      method: 'PATCH',
      path: /^\/api\/v1\/presentations\/[^/]+$/,
      reply: ({ path, body }) => ({ body: deckRow(deckOf(path), body as Record<string, unknown>) })
    },
    {
      method: 'POST',
      path: /^\/api\/v1\/presentations\/[^/]+\/versions$/,
      reply: ({ path }) => ({
        status: 201,
        body: {
          presentation: deckRow(deckOf(path), { currentVersion: 4 }),
          version: { ...VERSION_ROW, presentationId: deckOf(path), version: 4 }
        }
      })
    },
    {
      method: 'GET',
      path: /^\/api\/v1\/presentations\/[^/]+\/versions\/\d+$/,
      reply: ({ path }) => ({
        body: { ...VERSION_ROW, presentationId: deckOf(path), version: 3, manifest: MANIFEST }
      })
    },
    {
      method: 'GET',
      path: /^\/api\/v1\/presentations\/[^/]+\/assets\//,
      reply: () => ({ raw: new Response(PULLED, { status: 200 }) })
    },
    {
      method: 'GET',
      path: /^\/api\/v1\/presentations\/[^/]+\/agent-doc$/,
      reply: () => ({ raw: new Response('# The brief\n', { status: 200 }) })
    },
    {
      method: 'GET',
      path: /^\/api\/v1\/presentations\/[^/]+\/annotations$/,
      reply: () => ({ body: { annotations: [], nextCursor: null } })
    },
    {
      method: 'PUT',
      path: /^\/api\/v1\/presentations\/[^/]+\/projects\/[^/]+$/,
      reply: ({ path }) => ({
        body: deckRow(deckOf(path), { projects: [{ id: PROJECT, name: 'Atlas', isBrand: false }] })
      })
    },
    {
      method: 'PUT',
      path: /^\/api\/v1\/projects\/[^/]+\/brand$/,
      reply: ({ body }) => ({
        body: {
          brand: deckRow((body as { presentationId: string }).presentationId, {
            reference: { type: 'brand' }
          })
        }
      })
    }
  ];
  return routes.map((route) => ({ ...route, origin }));
}

const harness = (env: Record<string, string | undefined>) =>
  routedHarness([...siteRoutes(SITE_A), ...siteRoutes(SITE_B), ...siteRoutes(SITE_C)], env);

/** Every request went to `origin` carrying `key`, and there was at least one. */
function onlyTo(h: ReturnType<typeof harness>, origin: string, key: string): void {
  expect(h.wire.length).toBeGreaterThan(0);
  expect(h.wire.filter((c) => c.origin !== origin || c.auth !== `Bearer ${key}`)).toEqual([]);
}

/** Whether a request of this method and path (query dropped) was made. */
const asked = (h: ReturnType<typeof harness>, method: string, path: string): boolean =>
  h.wire.some((c) => c.method === method && c.path.split('?')[0] === path);

/** The machine: `a` at site A and `b` at site B, each with its own key, `active` the default. */
async function machine(active: 'a' | 'b' = 'b'): Promise<Record<string, string>> {
  const env = await tempConfigEnv();
  updateConfig(env, (config) => {
    config.profiles.a = { baseUrl: SITE_A, apiKey: KEY_A };
    config.profiles.b = { baseUrl: SITE_B, apiKey: KEY_B };
    config.activeProfile = active;
  });
  return env;
}

/** A deck folder whose link file names deck `id` on `site`. */
async function linkedDeck(
  site: string,
  id: string = DECK_A,
  files: Record<string, string> = { 'index.html': '<html>deck</html>' }
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'slideless-r6-'));
  for (const [path, content] of Object.entries(files)) await writeFile(join(dir, path), content);
  await writeLink(dir, { presentationId: id, baseUrl: site });
  return dir;
}

// The verbs with no folder argument read the current one; restore it after each test.
const cwd = process.cwd();
afterEach(() => process.chdir(cwd));

describe('a linked folder sends its command to its own site (R6)', () => {
  it('push: a new version of the deck on its site, the link unchanged', async () => {
    const env = await machine();
    const dir = await linkedDeck(SITE_A);
    const h = harness(env);
    expect(await run(['push', dir], h.io)).toBe(0);
    expect(h.err()).toBe('');
    onlyTo(h, SITE_A, KEY_A);
    expect(asked(h, 'POST', `/api/v1/presentations/${DECK_A}/versions`)).toBe(true);
    expect(await readLink(dir)).toEqual({ presentationId: DECK_A, baseUrl: SITE_A });
  });

  it('reference push: on the folder’s site', async () => {
    const env = await machine();
    const dir = await linkedDeck(SITE_A, HOUSE, {
      'AGENT.md': '---\ntype: brand\ntitle: House brand\n---\n\n# House brand\n',
      'index.html': '<html>brand</html>'
    });
    const h = harness(env);
    expect(await run(['reference', 'push', dir], h.io)).toBe(0);
    onlyTo(h, SITE_A, KEY_A);
    expect(asked(h, 'POST', `/api/v1/presentations/${HOUSE}/versions`)).toBe(true);
    expect(await readLink(dir)).toEqual({ presentationId: HOUSE, baseUrl: SITE_A });
  });

  it('pull with no id in the linked folder, and pull <id> <path> into a linked path: from the folder’s site', async () => {
    const env = await machine();
    const dir = await linkedDeck(SITE_A);
    process.chdir(dir);
    const h = harness(env);
    expect(await run(['pull'], h.io)).toBe(0);
    expect(h.err()).toBe('');
    onlyTo(h, SITE_A, KEY_A);
    expect(await readFile(join(dir, 'index.html'))).toEqual(PULLED);
    expect(await readLink(dir)).toEqual({ presentationId: DECK_A, baseUrl: SITE_A });

    process.chdir(cwd);
    const dest = await linkedDeck(SITE_A);
    const g = harness(env);
    expect(await run(['pull', DECK_A, dest], g.io)).toBe(0);
    onlyTo(g, SITE_A, KEY_A);
    expect(await readLink(dest)).toEqual({ presentationId: DECK_A, baseUrl: SITE_A });
  });

  it('agent-doc and pull-annotations with no id: the folder’s site; with an id the folder plays no part (the default, B)', async () => {
    const env = await machine();
    const dir = await linkedDeck(SITE_A);
    process.chdir(dir);

    const h = harness(env);
    expect(await run(['agent-doc'], h.io)).toBe(0);
    expect(h.out()).toBe('# The brief\n');
    onlyTo(h, SITE_A, KEY_A);
    expect(asked(h, 'GET', `/api/v1/presentations/${DECK_A}/agent-doc`)).toBe(true);

    const g = harness(env);
    expect(await run(['pull-annotations'], g.io)).toBe(0);
    onlyTo(g, SITE_A, KEY_A);
    expect(asked(g, 'GET', `/api/v1/presentations/${DECK_A}/annotations`)).toBe(true);

    // An explicit id names no folder: the default profile's site, as before R6.
    const i = harness(env);
    expect(await run(['agent-doc', DECK_B], i.io)).toBe(0);
    onlyTo(i, SITE_B, KEY_B);
    const j = harness(env);
    expect(await run(['pull-annotations', DECK_B], j.io)).toBe(0);
    onlyTo(j, SITE_B, KEY_B);
  });

  it('projects link and projects brand with a linked folder: on the folder’s site', async () => {
    const env = await machine();
    const dir = await linkedDeck(SITE_A);

    const h = harness(env);
    expect(await run(['projects', 'link', PROJECT, dir], h.io)).toBe(0);
    onlyTo(h, SITE_A, KEY_A);
    expect(asked(h, 'PUT', `/api/v1/presentations/${DECK_A}/projects/${PROJECT}`)).toBe(true);

    const g = harness(env);
    expect(await run(['projects', 'brand', PROJECT, dir], g.io)).toBe(0);
    onlyTo(g, SITE_A, KEY_A);
    expect(g.wire.find((c) => c.path === `/api/v1/projects/${PROJECT}/brand`)?.body).toEqual({
      presentationId: DECK_A
    });
  });

  it('brand pull inside the linked deck folder: from its site, written beside the deck with a link naming it', async () => {
    const env = await machine();
    const dir = await linkedDeck(SITE_A);
    process.chdir(dir);
    const h = harness(env);
    expect(await run(['brand', 'pull', 'house'], h.io)).toBe(0);
    onlyTo(h, SITE_A, KEY_A);
    const dest = referenceDirFor(await realpath(dir), 'brand');
    expect(await readFile(join(dest, 'index.html'))).toEqual(PULLED);
    expect(await readReferenceLink(dest)).toEqual({
      presentationId: HOUSE,
      baseUrl: SITE_A,
      reference: { type: 'brand', version: 3 }
    });
  });

  it('--api-url naming the folder’s own site: runs there', async () => {
    const env = await machine();
    const dir = await linkedDeck(SITE_A);
    const h = harness(env);
    expect(await run(['--api-url', SITE_A, 'push', dir], h.io)).toBe(0);
    onlyTo(h, SITE_A, KEY_A);
    expect(asked(h, 'POST', `/api/v1/presentations/${DECK_A}/versions`)).toBe(true);
  });

  it('push --new and push --id keep their freedom: another site named runs there and relinks the folder', async () => {
    const env = await machine();

    const dir = await linkedDeck(SITE_A);
    const h = harness(env);
    expect(await run(['push', dir, '--new', '--api-url', SITE_B], h.io)).toBe(0);
    onlyTo(h, SITE_B, KEY_B);
    expect(asked(h, 'POST', `/api/v1/presentations/uploads/${SESSION_ID}/commit`)).toBe(true);
    expect(await readLink(dir)).toEqual({ presentationId: NEW_DECK, baseUrl: SITE_B });

    const byId = await linkedDeck(SITE_A);
    const g = harness(env);
    expect(await run(['push', byId, '--id', DECK_B, '--api-url', SITE_B], g.io)).toBe(0);
    onlyTo(g, SITE_B, KEY_B);
    expect(asked(g, 'POST', `/api/v1/presentations/${DECK_B}/versions`)).toBe(true);
    expect(await readLink(byId)).toEqual({ presentationId: DECK_B, baseUrl: SITE_B });

    // --new with no site named: a fresh deck on the folder's own site.
    const fresh = await linkedDeck(SITE_A);
    const i = harness(env);
    expect(await run(['push', fresh, '--new'], i.io)).toBe(0);
    onlyTo(i, SITE_A, KEY_A);
    expect(await readLink(fresh)).toEqual({ presentationId: NEW_DECK, baseUrl: SITE_A });
  });
});

describe('a link file names its site in any spelling of it: instances compared, never strings', () => {
  const BRAND_AGENT = '---\ntype: brand\ntitle: House brand\n---\n\n# House brand\n';

  it('push from a folder linked as HTTP://Site-A/: a new version on A, and a brand pulled from that spelling is recorded', async () => {
    const env = await machine();
    const dir = await linkedDeck(SITE_A_SPELT);
    const brandDir = referenceDirFor(dir, 'brand');
    await mkdir(brandDir, { recursive: true });
    await writeLink(brandDir, {
      presentationId: HOUSE,
      baseUrl: SITE_A_SPELT,
      reference: { type: 'brand', version: 3 }
    });
    const h = harness(env);
    expect(await run(['push', dir], h.io)).toBe(0);
    // No refusal, and no « was pulled from … not … » note.
    expect(h.err()).toBe('');
    onlyTo(h, SITE_A, KEY_A);
    expect(asked(h, 'POST', `/api/v1/presentations/${DECK_A}/versions`)).toBe(true);
    expect(h.wire.find((c) => c.method === 'PATCH')?.body).toEqual({
      metadata: { references: [{ type: 'brand', id: HOUSE, version: 3 }] }
    });
    expect(await readLink(dir)).toEqual({ presentationId: DECK_A, baseUrl: SITE_A });
  });

  it('pull with no id in a folder linked as HTTP://Site-A/, and pull <id> <path> into one: from A', async () => {
    const env = await machine();
    const dir = await linkedDeck(SITE_A_SPELT);
    process.chdir(dir);
    const h = harness(env);
    expect(await run(['pull'], h.io)).toBe(0);
    expect(h.err()).toBe('');
    onlyTo(h, SITE_A, KEY_A);

    process.chdir(cwd);
    const dest = await linkedDeck(SITE_A_SPELT);
    const g = harness(env);
    expect(await run(['pull', DECK_A, dest], g.io)).toBe(0);
    expect(g.err()).toBe('');
    onlyTo(g, SITE_A, KEY_A);
    expect(await readFile(join(dest, 'index.html'))).toEqual(PULLED);
  });

  it('a brand folder linked as HTTP://Site-A/: a second pull replaces it, and a push from it keeps its reference block', async () => {
    const env = await machine();
    const dir = await linkedDeck(SITE_A);
    const brandDir = referenceDirFor(dir, 'brand');
    await mkdir(brandDir, { recursive: true });
    await writeFile(join(brandDir, 'index.html'), '<html>brand v2</html>');
    await writeLink(brandDir, {
      presentationId: HOUSE,
      baseUrl: SITE_A_SPELT,
      reference: { type: 'brand', version: 2 }
    });
    process.chdir(dir);
    const h = harness(env);
    expect(await run(['brand', 'pull', 'house'], h.io)).toBe(0);
    onlyTo(h, SITE_A, KEY_A);
    expect(await readFile(join(brandDir, 'index.html'))).toEqual(PULLED);
    expect(await readReferenceLink(brandDir)).toEqual({
      presentationId: HOUSE,
      baseUrl: SITE_A,
      reference: { type: 'brand', version: 3 }
    });

    // Its owner fixing the brand from the pulled folder: the block stays, at the version pushed.
    process.chdir(cwd);
    const ref = await linkedDeck(SITE_A_SPELT, HOUSE, {
      'AGENT.md': BRAND_AGENT,
      'index.html': '<html>brand</html>'
    });
    await writeLink(ref, {
      presentationId: HOUSE,
      baseUrl: SITE_A_SPELT,
      reference: { type: 'brand', version: 3 }
    });
    const g = harness(env);
    expect(await run(['brand', 'push', ref], g.io)).toBe(0);
    onlyTo(g, SITE_A, KEY_A);
    expect(await readReferenceLink(ref)).toEqual({
      presentationId: HOUSE,
      baseUrl: SITE_A,
      reference: { type: 'brand', version: 4 }
    });
  });
});

describe('the refusals of R6, each before any request', () => {
  it('push with an explicit site naming another: --profile, --api-url, --url, SLIDELESS_URL', async () => {
    const env = await machine();
    const dir = await linkedDeck(SITE_A);
    const cases: Array<{ argv: string[]; env?: Record<string, string>; by: string; back: string }> = [
      { argv: ['--profile', 'b', 'push', dir], by: '--profile b', back: 'Drop --profile' },
      { argv: ['--api-url', SITE_B, 'push', dir], by: '--api-url', back: 'Drop --api-url' },
      { argv: ['--url', SITE_B, 'push', dir], by: '--url', back: 'Drop --url' },
      {
        argv: ['push', dir],
        env: { SLIDELESS_URL: SITE_B },
        by: 'SLIDELESS_URL',
        back: 'Unset SLIDELESS_URL'
      }
    ];
    for (const c of cases) {
      const h = harness({ ...env, ...c.env });
      expect(await run(c.argv, h.io)).toBe(1);
      expect(h.calls).toEqual([]);
      expect(h.err()).toBe(
        `Error: .slideless.json links ${dir} to ${SITE_A}, and ${c.by} names ${SITE_B}. ${c.back} to run on ` +
          "the folder's own site, or pass --new to make a fresh deck there.\n"
      );
    }
  });

  it('pull and agent-doc in the linked folder with another site named: each its own ending', async () => {
    const env = await machine();
    const dir = await linkedDeck(SITE_A);
    process.chdir(dir);
    const here = await realpath(dir);

    const h = harness(env);
    expect(await run(['--api-url', SITE_B, 'pull'], h.io)).toBe(1);
    expect(h.calls).toEqual([]);
    expect(h.err()).toBe(
      `Error: .slideless.json links ${here} to ${SITE_A}, and --api-url names ${SITE_B}. Drop --api-url to ` +
        "run on the folder's own site, or pull into another folder.\n"
    );

    const g = harness(env);
    expect(await run(['--api-url', SITE_B, 'agent-doc'], g.io)).toBe(1);
    expect(g.calls).toEqual([]);
    expect(g.err()).toBe(
      `Error: .slideless.json links ${here} to ${SITE_A}, and --api-url names ${SITE_B}. Drop --api-url to ` +
        "run on the folder's own site.\n"
    );
  });

  it('(a) a folder linked to a site no profile of this machine is; --api-url naming it runs there', async () => {
    const env = await machine();
    const dir = await linkedDeck(SITE_C);
    const h = harness(env);
    expect(await run(['push', dir], h.io)).toBe(1);
    expect(h.calls).toEqual([]);
    expect(h.err()).toBe(
      `Error: .slideless.json links ${dir} to ${SITE_C}, which no profile on this machine is. Add it once ` +
        `with \`slideless profiles add ${SITE_C}\`, or name it for this command with --api-url ${SITE_C}.\n`
    );

    const g = harness(env);
    expect(await run(['push', dir, '--api-url', SITE_C, '--api-key', KEY_LINE], g.io)).toBe(0);
    onlyTo(g, SITE_C, KEY_LINE);
  });

  it('(b) a key on the command line, on a folder whose site is not the default’s', async () => {
    const env = await machine();
    const dir = await linkedDeck(SITE_A);
    const sentence = (flag: string) =>
      `Error: ${flag} names no site, and .slideless.json links ${dir} to ${SITE_A} while the default ` +
      `profile is ${SITE_B}. Add --api-url ${SITE_A} to send this key there.\n`;

    const h = harness(env);
    expect(await run(['push', dir, '--api-key', KEY_LINE], h.io)).toBe(1);
    expect(h.calls).toEqual([]);
    expect(h.err()).toBe(sentence('--api-key'));

    // The runner reads stdin before parsing, as for any --api-key-stdin.
    const s = harness(env);
    s.io.readStdin = async () => `${KEY_LINE}\n`;
    expect(await run(['push', dir, '--api-key-stdin'], s.io)).toBe(1);
    expect(s.calls).toEqual([]);
    expect(s.err()).toBe(sentence('--api-key-stdin'));

    // With the site named, the key goes there.
    const g = harness(env);
    expect(await run(['push', dir, '--api-key', KEY_LINE, '--api-url', SITE_A], g.io)).toBe(0);
    onlyTo(g, SITE_A, KEY_LINE);

    // With A the default, nothing is in doubt: the key goes to A.
    const i = harness(await machine('a'));
    expect(await run(['push', dir, '--api-key', KEY_LINE], i.io)).toBe(0);
    onlyTo(i, SITE_A, KEY_LINE);
  });

  it('an exported key with no SLIDELESS_URL on a folder linked to A: the kit’s own refusal', async () => {
    const env = await machine();
    const dir = await linkedDeck(SITE_A);
    const h = harness({ ...env, SLIDELESS_API_KEY: 'slk_env_0123456789abcdef' });
    expect(await run(['push', dir], h.io)).toBe(1);
    expect(h.calls).toEqual([]);
    expect(h.err()).toContain('SLIDELESS_API_KEY');
  });

  it('a link whose site is not an http(s) URL: push refused with the sentence `open` says', async () => {
    const env = await machine();
    const dir = await linkedDeck('javascript:alert(1)');
    const h = harness(env);
    expect(await run(['push', dir], h.io)).toBe(1);
    expect(h.calls).toEqual([]);
    expect(h.err()).toBe(
      'Error: .slideless.json names "javascript:alert(1)" as the instance, which is not an http(s) URL: ' +
        'nothing is opened or sent there. Fix the file, or delete it and push the folder again.\n'
    );
  });
});
