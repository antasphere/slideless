import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { run } from '../src/index.js';
import { readLink, writeLink } from '../src/manifest.js';
import { DECK, routedHarness, VERSION_ROW, type Route } from './harness.js';

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

const SESSION_ID = '33333333-3333-3333-3333-333333333333';

async function makeDeckDir(): Promise<{ dir: string; hashes: Record<string, string> }> {
  const dir = await mkdtemp(join(tmpdir(), 'slideless-push-'));
  await writeFile(join(dir, 'index.html'), '<html>v1</html>');
  await mkdir(join(dir, 'img'), { recursive: true });
  await writeFile(join(dir, 'img', 'dot.png'), Buffer.from([1, 2, 3]));
  return {
    dir,
    hashes: { 'index.html': sha('<html>v1</html>'), 'img/dot.png': sha(Buffer.from([1, 2, 3])) }
  };
}

function pushRoutes(opts: { missing: string[]; existingDeck?: boolean }): Route[] {
  const uploaded: string[] = [];
  const routes: Route[] = [
    {
      method: 'POST',
      path: /\/api\/v1\/presentations\/precheck$/,
      reply: () => ({ body: { missing: opts.missing } })
    },
    {
      method: 'POST',
      path: /\/api\/v1\/presentations\/assets$/,
      reply: ({ body }) => {
        uploaded.push((body as { sha256: string }).sha256);
        return {
          status: 201,
          body: { sha256: (body as { sha256: string }).sha256, sizeBytes: 1, deduplicated: false }
        };
      }
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
      reply: () => ({
        status: 201,
        body: { presentation: { ...DECK, currentVersion: 1 }, version: VERSION_ROW }
      })
    }
  ];
  if (opts.existingDeck) {
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
          body: {
            presentation: { ...DECK, currentVersion: 4 },
            version: { ...VERSION_ROW, version: 4 }
          }
        })
      }
    );
  }
  return routes;
}

describe('push', () => {
  it('new deck: session → precheck → upload missing → commit → link file', async () => {
    const { dir, hashes } = await makeDeckDir();
    const h = routedHarness(pushRoutes({ missing: [hashes['index.html']!] }));
    const code = await run(
      ['push', dir, '--title', 'CLI Deck', '--url', 'http://x', '--api-key', 'slk_k_s'],
      h.io
    );
    expect(h.err()).toBe('');
    expect(code).toBe(0);

    const paths = h.calls.map((c) => `${c.method} ${c.path.split('?')[0]}`);
    expect(paths).toContain('POST /api/v1/presentations/uploads');
    expect(paths).toContain('POST /api/v1/presentations/precheck');
    // Only the missing blob was uploaded.
    expect(paths.filter((p) => p === 'POST /api/v1/presentations/assets')).toHaveLength(1);
    expect(paths).toContain(`POST /api/v1/presentations/uploads/${SESSION_ID}/commit`);

    const commit = h.calls.find((c) => c.path.includes('/commit'))!;
    const body = commit.body as {
      title: string;
      entryPath: string;
      manifest: Array<{ path: string; sha256: string }>;
    };
    expect(body.title).toBe('CLI Deck');
    expect(body.entryPath).toBe('index.html');
    expect(body.manifest.map((m) => m.path).sort()).toEqual(['img/dot.png', 'index.html']);

    // The link file binds the folder to the deck + instance.
    expect(await readLink(dir)).toEqual({ presentationId: DECK.id, baseUrl: 'http://x' });
    expect(h.out()).toContain(DECK.id);
  });

  it('linked folder: pushes a new version with expectedBaseVersion = currentVersion', async () => {
    const { dir } = await makeDeckDir();
    await writeLink(dir, { presentationId: DECK.id, baseUrl: 'http://x' });
    const h = routedHarness(pushRoutes({ missing: [], existingDeck: true }));
    const code = await run(['push', dir, '--url', 'http://x', '--api-key', 'slk_k_s'], h.io);
    expect(h.err()).toBe('');
    expect(code).toBe(0);
    const commit = h.calls.find((c) => c.path.endsWith('/versions'))!;
    expect((commit.body as { expectedBaseVersion: number }).expectedBaseVersion).toBe(3);
    // No uploads — precheck said nothing is missing.
    expect(h.calls.some((c) => c.path.endsWith('/assets'))).toBe(false);
    expect(h.out()).toContain('version 4');
  });

  it('refuses a link that points at a different instance (unless --new/--id)', async () => {
    const { dir } = await makeDeckDir();
    await writeLink(dir, { presentationId: DECK.id, baseUrl: 'http://other' });
    const h = routedHarness([]);
    const code = await run(['push', dir, '--url', 'http://x', '--api-key', 'slk_k_s'], h.io);
    expect(code).toBe(1);
    expect(h.err()).toContain('http://other');
    expect(h.calls).toHaveLength(0);
  });

  it('maps a version_conflict 409 to a friendly retry error', async () => {
    const { dir } = await makeDeckDir();
    const routes = pushRoutes({ missing: [], existingDeck: true });
    routes.splice(
      routes.findIndex((r) => r.path.source.endsWith('/versions$')),
      1
    );
    routes.push({
      method: 'POST',
      path: new RegExp(`/api/v1/presentations/${DECK.id}/versions$`),
      reply: () => ({
        status: 409,
        body: { error: { code: 'version_conflict', message: 'stale expectedBaseVersion' } }
      })
    });
    const h = routedHarness(routes);
    const code = await run(['push', dir, '--id', DECK.id, '--url', 'http://x', '--api-key', 'slk_k_s'], h.io);
    expect(code).toBe(1);
    // The CLI's OWN sentence, not the generic PlatformApiError fallback —
    // that one also ends in "rerun to retry", so `toContain('rerun')` passed
    // whether or not the version_conflict branch ran at all.
    expect(h.err()).toContain('Someone pushed a new version while this push was running');
  });
});

describe('pull', () => {
  it('writes every manifest file byte-exactly and links the folder', async () => {
    const htmlBytes = Buffer.from('<html>pulled</html>');
    const pngBytes = Buffer.from([9, 8, 7, 6]);
    const manifest = [
      { path: 'index.html', sha256: sha(htmlBytes), sizeBytes: htmlBytes.length, contentType: 'text/html' },
      { path: 'img/dot.png', sha256: sha(pngBytes), sizeBytes: pngBytes.length, contentType: 'image/png' }
    ];
    const blobs: Record<string, Buffer> = { [sha(htmlBytes)]: htmlBytes, [sha(pngBytes)]: pngBytes };
    const h = routedHarness([
      {
        method: 'GET',
        path: new RegExp(`/api/v1/presentations/${DECK.id}$`),
        reply: () => ({ body: { ...DECK, currentVersion: 2 } })
      },
      {
        method: 'GET',
        path: new RegExp(`/api/v1/presentations/${DECK.id}/versions/2$`),
        reply: () => ({ body: { ...VERSION_ROW, version: 2, fileCount: 2, manifest } })
      },
      {
        method: 'GET',
        path: new RegExp(`/api/v1/presentations/${DECK.id}/assets/`),
        reply: ({ path }) => {
          const hash = path.split('/').pop()!;
          return { raw: new Response(blobs[hash], { status: 200 }) };
        }
      }
    ]);
    const dest = join(await mkdtemp(join(tmpdir(), 'slideless-pull-')), 'out');
    const code = await run(['pull', DECK.id, dest, '--url', 'http://x', '--api-key', 'slk_k_s'], h.io);
    expect(h.err()).toBe('');
    expect(code).toBe(0);
    expect(await readFile(join(dest, 'index.html'))).toEqual(htmlBytes);
    expect(await readFile(join(dest, 'img', 'dot.png'))).toEqual(pngBytes);
    expect(await readLink(dest)).toEqual({ presentationId: DECK.id, baseUrl: 'http://x' });
  });

  it('honors --at <version>', async () => {
    const h = routedHarness([
      {
        method: 'GET',
        path: new RegExp(`/api/v1/presentations/${DECK.id}$`),
        reply: () => ({ body: { ...DECK, currentVersion: 5 } })
      },
      {
        method: 'GET',
        path: new RegExp(`/api/v1/presentations/${DECK.id}/versions/1$`),
        reply: () => ({ body: { ...VERSION_ROW, manifest: [] } })
      }
    ]);
    const dest = join(await mkdtemp(join(tmpdir(), 'slideless-pull-')), 'v1');
    const code = await run(
      ['pull', DECK.id, dest, '--at', '1', '--url', 'http://x', '--api-key', 'slk_k_s'],
      h.io
    );
    expect(code).toBe(0);
    expect(h.calls.some((c) => c.path.endsWith('/versions/1'))).toBe(true);
  });
});
