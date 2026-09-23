import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, stat, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { run } from '../src/index.js';
import { readLink, scanDeck, writeLink } from '../src/manifest.js';
import { DECK, routedHarness, VERSION_ROW, type Route } from './harness.js';

/**
 * PRDCT-2284, the CLI half of attachments: the `downloads/` folder is
 * classified by the contract's rule, the push says what travels and refuses
 * a file over the instance cap before any write, an unchanged attachment is
 * never re-uploaded, pull restores attachments byte-exactly and contained,
 * `share --no-download` mints a link without downloads, and `tokens` shows
 * the switch and the count.
 */

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const SESSION_ID = '33333333-3333-3333-3333-333333333333';
const HTML = '<html>deck</html>';
const CSV = 'a,b\n1,2\n';
const PDF = Buffer.from('%PDF-1.4 annex');

async function makeDeckWithDownloads(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'slideless-att-'));
  await writeFile(join(dir, 'index.html'), HTML);
  await mkdir(join(dir, 'downloads', 'sub'), { recursive: true });
  await writeFile(join(dir, 'downloads', 'figures.csv'), CSV);
  await writeFile(join(dir, 'downloads', 'sub', 'annex.pdf'), PDF);
  return dir;
}

/** The push fake: precheck answers `missing`, records uploads; optional discovery answer. */
function pushRoutes(opts: { missing: string[]; existingDeck?: boolean; instance?: unknown }): {
  routes: Route[];
  uploaded: string[];
} {
  const uploaded: string[] = [];
  const routes: Route[] = [
    ...(opts.instance !== undefined
      ? [{ method: 'GET', path: /\/api\/v1\/instance$/, reply: () => ({ body: opts.instance }) } as Route]
      : []),
    {
      method: 'POST',
      path: /\/api\/v1\/presentations\/precheck$/,
      reply: () => ({ body: { missing: opts.missing } })
    },
    {
      method: 'POST',
      path: /\/api\/v1\/presentations\/assets$/,
      reply: ({ body }) => {
        const hash = (body as { sha256: string }).sha256;
        uploaded.push(hash);
        return { status: 201, body: { sha256: hash, sizeBytes: 1, deduplicated: false } };
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
        body: {
          presentation: { ...DECK, currentVersion: 1, hasDownloads: true },
          version: { ...VERSION_ROW, hasDownloads: true }
        }
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
            presentation: { ...DECK, currentVersion: 4, hasDownloads: true },
            version: { ...VERSION_ROW, version: 4, hasDownloads: true }
          }
        })
      }
    );
  }
  return { routes, uploaded };
}

const PUSH = (dir: string, ...extra: string[]) => [
  'push',
  dir,
  ...extra,
  '--url',
  'http://x',
  '--api-key',
  'slk_k_s'
];

describe('classification', () => {
  it("marks entries under the root downloads/ folder as attachments by the contract's rule", async () => {
    const dir = await makeDeckWithDownloads();
    // A nested downloads/ is an ordinary folder; the root one is the rule.
    // (The case-sensitive half of the rule is the contract's own test: the
    // disk here may fold case and merge Downloads/ into downloads/.)
    await mkdir(join(dir, 'assets', 'downloads'), { recursive: true });
    await writeFile(join(dir, 'assets', 'downloads', 'not-one.csv'), 'x');
    const scan = await scanDeck(dir);
    const byPath = Object.fromEntries(scan.files.map((f) => [f.path, f.attachment]));
    expect(byPath).toEqual({
      'assets/downloads/not-one.csv': false,
      'downloads/figures.csv': true,
      'downloads/sub/annex.pdf': true,
      'index.html': false
    });
  });
});

describe('push says what travels', () => {
  it('prints the Attachments line and carries the count and bytes in --json', async () => {
    const dir = await makeDeckWithDownloads();
    const { routes } = pushRoutes({ missing: [] });
    const h = routedHarness(routes);
    const code = await run(PUSH(dir), h.io);
    expect(h.err()).toBe('');
    expect(code).toBe(0);
    const bytes = Buffer.byteLength(CSV) + PDF.length;
    expect(h.out()).toContain(`  Attachments: 2 files, ${bytes} B (downloads/)\n`);

    // The first push linked the folder: the JSON run is a later push of it.
    const hj = routedHarness(pushRoutes({ missing: [], existingDeck: true }).routes);
    expect(await run(PUSH(dir, '--json'), hj.io)).toBe(0);
    const parsed = JSON.parse(hj.out()) as { attachments: { count: number; sizeBytes: number }; url: string };
    expect(parsed.attachments).toEqual({ count: 2, sizeBytes: bytes });
    expect(parsed.url).toContain('/present');
  });

  it('the first push (the created branch) carries attachments and url in --json too', async () => {
    const dir = await makeDeckWithDownloads();
    const h = routedHarness(pushRoutes({ missing: [] }).routes);
    expect(await run(PUSH(dir, '--json'), h.io)).toBe(0);
    expect(h.err()).toBe('');
    const parsed = JSON.parse(h.out()) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(['presentation', 'version', 'url', 'attachments']);
    expect(parsed.attachments).toEqual({ count: 2, sizeBytes: Buffer.byteLength(CSV) + PDF.length });
    expect(h.calls.some((c) => c.path.endsWith('/uploads'))).toBe(true);
  });

  it('prints no Attachments line for a deck without a downloads/ folder, and a zero count in --json', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'slideless-att-'));
    await writeFile(join(dir, 'index.html'), HTML);
    const h = routedHarness(pushRoutes({ missing: [] }).routes);
    expect(await run(PUSH(dir), h.io)).toBe(0);
    expect(h.out()).not.toContain('Attachments:');
    // The first push linked the folder: the JSON run is a later push of it.
    const hj = routedHarness(pushRoutes({ missing: [], existingDeck: true }).routes);
    expect(await run(PUSH(dir, '--json'), hj.io)).toBe(0);
    expect((JSON.parse(hj.out()) as { attachments: unknown }).attachments).toEqual({
      count: 0,
      sizeBytes: 0
    });
  });

  it('prints the line on a later push of a linked folder too', async () => {
    const dir = await makeDeckWithDownloads();
    await writeLink(dir, { presentationId: DECK.id, baseUrl: 'http://x' });
    const h = routedHarness(pushRoutes({ missing: [], existingDeck: true }).routes);
    expect(await run(PUSH(dir), h.io)).toBe(0);
    expect(h.out()).toContain('version 4');
    expect(h.out()).toContain('  Attachments: 2 files,');
  });
});

describe('the cap refusal, before any write', () => {
  it('refuses a file over the cap discovery declares (files.maxBytes, the oss value), naming the file and the cap, and touches nothing', async () => {
    const dir = await makeDeckWithDownloads();
    await truncate(join(dir, 'downloads', 'sub', 'annex.pdf'), 1024 * 1024 + 1);
    const { routes, uploaded } = pushRoutes({
      missing: [],
      instance: {
        edition: 'oss',
        entitlements: { limits: { 'files.maxBytes': { oss: 1024 * 1024, free: 1024 * 1024, pro: null } } }
      }
    });
    const h = routedHarness(routes);
    expect(await run(PUSH(dir), h.io)).toBe(1);
    expect(h.err()).toContain('downloads/sub/annex.pdf');
    expect(h.err()).toContain('1.0 MB per-file cap');
    expect(h.err()).toContain('nothing was uploaded');
    expect(uploaded).toEqual([]);
    // Discovery is the only call: no session, no precheck, no upload.
    expect(h.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /api/v1/instance']);
    expect(await readLink(dir)).toBeNull();
  });

  it("a file exactly at the cap passes: the compare is strict, like the instance's own", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'slideless-att-'));
    await writeFile(join(dir, 'index.html'), HTML);
    await writeFile(join(dir, 'exact.bin'), '');
    await truncate(join(dir, 'exact.bin'), 1024 * 1024);
    const { routes } = pushRoutes({
      missing: [],
      instance: {
        edition: 'oss',
        entitlements: { limits: { 'files.maxBytes': { oss: 1024 * 1024, free: 1024 * 1024, pro: null } } }
      }
    });
    const h = routedHarness(routes);
    expect(await run(PUSH(dir), h.io)).toBe(0);
    expect(h.err()).toBe('');
    expect(h.calls.some((c) => c.path.includes('/commit'))).toBe(true);
  });

  it('refuses under --json the same way, with nothing on stdout and no write', async () => {
    const dir = await makeDeckWithDownloads();
    await truncate(join(dir, 'downloads', 'figures.csv'), 5 * 1024 * 1024);
    const { routes, uploaded } = pushRoutes({
      missing: [],
      instance: {
        edition: 'oss',
        entitlements: { limits: { 'files.maxBytes': { oss: 1024 * 1024, free: 1024 * 1024, pro: null } } }
      }
    });
    const h = routedHarness(routes);
    expect(await run(PUSH(dir, '--json'), h.io)).toBe(1);
    expect(h.out()).toBe('');
    expect(h.err()).toContain('downloads/figures.csv is 5.0 MB');
    expect(uploaded).toEqual([]);
    expect(h.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /api/v1/instance']);
  });

  it('applies to any file of the deck, not only attachments', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'slideless-att-'));
    await writeFile(join(dir, 'index.html'), HTML);
    await writeFile(join(dir, 'video.mp4'), '');
    await truncate(join(dir, 'video.mp4'), 2 * 1024 * 1024);
    const { routes, uploaded } = pushRoutes({
      missing: [],
      instance: {
        edition: 'oss',
        entitlements: { limits: { 'files.maxBytes': { oss: 1024 * 1024, free: 1024 * 1024, pro: null } } }
      }
    });
    const h = routedHarness(routes);
    expect(await run(PUSH(dir), h.io)).toBe(1);
    expect(h.err()).toContain('video.mp4 is 2.0 MB');
    expect(uploaded).toEqual([]);
  });

  it('on the cloud edition the cap is the highest tier\u2019s value, never free alone (PRDCT-2653)', async () => {
    const dir = await makeDeckWithDownloads();
    await truncate(join(dir, 'downloads', 'figures.csv'), 50 * 1024 * 1024);
    const MiB = 1024 * 1024;
    const cloud = (limits: Record<string, number | null>) => ({
      edition: 'cloud',
      entitlements: { limits: { 'files.maxBytes': limits } }
    });
    // { oss 100, free 20, pro 100 }: a 50 MiB file passes, though the free
    // value is 20 MiB. The CLI cannot know the plan; the instance answers
    // plan_required on the declared size itself.
    const paid = pushRoutes({
      missing: [],
      instance: cloud({ oss: 100 * MiB, free: 20 * MiB, pro: 100 * MiB })
    });
    const ok = routedHarness(paid.routes);
    expect(await run(PUSH(dir), ok.io), ok.err()).toBe(0);
    expect(ok.err()).not.toContain('per-file cap');
    // Over the pro value: refused upfront, naming the pro cap (100 MB), not
    // the free one. (The first push linked the folder: a later push now.)
    await truncate(join(dir, 'downloads', 'figures.csv'), 100 * MiB + 1);
    const over = pushRoutes({
      missing: [],
      existingDeck: true,
      instance: cloud({ oss: 100 * MiB, free: 20 * MiB, pro: 100 * MiB })
    });
    const refused = routedHarness(over.routes);
    expect(await run(PUSH(dir), refused.io)).toBe(1);
    expect(refused.err()).toContain('100.0 MB per-file cap');
    expect(over.uploaded).toEqual([]);
    // pro null (unlimited) on cloud: nothing is refused upfront, whatever free says.
    const open = pushRoutes({
      missing: [],
      existingDeck: true,
      instance: cloud({ oss: MiB, free: MiB, pro: null })
    });
    const free = routedHarness(open.routes);
    expect(await run(PUSH(dir), free.io), free.err()).toBe(0);
    expect(free.err()).not.toContain('per-file cap');
    // pro absent: the free value is the cap.
    const noPro = pushRoutes({
      missing: [],
      existingDeck: true,
      instance: cloud({ oss: 200 * MiB, free: MiB })
    });
    const tight = routedHarness(noPro.routes);
    expect(await run(PUSH(dir), tight.io)).toBe(1);
    expect(tight.err()).toContain('1.0 MB per-file cap');
    expect(noPro.uploaded).toEqual([]);
  }, 30_000);

  it('falls back to the documented 100 MB when discovery carries no cap, and when it is unreachable', async () => {
    const dir = await makeDeckWithDownloads();
    // 1.5 MB is under 100 MB: a discovery answer without limits lets it through.
    await truncate(join(dir, 'downloads', 'figures.csv'), Math.floor(1.5 * 1024 * 1024));
    const plain = routedHarness(
      pushRoutes({ missing: [], instance: { name: 'x', setupRequired: false } }).routes
    );
    expect(await run(PUSH(dir), plain.io)).toBe(0);
    // No discovery route at all (404 from the fake): the default still applies.
    // (The folder is linked now, so this and the next are later pushes.)
    const none = routedHarness(pushRoutes({ missing: [], existingDeck: true }).routes);
    expect(await run(PUSH(dir), none.io)).toBe(0);
    expect(none.err()).toBe('');
    // Over 100 MB (a sparse file): refused with the default cap named.
    await truncate(join(dir, 'downloads', 'figures.csv'), 100 * 1024 * 1024 + 1);
    const { routes, uploaded } = pushRoutes({
      missing: [],
      existingDeck: true,
      instance: { name: 'x', setupRequired: false }
    });
    const over = routedHarness(routes);
    expect(await run(PUSH(dir), over.io)).toBe(1);
    expect(over.err()).toContain('downloads/figures.csv is 100.0 MB, over');
    expect(over.err()).toContain('100.0 MB per-file cap');
    expect(uploaded).toEqual([]);
    expect(over.calls.filter((c) => c.path.includes('/uploads') || c.path.includes('/precheck'))).toEqual([]);
  });
});

describe('an unchanged attachment is never re-uploaded', () => {
  it('a second push uploads nothing when the precheck answers everything present', async () => {
    const dir = await makeDeckWithDownloads();
    const first = pushRoutes({ missing: [sha(HTML), sha(CSV), sha(PDF)] });
    const h1 = routedHarness(first.routes);
    expect(await run(PUSH(dir), h1.io)).toBe(0);
    expect(first.uploaded.sort()).toEqual([sha(HTML), sha(CSV), sha(PDF)].sort());
    expect(h1.out()).toContain('3 uploaded');

    const second = pushRoutes({ missing: [], existingDeck: true });
    const h2 = routedHarness(second.routes);
    expect(await run(PUSH(dir), h2.io)).toBe(0);
    expect(second.uploaded).toEqual([]);
    expect(h2.out()).toContain('0 uploaded');
  });

  it('iterating on the HTML re-uploads the HTML alone: the precheck names it, the attachments stay put', async () => {
    const dir = await makeDeckWithDownloads();
    await writeLink(dir, { presentationId: DECK.id, baseUrl: 'http://x' });
    await writeFile(join(dir, 'index.html'), '<html>deck v2</html>');
    const { routes, uploaded } = pushRoutes({ missing: [sha('<html>deck v2</html>')], existingDeck: true });
    const h = routedHarness(routes);
    expect(await run(PUSH(dir), h.io)).toBe(0);
    expect(uploaded).toEqual([sha('<html>deck v2</html>')]);
    expect(uploaded).not.toContain(sha(PDF));
    expect(uploaded).not.toContain(sha(CSV));
    const precheck = h.calls.find((c) => c.path.endsWith('/precheck'))!;
    expect((precheck.body as { sha256: string[] }).sha256.sort()).toEqual(
      [sha('<html>deck v2</html>'), sha(CSV), sha(PDF)].sort()
    );
    expect(h.out()).toContain('1 uploaded');
  });
});

describe('pull restores attachments', () => {
  const manifest = [
    { path: 'index.html', sha256: sha(HTML), sizeBytes: Buffer.byteLength(HTML), contentType: 'text/html' },
    {
      path: 'downloads/figures.csv',
      sha256: sha(CSV),
      sizeBytes: Buffer.byteLength(CSV),
      contentType: 'text/csv'
    },
    {
      path: 'downloads/sub/annex.pdf',
      sha256: sha(PDF),
      sizeBytes: PDF.length,
      contentType: 'application/pdf'
    }
  ];
  const blobs: Record<string, Buffer> = {
    [sha(HTML)]: Buffer.from(HTML),
    [sha(CSV)]: Buffer.from(CSV),
    [sha(PDF)]: PDF
  };
  const pullRoutes = (serve: Record<string, Buffer>): Route[] => [
    {
      method: 'GET',
      path: new RegExp(`/api/v1/presentations/${DECK.id}$`),
      reply: () => ({ body: { ...DECK, currentVersion: 3, hasDownloads: true } })
    },
    {
      method: 'GET',
      path: new RegExp(`/api/v1/presentations/${DECK.id}/versions/3$`),
      reply: () => ({
        body: { ...VERSION_ROW, version: 3, fileCount: 3, hasDownloads: true, manifest, attachments: [] }
      })
    },
    {
      method: 'GET',
      path: new RegExp(`/api/v1/presentations/${DECK.id}/assets/`),
      reply: ({ path }) => ({ raw: new Response(serve[path.split('/').pop()!], { status: 200 }) })
    }
  ];

  it('writes every attachment byte-exactly under downloads/, in place, and counts them', async () => {
    const h = routedHarness(pullRoutes(blobs));
    const dest = join(await mkdtemp(join(tmpdir(), 'slideless-pull-att-')), 'out');
    expect(await run(['pull', DECK.id, dest, '--url', 'http://x', '--api-key', 'slk_k_s'], h.io)).toBe(0);
    expect(h.err()).toBe('');
    expect(await readFile(join(dest, 'downloads', 'figures.csv'), 'utf8')).toBe(CSV);
    expect(await readFile(join(dest, 'downloads', 'sub', 'annex.pdf'))).toEqual(PDF);
    expect((await stat(join(dest, 'downloads', 'sub', 'annex.pdf'))).mode & 0o777).toBe(0o644);
    expect(await readLink(dest)).toEqual({ presentationId: DECK.id, baseUrl: 'http://x' });
    expect(h.out()).toContain('(3 files, 2 attachments)');
    // The scan of the pulled folder classifies them the same way push would.
    const scan = await scanDeck(dest);
    expect(scan.files.filter((f) => f.attachment).map((f) => f.path)).toEqual([
      'downloads/figures.csv',
      'downloads/sub/annex.pdf'
    ]);
  });

  it('refuses an attachment whose bytes do not hash to the manifest, and writes nothing for it', async () => {
    // Same length as the real annex, so the size cap passes and the hash is what refuses.
    const tampered = { ...blobs, [sha(PDF)]: Buffer.from('%PDF-1.4 ANNEX') };
    const h = routedHarness(pullRoutes(tampered));
    const dest = join(await mkdtemp(join(tmpdir(), 'slideless-pull-att-')), 'out');
    expect(await run(['pull', DECK.id, dest, '--url', 'http://x', '--api-key', 'slk_k_s'], h.io)).toBe(1);
    expect(h.err()).toContain('downloads/sub/annex.pdf');
    expect(h.err()).toContain('manifest claims');
    await expect(stat(join(dest, 'downloads', 'sub', 'annex.pdf'))).rejects.toThrow();
  });
});

describe('share --no-download and tokens', () => {
  const TOKEN = {
    id: '44444444-4444-4444-4444-444444444444',
    presentationId: DECK.id,
    name: 'cli',
    purpose: 'share',
    versionMode: 'latest',
    pinnedVersion: null,
    canAnnotate: false,
    canSubmitForms: true,
    canDownload: true,
    badgePosition: null,
    expiresAt: null,
    hasPassword: false,
    revokedAt: null,
    accessCount: 2,
    lastAccessedAt: null,
    downloadCount: 3,
    createdAt: '2026-01-01T00:00:00.000Z'
  };
  const createRoute = (canDownload: boolean): Route => ({
    method: 'POST',
    path: new RegExp(`/api/v1/presentations/${DECK.id}/tokens$`),
    reply: () => ({
      status: 201,
      body: { shareToken: { ...TOKEN, canDownload }, secret: 's3cret', url: 'http://x/v/s3cret/' }
    })
  });

  it('mints with canDownload true by default and false with --no-download', async () => {
    const h = routedHarness([createRoute(true)]);
    expect(await run(['share', DECK.id, '--url', 'http://x', '--api-key', 'slk_k_s'], h.io)).toBe(0);
    const body = h.calls.find((c) => c.path.endsWith('/tokens'))!.body as { canDownload: boolean };
    expect(body.canDownload).toBe(true);
    expect(h.out()).not.toContain('no downloads');

    const h2 = routedHarness([createRoute(false)]);
    expect(
      await run(['share', DECK.id, '--no-download', '--url', 'http://x', '--api-key', 'slk_k_s'], h2.io)
    ).toBe(0);
    const body2 = h2.calls.find((c) => c.path.endsWith('/tokens'))!.body as { canDownload: boolean };
    expect(body2.canDownload).toBe(false);
    expect(h2.out()).toContain(', no downloads)');
  });

  it('--json carries canDownload on the created token, byte-exact', async () => {
    const h = routedHarness([createRoute(false)]);
    expect(
      await run(
        ['share', DECK.id, '--no-download', '--json', '--url', 'http://x', '--api-key', 'slk_k_s'],
        h.io
      )
    ).toBe(0);
    expect((JSON.parse(h.out()) as { shareToken: { canDownload: boolean } }).shareToken.canDownload).toBe(
      false
    );
  });

  it('share-email takes --no-download too', async () => {
    const h = routedHarness([
      createRoute(false),
      {
        method: 'POST',
        path: new RegExp(`/api/v1/presentations/${DECK.id}/tokens/${TOKEN.id}/send$`),
        reply: () => ({ body: { emailSent: true, url: 'http://x/v/rotated/' } })
      }
    ]);
    expect(
      await run(
        [
          'share-email',
          DECK.id,
          '--to',
          'a@x.co',
          '--no-download',
          '--url',
          'http://x',
          '--api-key',
          'slk_k_s'
        ],
        h.io
      )
    ).toBe(0);
    const body = h.calls.find((c) => c.path.endsWith('/tokens'))!.body as { canDownload: boolean };
    expect(body.canDownload).toBe(false);
  });

  it('tokens shows the download count, or "no downloads" when the switch is off', async () => {
    const h = routedHarness([
      {
        method: 'GET',
        path: new RegExp(`/api/v1/presentations/${DECK.id}/tokens`),
        reply: () => ({
          body: {
            shareTokens: [
              TOKEN,
              {
                ...TOKEN,
                id: '55555555-5555-5555-5555-555555555555',
                name: 'quiet',
                canDownload: false,
                downloadCount: 0
              },
              { ...TOKEN, id: '66666666-6666-6666-6666-666666666666', name: 'one', downloadCount: 1 }
            ],
            nextCursor: null
          }
        })
      }
    ]);
    expect(await run(['tokens', DECK.id, '--url', 'http://x', '--api-key', 'slk_k_s'], h.io)).toBe(0);
    const lines = h.out().split('\n');
    expect(lines[0]).toMatch(/cli\s+2 opens\s+never\s+latest\s+3 downloads\s+-/);
    expect(lines[1]).toMatch(/quiet\s+2 opens\s+never\s+latest\s+no downloads\s+-/);
    expect(lines[2]).toMatch(/one\s+2 opens\s+never\s+latest\s+1 download\s+-/);
  });
});
