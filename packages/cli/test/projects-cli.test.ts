import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { run } from '../src/index.js';
import { writeLink } from '../src/manifest.js';
import { DECK, routedHarness, VERSION_ROW, type Route } from './harness.js';

/**
 * PRDCT-2579 on the command line: the DECK's side of the projects (ADR 026)
 * through the in-process runner. `projects link|unlink|brand` hung off the
 * chassis's own `projects` group, `--project` on `push` (both branches),
 * `list` and the reference listings. Every assertion is on the requests the
 * CLI made (`h.calls`: method, path, body) or on what it printed; the
 * `--json` sinks are asserted byte-exact, and each refusal by its sentence.
 */

const URL_ = 'http://x';
const KEY = 'slk_k_s';
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

const SESSION_ID = '33333333-3333-3333-3333-333333333333';
const PROJECT = 'aaaaaaaa-2222-4222-8222-222222222222';
const PROJECT_2 = 'bbbbbbbb-2222-4222-8222-222222222222';
const BRAND_ID = 'cccccccc-2222-4222-8222-222222222222';

const argv = (...rest: string[]) => [...rest, '--url', URL_, '--api-key', KEY];

/** A deck row carrying the projects it is in. */
const deckIn = (projects: Array<{ id: string; name: string; isBrand: boolean }>) => ({
  ...DECK,
  projects
});

const ATLAS = { id: PROJECT, name: 'Atlas', isBrand: false };
const BOREALIS = { id: PROJECT_2, name: 'Borealis', isBrand: false };

/** An error body in the server's shape. */
const refusal = (status: number, code: string): { status: number; body: unknown } => ({
  status,
  body: { error: { code, message: 'terse wire message' } }
});

/** `${method} ${path}` for every recorded call, query string dropped. */
const wire = (calls: Array<{ method: string; path: string }>): string[] =>
  calls.map((c) => `${c.method} ${c.path.split('?')[0]}`);

// ── projects link / unlink ───────────────────────────────────────────────────

describe('projects link', () => {
  const route = (answer: { status: number; body: unknown }): Route => ({
    method: 'PUT',
    path: /\/api\/v1\/presentations\/[^/]+\/projects\/[^/]+$/,
    reply: () => answer
  });

  it('PUTs the deck onto the project and names the projects it is in now', async () => {
    const h = routedHarness([route({ status: 200, body: deckIn([ATLAS]) })]);
    const code = await run(argv('projects', 'link', PROJECT, DECK.id), h.io);
    expect(h.err()).toBe('');
    expect(code).toBe(0);
    expect(wire(h.calls)).toEqual([`PUT /api/v1/presentations/${DECK.id}/projects/${PROJECT}`]);
    expect(h.out()).toBe('"Test Deck" is in 1 project: Atlas\n');
  });

  it('marks the project whose brand the deck is', async () => {
    const h = routedHarness([route({ status: 200, body: deckIn([{ ...ATLAS, isBrand: true }, BOREALIS]) })]);
    expect(await run(argv('projects', 'link', PROJECT, DECK.id), h.io)).toBe(0);
    expect(h.out()).toBe('"Test Deck" is in 2 projects: Atlas (brand), Borealis\n');
  });

  it('--json is the deck payload, byte-exact', async () => {
    const body = deckIn([ATLAS]);
    const h = routedHarness([route({ status: 200, body })]);
    expect(await run(argv('projects', 'link', PROJECT, DECK.id, '--json'), h.io)).toBe(0);
    expect(h.out()).toBe(`${JSON.stringify(body, null, 2)}\n`);
  });

  it('takes the deck from the current folder’s link file when none is named', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'slideless-projects-'));
    await writeLink(dir, { presentationId: DECK.id, baseUrl: URL_ });
    const h = routedHarness([route({ status: 200, body: deckIn([ATLAS]) })]);
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      expect(await run(argv('projects', 'link', PROJECT), h.io)).toBe(0);
    } finally {
      process.chdir(cwd);
    }
    expect(wire(h.calls)).toEqual([`PUT /api/v1/presentations/${DECK.id}/projects/${PROJECT}`]);
  });

  it('takes the deck from a NAMED folder’s link file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'slideless-projects-'));
    await writeLink(dir, { presentationId: DECK.id, baseUrl: URL_ });
    const h = routedHarness([route({ status: 200, body: deckIn([ATLAS]) })]);
    expect(await run(argv('projects', 'link', PROJECT, dir), h.io)).toBe(0);
    expect(wire(h.calls)).toEqual([`PUT /api/v1/presentations/${DECK.id}/projects/${PROJECT}`]);
  });

  it('refuses a link file that names another instance, before any call', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'slideless-projects-'));
    await writeLink(dir, { presentationId: DECK.id, baseUrl: 'http://other' });
    const h = routedHarness([route({ status: 200, body: deckIn([ATLAS]) })]);
    expect(await run(argv('projects', 'link', PROJECT, dir), h.io)).toBe(1);
    expect(h.calls).toEqual([]);
    expect(h.err()).toContain('links that folder to http://other');
  });

  it('says so when there is neither a deck nor a link file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'slideless-projects-'));
    const h = routedHarness([route({ status: 200, body: deckIn([ATLAS]) })]);
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      expect(await run(argv('projects', 'link', PROJECT), h.io)).toBe(1);
    } finally {
      process.chdir(cwd);
    }
    expect(h.calls).toEqual([]);
    expect(h.err()).toContain('No deck given and no .slideless.json in the current folder');
  });

  for (const [code, status, sentence] of [
    ['project_not_found', 404, 'No such project, or it is not yours to read.'],
    ['not_found', 404, 'No such deck, or it is not yours to read.'],
    ['insufficient_project_role', 403, 'You need editor or more on this project to put a deck in it.'],
    ['project_archived', 409, 'This project is archived and read-only.'],
    ['guest_forbidden', 403, 'You are a guest of this workspace'],
    ['forbidden', 403, 'Only the deck administrator']
  ] as const) {
    it(`turns ${code} into a sentence`, async () => {
      const h = routedHarness([route(refusal(status, code))]);
      expect(await run(argv('projects', 'link', PROJECT, DECK.id), h.io)).toBe(1);
      expect(h.err()).toContain(sentence);
      // Never the terse wire message on its own.
      expect(h.err()).not.toContain('terse wire message');
    });
  }
});

describe('projects unlink', () => {
  const route = (answer: { status: number; body: unknown }): Route => ({
    method: 'DELETE',
    path: /\/api\/v1\/presentations\/[^/]+\/projects\/[^/]+$/,
    reply: () => answer
  });

  it('DELETEs the link and says what is left', async () => {
    const h = routedHarness([route({ status: 200, body: deckIn([BOREALIS]) })]);
    expect(await run(argv('projects', 'unlink', PROJECT, DECK.id), h.io)).toBe(0);
    expect(wire(h.calls)).toEqual([`DELETE /api/v1/presentations/${DECK.id}/projects/${PROJECT}`]);
    expect(h.out()).toBe('"Test Deck" is in 1 project: Borealis\n');
  });

  it('says the deck is in no project when the last link goes', async () => {
    const h = routedHarness([route({ status: 200, body: deckIn([]) })]);
    expect(await run(argv('projects', 'unlink', PROJECT, DECK.id), h.io)).toBe(0);
    expect(h.out()).toBe('"Test Deck" is in no project.\n');
  });

  it('reads not_linked as "nothing to unlink", and forbidden as the two who may', async () => {
    const a = routedHarness([route(refusal(404, 'not_linked'))]);
    expect(await run(argv('projects', 'unlink', PROJECT, DECK.id), a.io)).toBe(1);
    expect(a.err()).toContain('That deck is not in this project, so there is nothing to unlink.');

    const b = routedHarness([route(refusal(403, 'forbidden'))]);
    expect(await run(argv('projects', 'unlink', PROJECT, DECK.id), b.io)).toBe(1);
    expect(b.err()).toContain('or a manager of the project takes a deck out of it');
  });
});

// ── projects brand ───────────────────────────────────────────────────────────

describe('projects brand', () => {
  const BRAND_ROW = { ...DECK, id: BRAND_ID, title: 'House brand', currentVersion: 3 };
  const get = (answer: { status: number; body: unknown }): Route => ({
    method: 'GET',
    path: /\/api\/v1\/projects\/[^/]+\/brand$/,
    reply: () => answer
  });
  const put = (answer: { status: number; body: unknown }): Route => ({
    method: 'PUT',
    path: /\/api\/v1\/projects\/[^/]+\/brand$/,
    reply: () => answer
  });
  const del = (answer: { status: number; body: unknown }): Route => ({
    method: 'DELETE',
    path: /\/api\/v1\/projects\/[^/]+\/brand$/,
    reply: () => answer
  });

  it('with no ref: GETs the brand and prints its title, id and version', async () => {
    const h = routedHarness([get({ status: 200, body: { brand: BRAND_ROW } })]);
    expect(await run(argv('projects', 'brand', PROJECT), h.io)).toBe(0);
    expect(wire(h.calls)).toEqual([`GET /api/v1/projects/${PROJECT}/brand`]);
    expect(h.out()).toBe(`House brand\n  id:      ${BRAND_ID}\n  version: 3\n`);
  });

  it('--json is `{ brand }` byte-exact, null included', async () => {
    const h = routedHarness([get({ status: 200, body: { brand: null } })]);
    expect(await run(argv('projects', 'brand', PROJECT, '--json'), h.io)).toBe(0);
    expect(h.out()).toBe(`${JSON.stringify({ brand: null }, null, 2)}\n`);
  });

  it('points at the set command when there is no brand', async () => {
    const h = routedHarness([get({ status: 200, body: { brand: null } })]);
    expect(await run(argv('projects', 'brand', PROJECT), h.io)).toBe(0);
    expect(h.out()).toContain('slideless projects brand <project> <ref>');
  });

  it('with a ref: PUTs { presentationId } and prints the new brand', async () => {
    const h = routedHarness([put({ status: 200, body: { brand: BRAND_ROW } })]);
    expect(await run(argv('projects', 'brand', PROJECT, BRAND_ID), h.io)).toBe(0);
    expect(wire(h.calls)).toEqual([`PUT /api/v1/projects/${PROJECT}/brand`]);
    expect(h.calls[0]!.body).toEqual({ presentationId: BRAND_ID });
    expect(h.out()).toContain('House brand');
  });

  it('--clear DELETEs it and says the deck and its link stay', async () => {
    const h = routedHarness([del({ status: 200, body: { brand: null } })]);
    expect(await run(argv('projects', 'brand', PROJECT, '--clear'), h.io)).toBe(0);
    expect(wire(h.calls)).toEqual([`DELETE /api/v1/projects/${PROJECT}/brand`]);
    expect(h.out()).toContain('the deck and its link stay');
  });

  it('refuses a ref beside --clear, before any call', async () => {
    const h = routedHarness([del({ status: 200, body: { brand: null } })]);
    expect(await run(argv('projects', 'brand', PROJECT, BRAND_ID, '--clear'), h.io)).toBe(1);
    expect(h.calls).toEqual([]);
    expect(h.err()).toContain('Name the brand to set, or pass --clear, not both.');
  });

  it('reads not_linked as "link it first" and not_a_brand as "push it as a brand"', async () => {
    const a = routedHarness([put(refusal(409, 'not_linked'))]);
    expect(await run(argv('projects', 'brand', PROJECT, BRAND_ID), a.io)).toBe(1);
    expect(a.err()).toContain('That deck is not in this project. Link it first');

    const b = routedHarness([put(refusal(400, 'not_a_brand'))]);
    expect(await run(argv('projects', 'brand', PROJECT, BRAND_ID), b.io)).toBe(1);
    expect(b.err()).toContain('is not a brand reference');
  });

  it('asks for the manager role, not the editor one, on insufficient_project_role', async () => {
    const h = routedHarness([put(refusal(403, 'insufficient_project_role'))]);
    expect(await run(argv('projects', 'brand', PROJECT, BRAND_ID), h.io)).toBe(1);
    expect(h.err()).toContain('You need the manager role on this project to change its brand.');
  });
});

// ── the --project filter on the listings ─────────────────────────────────────

describe('--project on the listings', () => {
  const listRoute = (answer?: { status: number; body: unknown }): Route => ({
    method: 'GET',
    path: /\/api\/v1\/presentations$/,
    reply: () => answer ?? { body: { presentations: [deckIn([ATLAS])], nextCursor: null } }
  });

  /** The query string of the recorded presentations list calls. */
  const queries = (calls: Array<{ method: string; path: string }>): string[] =>
    calls
      .filter((c) => c.method === 'GET' && c.path.startsWith('/api/v1/presentations?'))
      .map((c) => c.path.slice('/api/v1/presentations?'.length));

  it('list --project sends project=<id> and nothing else', async () => {
    const h = routedHarness([listRoute()]);
    expect(await run(argv('list', '--project', PROJECT), h.io)).toBe(0);
    expect(queries(h.calls)).toEqual([`project=${PROJECT}`]);
  });

  it('list without --project sends no project at all', async () => {
    const h = routedHarness([listRoute()]);
    expect(await run(argv('list'), h.io)).toBe(0);
    expect(h.calls.map((c) => c.path)).toEqual(['/api/v1/presentations']);
  });

  it('threads the project across every page of --all', async () => {
    let page = 0;
    const h = routedHarness([
      {
        method: 'GET',
        path: /\/api\/v1\/presentations$/,
        reply: () => ({
          body: { presentations: [deckIn([ATLAS])], nextCursor: page++ === 0 ? 'c2' : null }
        })
      }
    ]);
    expect(await run(argv('list', '--project', PROJECT, '--all'), h.io)).toBe(0);
    expect(queries(h.calls)).toEqual([`project=${PROJECT}`, `cursor=c2&project=${PROJECT}`]);
  });

  it('names the projects in a column, and only when a row has some', async () => {
    const withProjects = routedHarness([listRoute()]);
    expect(await run(argv('list'), withProjects.io)).toBe(0);
    expect(withProjects.out()).toContain('Atlas');

    const without = routedHarness([
      {
        method: 'GET',
        path: /\/api\/v1\/presentations$/,
        reply: () => ({ body: { presentations: [deckIn([])], nextCursor: null } })
      }
    ]);
    expect(await run(argv('list'), without.io)).toBe(0);
    // The table the workspace has always had: id, version, kind, title.
    expect(without.out()).toBe(`${DECK.id}  v1  presentation  Test Deck\n`);
  });

  it('reads a project it cannot see as the project refusal, not an empty page', async () => {
    const h = routedHarness([listRoute(refusal(404, 'project_not_found'))]);
    expect(await run(argv('list', '--project', PROJECT), h.io)).toBe(1);
    expect(h.err()).toContain('No such project, or it is not yours to read.');
  });

  it('brand list --project sends the type AND the project', async () => {
    const h = routedHarness([
      {
        method: 'GET',
        path: /\/api\/v1\/presentations$/,
        reply: () => ({ body: { presentations: [], nextCursor: null } })
      }
    ]);
    expect(await run(argv('brand', 'list', '--project', PROJECT), h.io)).toBe(0);
    expect(queries(h.calls)).toEqual([`type=brand&project=${PROJECT}`]);
  });

  it('reference list --project keeps the open type', async () => {
    const h = routedHarness([
      {
        method: 'GET',
        path: /\/api\/v1\/presentations$/,
        reply: () => ({ body: { presentations: [], nextCursor: null } })
      }
    ]);
    expect(await run(argv('reference', 'list', '--project', PROJECT), h.io)).toBe(0);
    expect(queries(h.calls)).toEqual([`type=reference&project=${PROJECT}`]);
  });
});

// ── push --project ───────────────────────────────────────────────────────────

async function makeDeckDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'slideless-push-proj-'));
  await writeFile(join(dir, 'index.html'), '<html>v1</html>');
  return dir;
}

function pushRoutes(opts: {
  commit?: (body: unknown) => Record<string, unknown>;
  existing?: boolean;
  link?: (projectId: string) => { status: number; body: unknown };
}): Route[] {
  const routes: Route[] = [
    {
      method: 'POST',
      path: /\/api\/v1\/presentations\/precheck$/,
      reply: () => ({ body: { missing: [] } })
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
            presentationId: DECK.id,
            expiresAt: '2026-01-01T01:00:00.000Z',
            createdAt: '2026-01-01T00:00:00.000Z'
          }
        }
      })
    },
    {
      method: 'POST',
      path: new RegExp(`/api/v1/presentations/uploads/${SESSION_ID}/commit$`),
      reply: ({ body }) => ({
        status: 201,
        body: opts.commit?.(body) ?? { presentation: deckIn([ATLAS]), version: VERSION_ROW }
      })
    }
  ];
  if (opts.existing) {
    routes.push(
      {
        method: 'GET',
        path: new RegExp(`/api/v1/presentations/${DECK.id}$`),
        reply: () => ({ body: { ...DECK, currentVersion: 3 } })
      },
      {
        method: 'POST',
        path: new RegExp(`/api/v1/presentations/${DECK.id}/versions$`),
        reply: () => ({
          status: 201,
          body: { presentation: deckIn([]), version: { ...VERSION_ROW, version: 4 } }
        })
      }
    );
  }
  if (opts.link) {
    routes.push({
      method: 'PUT',
      path: /\/api\/v1\/presentations\/[^/]+\/projects\/[^/]+$/,
      reply: ({ path }) => opts.link!(path.split('?')[0]!.split('/').pop()!)
    });
  }
  return routes;
}

describe('push --project', () => {
  it('a NEW deck carries projectIds in the commit itself, deduped and in order', async () => {
    const dir = await makeDeckDir();
    const h = routedHarness(pushRoutes({}));
    const code = await run(
      argv('push', dir, '--project', PROJECT, '--project', PROJECT_2, '--project', PROJECT, '--no-open'),
      h.io
    );
    expect(h.err()).toBe('');
    expect(code).toBe(0);
    const commit = h.calls.find((c) => c.path.includes('/commit'))!;
    expect((commit.body as { projectIds: string[] }).projectIds).toEqual([PROJECT, PROJECT_2]);
    // Nothing is linked afterwards: the commit is the one transaction.
    expect(h.calls.some((c) => c.method === 'PUT')).toBe(false);
    expect(h.out()).toContain('projects: Atlas');
  });

  it('a push with no --project sends no projectIds at all', async () => {
    const dir = await makeDeckDir();
    const h = routedHarness(pushRoutes({}));
    expect(await run(argv('push', dir, '--no-open'), h.io)).toBe(0);
    const commit = h.calls.find((c) => c.path.includes('/commit'))!;
    expect(Object.keys(commit.body as object)).not.toContain('projectIds');
  });

  it('an EXISTING deck commits the version, then links each project by the link route', async () => {
    const dir = await makeDeckDir();
    await writeLink(dir, { presentationId: DECK.id, baseUrl: URL_ });
    const linked: string[] = [];
    const h = routedHarness(
      pushRoutes({
        existing: true,
        link: (projectId) => {
          linked.push(projectId);
          return {
            status: 200,
            body: deckIn(linked.map((id) => (id === PROJECT ? ATLAS : BOREALIS)))
          };
        }
      })
    );
    const code = await run(
      argv('push', dir, '--project', PROJECT, '--project', PROJECT_2, '--no-open'),
      h.io
    );
    expect(h.err()).toBe('');
    expect(code).toBe(0);
    // The version first, then one link call per project, in the order given.
    expect(wire(h.calls).filter((p) => p.includes('/versions') || p.includes('/projects/'))).toEqual([
      `POST /api/v1/presentations/${DECK.id}/versions`,
      `POST /api/v1/presentations/${DECK.id}/projects/${PROJECT}`.replace('POST', 'PUT'),
      `PUT /api/v1/presentations/${DECK.id}/projects/${PROJECT_2}`
    ]);
    expect(h.out()).toContain('version 4');
    expect(h.out()).toContain('projects: Atlas, Borealis');
  });

  it('a refused link never undoes the version: the push succeeds, the sentence is on stderr', async () => {
    const dir = await makeDeckDir();
    await writeLink(dir, { presentationId: DECK.id, baseUrl: URL_ });
    const h = routedHarness(
      pushRoutes({
        existing: true,
        link: (projectId) =>
          projectId === PROJECT ? { status: 200, body: deckIn([ATLAS]) } : refusal(409, 'project_archived')
      })
    );
    const code = await run(
      argv('push', dir, '--project', PROJECT, '--project', PROJECT_2, '--no-open'),
      h.io
    );
    // The version IS committed and the push is a success.
    expect(code).toBe(0);
    expect(h.out()).toContain('version 4');
    // The one that refused says which and why; the other still went in.
    expect(h.err()).toContain(`project ${PROJECT_2}: This project is archived and read-only.`);
    expect(h.out()).toContain('projects: Atlas');
  });

  it('--json carries projectLinks, one row per --project, with the refusal', async () => {
    const dir = await makeDeckDir();
    await writeLink(dir, { presentationId: DECK.id, baseUrl: URL_ });
    const h = routedHarness(
      pushRoutes({
        existing: true,
        link: () => refusal(403, 'insufficient_project_role')
      })
    );
    expect(await run(argv('push', dir, '--project', PROJECT, '--json'), h.io)).toBe(0);
    const parsed = JSON.parse(h.out()) as {
      projectLinks: Array<{ projectId: string; linked: boolean; error?: string }>;
    };
    expect(parsed.projectLinks).toEqual([
      {
        projectId: PROJECT,
        linked: false,
        error: 'You need editor or more on this project to put a deck in it.'
      }
    ]);
  });

  it('a push with no --project carries no projectLinks key in --json', async () => {
    const dir = await makeDeckDir();
    const h = routedHarness(pushRoutes({}));
    expect(await run(argv('push', dir, '--json'), h.io)).toBe(0);
    expect(Object.keys(JSON.parse(h.out()) as object)).not.toContain('projectLinks');
  });

  it('a NEW deck whose commit refuses a project fails the whole push: nothing is half-placed', async () => {
    const dir = await makeDeckDir();
    const h = routedHarness([
      ...pushRoutes({}).filter((r) => !r.path.source.includes('commit')),
      {
        method: 'POST',
        path: new RegExp(`/api/v1/presentations/uploads/${SESSION_ID}/commit$`),
        reply: () => refusal(404, 'project_not_found')
      }
    ]);
    expect(await run(argv('push', dir, '--project', PROJECT, '--no-open'), h.io)).toBe(1);
    // The commit is one transaction: the whole push fails, and no link call
    // was made to place the deck anywhere.
    expect(h.err()).not.toBe('');
    expect(h.calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('the uploaded bytes are unchanged by the flag (the hash is still the file’s)', async () => {
    const dir = await makeDeckDir();
    const h = routedHarness(pushRoutes({}));
    expect(await run(argv('push', dir, '--project', PROJECT, '--no-open'), h.io)).toBe(0);
    const commit = h.calls.find((c) => c.path.includes('/commit'))!;
    const manifest = (commit.body as { manifest: Array<{ path: string; sha256: string }> }).manifest;
    expect(manifest).toEqual([
      expect.objectContaining({ path: 'index.html', sha256: sha('<html>v1</html>') })
    ]);
  });
});
