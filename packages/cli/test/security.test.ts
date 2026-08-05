import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { run } from '../src/index.js';
import { parseIgnoreFile, scanDeck, writeLink } from '../src/manifest.js';
import { sanitizeForTty } from '../src/context.js';
import { safeDownloadName } from '../src/commands/files.js';
import { DECK, routedHarness, VERSION_ROW, type Route } from './harness.js';

/**
 * PRDCT-1353 — the CLI/SDK hardening. Every case here is a proven path from
 * a hostile (or merely compromised) instance to the developer's machine:
 * arbitrary file write through `pull` and `files download`, the dev server
 * reading the whole filesystem, a ReDoS in the ignore matcher, and terminal
 * control sequences reaching the owner's terminal from a share recipient.
 */

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

const KEY = ['--url', 'http://x', '--api-key', 'slk_k_s'];

interface Blob {
  path: string;
  bytes: Buffer;
  /** Overrides the manifest's declared size (a lying instance). */
  declaredSize?: number;
  /** Overrides the manifest's declared hash (a swapped blob). */
  declaredSha?: string;
}

function pullRoutes(blobs: Blob[]): Route[] {
  const manifest = blobs.map((b) => ({
    path: b.path,
    sha256: b.declaredSha ?? sha(b.bytes),
    sizeBytes: b.declaredSize ?? b.bytes.length,
    contentType: 'text/plain'
  }));
  const byHash = new Map(manifest.map((m, i) => [m.sha256, blobs[i]!.bytes]));
  return [
    {
      method: 'GET',
      path: new RegExp(`/api/v1/presentations/${DECK.id}$`),
      reply: () => ({ body: { ...DECK, currentVersion: 1 } })
    },
    {
      method: 'GET',
      path: new RegExp(`/api/v1/presentations/${DECK.id}/versions/1$`),
      reply: () => ({ body: { ...VERSION_ROW, fileCount: manifest.length, manifest } })
    },
    {
      method: 'GET',
      path: new RegExp(`/api/v1/presentations/${DECK.id}/assets/`),
      reply: ({ path }) => ({
        raw: new Response(byHash.get(path.split('/').pop()!) ?? Buffer.alloc(0), { status: 200 })
      })
    }
  ];
}

async function emptyDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

// ── CLI-1: a hostile manifest cannot land anywhere it should not ─────────────

describe('pull refuses a crafted manifest', () => {
  it.each([['../escaped.txt'], ['.git/hooks/pre-commit'], ['package.json'], ['.env']])(
    'refuses %s and writes nothing',
    async (path) => {
      const h = routedHarness(pullRoutes([{ path, bytes: Buffer.from('pwned') }]));
      const root = await emptyDir('slideless-sec-');
      const dest = join(root, 'deck');
      const code = await run(['pull', DECK.id, dest, ...KEY], h.io);
      expect(code).toBe(1);
      expect(h.err()).toMatch(/unsafe manifest path/);
      // Nothing was created outside — and the destination stays empty.
      await expect(stat(join(root, 'escaped.txt'))).rejects.toThrow();
      await expect(readdir(dest)).resolves.toEqual([]);
    }
  );

  it('refuses to write THROUGH a symlink that already sits in the destination', async () => {
    const root = await emptyDir('slideless-sec-');
    const dest = join(root, 'deck');
    const victim = join(root, 'victim.txt');
    await mkdir(dest, { recursive: true });
    await writeFile(victim, 'original');
    await symlink(victim, join(dest, 'index.html'));

    const h = routedHarness(pullRoutes([{ path: 'index.html', bytes: Buffer.from('pwned') }]));
    const code = await run(['pull', DECK.id, dest, ...KEY], h.io);
    expect(code).toBe(1);
    expect(h.err()).toMatch(/symlink/);
    expect(await readFile(victim, 'utf8')).toBe('original');
    // The link itself is intact — refused, not silently replaced.
    expect(await readlink(join(dest, 'index.html'))).toBe(victim);
  });

  it('refuses to write through a symlinked SUB-DIRECTORY', async () => {
    const root = await emptyDir('slideless-sec-');
    const dest = join(root, 'deck');
    const outside = join(root, 'outside');
    await mkdir(dest, { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(dest, 'assets'));

    const h = routedHarness(pullRoutes([{ path: 'assets/app.js', bytes: Buffer.from('pwned') }]));
    const code = await run(['pull', DECK.id, dest, ...KEY], h.io);
    expect(code).toBe(1);
    expect(h.err()).toMatch(/symlinked directory/);
    await expect(stat(join(outside, 'app.js'))).rejects.toThrow();
  });

  it('never leaves a pulled file executable, even over an executable one', async () => {
    const root = await emptyDir('slideless-sec-');
    const dest = join(root, 'deck');
    await mkdir(dest, { recursive: true });
    await writeFile(join(dest, 'index.html'), 'old');
    await chmod(join(dest, 'index.html'), 0o755);

    const h = routedHarness(pullRoutes([{ path: 'index.html', bytes: Buffer.from('new') }]));
    const code = await run(['pull', DECK.id, dest, ...KEY], h.io);
    expect(h.err()).toBe('');
    expect(code).toBe(0);
    const mode = (await stat(join(dest, 'index.html'))).mode & 0o777;
    expect(mode & 0o111).toBe(0);
  });
});

// ── CLI-9 / CLI-8: the bytes must match the manifest, and be capped ──────────

describe('pull verifies what it downloads', () => {
  it('refuses a blob whose bytes do not hash to the manifest entry', async () => {
    const bytes = Buffer.from('substituted payload');
    const h = routedHarness(
      pullRoutes([{ path: 'index.html', bytes, declaredSha: sha(Buffer.from('the real thing')) }])
    );
    const dest = join(await emptyDir('slideless-sec-'), 'deck');
    const code = await run(['pull', DECK.id, dest, ...KEY], h.io);
    expect(code).toBe(1);
    expect(h.err()).toMatch(/hash to/);
    await expect(stat(join(dest, 'index.html'))).rejects.toThrow();
  });

  it('refuses a blob bigger than the size the manifest declared', async () => {
    const bytes = Buffer.alloc(64 * 1024, 0x41);
    const h = routedHarness(pullRoutes([{ path: 'index.html', bytes, declaredSize: 10 }]));
    const dest = join(await emptyDir('slideless-sec-'), 'deck');
    const code = await run(['pull', DECK.id, dest, ...KEY], h.io);
    expect(code).toBe(1);
    expect(h.err()).toMatch(/exceeds the manifest/);
    await expect(stat(join(dest, 'index.html'))).rejects.toThrow();
  });

  it('still round-trips an honest deck byte-exactly', async () => {
    const bytes = Buffer.from('<html>ok</html>');
    const h = routedHarness(pullRoutes([{ path: 'index.html', bytes }]));
    const dest = join(await emptyDir('slideless-sec-'), 'deck');
    expect(await run(['pull', DECK.id, dest, ...KEY], h.io)).toBe(0);
    expect(await readFile(join(dest, 'index.html'))).toEqual(bytes);
  });
});

// ── CLI-13: pull inherits push's instance-mismatch refusal ───────────────────

describe('pull and the link file', () => {
  it('refuses a destination linked to a different instance', async () => {
    const dest = await emptyDir('slideless-sec-');
    await writeLink(dest, { presentationId: DECK.id, baseUrl: 'http://other' });
    const h = routedHarness(pullRoutes([{ path: 'index.html', bytes: Buffer.from('x') }]));
    const code = await run(['pull', DECK.id, dest, ...KEY], h.io);
    expect(code).toBe(1);
    expect(h.err()).toContain('http://other');
    expect(h.calls).toHaveLength(0);
  });
});

// ── CLI-3: `files download` cannot be steered by the stored name ─────────────

describe('files download', () => {
  const FILE_ID = '44444444-4444-4444-4444-444444444444';

  function fileRoutes(originalName: string): Route[] {
    return [
      {
        method: 'GET',
        path: new RegExp(`/api/v1/files/${FILE_ID}$`),
        reply: () => ({
          body: {
            id: FILE_ID,
            sha256: sha('payload'),
            sizeBytes: 7,
            contentType: 'text/plain',
            originalName,
            createdBy: 'u1',
            createdAt: '2026-01-01T00:00:00.000Z'
          }
        })
      },
      {
        method: 'GET',
        path: new RegExp(`/api/v1/files/${FILE_ID}/content$`),
        reply: () => ({ raw: new Response(Buffer.from('payload'), { status: 200 }) })
      }
    ];
  }

  it('writes the BASENAME of a traversing stored name inside --dir', async () => {
    const root = await emptyDir('slideless-sec-');
    const dir = join(root, 'downloads');
    const h = routedHarness(fileRoutes('../../pwned.txt'));
    const code = await run(['files', 'download', FILE_ID, '--dir', dir, ...KEY], h.io);
    expect(h.err()).toBe('');
    expect(code).toBe(0);
    expect(await readFile(join(dir, 'pwned.txt'), 'utf8')).toBe('payload');
    await expect(stat(join(root, 'pwned.txt'))).rejects.toThrow();
  });

  it('refuses an absolute stored name rather than writing to it', async () => {
    const dir = await emptyDir('slideless-sec-');
    const h = routedHarness(fileRoutes('/etc/cron.d/backdoor'));
    const code = await run(['files', 'download', FILE_ID, '--dir', dir, ...KEY], h.io);
    // The basename survives; it lands inside the chosen directory.
    expect(code).toBe(0);
    expect(await readFile(join(dir, 'backdoor'), 'utf8')).toBe('payload');
  });

  it('refuses a dotfile stored name and points at --out', async () => {
    const dir = await emptyDir('slideless-sec-');
    const h = routedHarness(fileRoutes('.bashrc'));
    const code = await run(['files', 'download', FILE_ID, '--dir', dir, ...KEY], h.io);
    expect(code).toBe(1);
    expect(h.err()).toMatch(/--out/);
    await expect(stat(join(dir, '.bashrc'))).rejects.toThrow();
  });

  it('refuses to write through a symlink planted at the derived name', async () => {
    const root = await emptyDir('slideless-sec-');
    const dir = join(root, 'downloads');
    await mkdir(dir, { recursive: true });
    const victim = join(root, 'victim.txt');
    await writeFile(victim, 'original');
    await symlink(victim, join(dir, 'report.txt'));
    const h = routedHarness(fileRoutes('report.txt'));
    const code = await run(['files', 'download', FILE_ID, '--dir', dir, ...KEY], h.io);
    expect(code).toBe(1);
    expect(await readFile(victim, 'utf8')).toBe('original');
  });

  it('safeDownloadName strips both separator flavours', () => {
    expect(safeDownloadName('a/b/c.txt')).toBe('c.txt');
    expect(safeDownloadName('..\\..\\windows.txt')).toBe('windows.txt');
    expect(safeDownloadName('plain.txt')).toBe('plain.txt');
    expect(() => safeDownloadName('..')).toThrow(/--out/);
    expect(() => safeDownloadName('.npmrc')).toThrow(/--out/);
  });
});

// ── CLI-6: the ignore matcher is no longer a ReDoS ───────────────────────────

describe('.slidelessignore matcher', () => {
  it('compiles and matches the catastrophic pattern in well under 100 ms', () => {
    const pattern = `${'**/'.repeat(50)}x`;
    const subject = `${'a/'.repeat(60)}bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`;
    const started = performance.now();
    const rules = parseIgnoreFile(pattern);
    for (const rule of rules) rule.regex.test(subject);
    expect(performance.now() - started).toBeLessThan(100);
  });

  it('keeps the collapsed pattern semantically correct', () => {
    const rules = parseIgnoreFile('**/**/build.log\n');
    expect(rules[0]!.regex.test('a/b/build.log')).toBe(true);
    expect(rules[0]!.regex.test('build.log')).toBe(true);
    expect(rules[0]!.regex.test('build.txt')).toBe(false);
  });

  it('refuses a pattern that is too long or too wildcard-heavy', () => {
    expect(() => parseIgnoreFile(`${'a'.repeat(300)}\n`)).toThrow(/longer than/);
    expect(() => parseIgnoreFile(`${'**a/'.repeat(20)}z\n`)).toThrow(/wildcards/);
  });
});

// ── CLI-1 (push side): the scanner cannot produce a refused manifest ─────────

describe('deck scanning honours the manifest-path contract', () => {
  it('skips dotfiles, .git and package.json', async () => {
    const dir = await emptyDir('slideless-scan-');
    await writeFile(join(dir, 'index.html'), '<html></html>');
    await writeFile(join(dir, '.env'), 'SECRET=1');
    await writeFile(join(dir, 'package.json'), '{}');
    await mkdir(join(dir, '.git', 'hooks'), { recursive: true });
    await writeFile(join(dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh');
    const scan = await scanDeck(dir);
    expect(scan.files.map((f) => f.path)).toEqual(['index.html']);
  });

  it('refuses a single-file push of a dotfile', async () => {
    const dir = await emptyDir('slideless-scan-');
    await writeFile(join(dir, '.env'), 'SECRET=1');
    await expect(scanDeck(join(dir, '.env'))).rejects.toThrow(/Refusing to push/);
  });
});

// ── CLI-5: terminal control sequences never reach the terminal ───────────────

describe('terminal-control sanitation', () => {
  it('strips CSI, OSC and C1 while keeping tabs, newlines and CR', () => {
    const ESC = '\u001b';
    expect(sanitizeForTty(`${ESC}[31mred${ESC}[0m`)).toBe('red');
    expect(sanitizeForTty(`${ESC}]8;;https://evil.example${ESC}\\click${ESC}]8;;${ESC}\\`)).toBe('click');
    expect(sanitizeForTty(`${ESC}]52;c;cGF5bG9hZA==\u0007`)).toBe('');
    // 8-bit C1: 0x9b IS a CSI introducer on its own.
    expect(sanitizeForTty('a\u009b31mBb')).toBe('a31mBb');
    expect(sanitizeForTty('a\tb\r\nc\n')).toBe('a\tb\r\nc\n');
    expect(sanitizeForTty('plain')).toBe('plain');
  });

  it('prints a control-character annotation body inert', async () => {
    const ESC = '\u001b';
    const body = `${ESC}[2K${ESC}[1AAll good ${ESC}]8;;https://evil.example${ESC}\\click here${ESC}]8;;${ESC}\\`;
    const routes: Route[] = [
      {
        method: 'GET',
        path: new RegExp(`/api/v1/presentations/${DECK.id}/annotations`),
        reply: () => ({
          body: {
            annotations: [
              {
                id: 'an1',
                presentationId: DECK.id,
                version: 1,
                status: 'open',
                authorName: `Mallory${ESC}[31m`,
                authorUserId: null,
                body,
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z'
              }
            ],
            nextCursor: null
          }
        })
      }
    ];
    const h = routedHarness(routes);
    expect(await run(['pull-annotations', DECK.id, ...KEY], h.io)).toBe(0);
    const printed = h.out();
    // No ESC, no C1 introducer, no bare control byte survived.
    // eslint-disable-next-line no-control-regex -- asserting on control bytes.
    expect(printed).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/);
    expect(printed).toContain('All good');
    expect(printed).toContain('click here');
  });

  it('leaves --json output byte-exact', async () => {
    const h = routedHarness([
      {
        method: 'GET',
        path: new RegExp(`/api/v1/presentations/${DECK.id}/annotations`),
        reply: () => ({
          body: {
            annotations: [
              {
                id: 'an1',
                presentationId: DECK.id,
                version: 1,
                status: 'open',
                authorName: null,
                authorUserId: null,
                body: 'éé ok',
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z'
              }
            ],
            nextCursor: null
          }
        })
      }
    ]);
    expect(await run(['pull-annotations', DECK.id, '--json', ...KEY], h.io)).toBe(0);
    const parsed = JSON.parse(h.out()) as { annotations: Array<{ body: string }> };
    expect(parsed.annotations[0]!.body).toBe('éé ok');
  });
});

// ── CLI-11: the CSV formula guard sees past leading whitespace ───────────────

describe('responses --csv formula guard', () => {
  const FORM_ROW = (value: string) => ({
    id: 'r1',
    presentationId: DECK.id,
    formName: 'contact',
    shareTokenId: null,
    shareTokenName: null,
    source: 'link',
    placement: null,
    payload: { note: value },
    createdAt: '2026-01-01T00:00:00.000Z'
  });

  async function csvFor(value: string): Promise<string> {
    const h = routedHarness([
      {
        method: 'GET',
        path: new RegExp(`/api/v1/presentations/${DECK.id}/responses$`),
        reply: () => ({ body: { responses: [FORM_ROW(value)], nextCursor: null } })
      }
    ]);
    const code = await run(['responses', DECK.id, '--csv', '--form', 'contact', ...KEY], h.io);
    expect(code).toBe(0);
    return h.out();
  }

  it('guards a formula hidden behind leading whitespace', async () => {
    const csv = await csvFor(" =cmd|' /c calc'!A1");
    expect(csv).toMatch(/,' =cmd/);
  });

  it('guards a tab-prefixed formula', async () => {
    // The tab survives the tty filter, so the guard must see past it.
    const csv = await csvFor('\t@SUM(1+1)');
    expect(csv).toMatch(/,'\t@SUM/);
  });

  it('leaves an ordinary value alone', async () => {
    const csv = await csvFor('hello');
    expect(csv).toContain('hello');
    expect(csv).not.toContain("'hello");
  });
});

// ── CLI-12: secrets no longer have to travel in argv ─────────────────────────

describe('secrets off the command line', () => {
  const SHARE_ROUTES: Route[] = [
    {
      method: 'POST',
      path: new RegExp(`/api/v1/presentations/${DECK.id}/tokens$`),
      reply: () => ({
        status: 201,
        body: {
          shareToken: {
            id: 't1',
            presentationId: DECK.id,
            name: 'cli',
            versionMode: 'latest',
            pinnedVersion: null,
            canAnnotate: false,
            canSubmitForms: true,
            hasPassword: true,
            accessCount: 0,
            lastAccessedAt: null,
            expiresAt: null,
            revokedAt: null,
            createdAt: '2026-01-01T00:00:00.000Z'
          },
          url: 'http://x/v/secret/'
        }
      })
    }
  ];

  it('--api-key-stdin authenticates without the key ever entering argv', async () => {
    const h = routedHarness([
      { method: 'GET', path: /\/api\/v1\/files$/, reply: () => ({ body: { files: [], nextCursor: null } }) }
    ]);
    h.io.readStdin = async () => 'slk_from_stdin\n';
    const code = await run(['files', 'list', '--url', 'http://x', '--api-key-stdin'], h.io);
    expect(h.err()).toBe('');
    expect(code).toBe(0);
    expect(h.wire[0]!.auth).toBe('Bearer slk_from_stdin');
  });

  it('share --password-stdin sends the piped password', async () => {
    const h = routedHarness(SHARE_ROUTES);
    h.io.readStdin = async () => 'correct horse\n';
    const code = await run(['share', DECK.id, '--password-stdin', ...KEY], h.io);
    expect(h.err()).toBe('');
    expect(code).toBe(0);
    expect((h.calls[0]!.body as { password?: string }).password).toBe('correct horse');
  });

  it('share reads SLIDELESS_SHARE_PASSWORD when no flag is given', async () => {
    const h = routedHarness(SHARE_ROUTES, { SLIDELESS_SHARE_PASSWORD: 'from-env' });
    const code = await run(['share', DECK.id, ...KEY], h.io);
    expect(code).toBe(0);
    expect((h.calls[0]!.body as { password?: string }).password).toBe('from-env');
  });

  it('refuses --password together with --password-stdin', async () => {
    const h = routedHarness(SHARE_ROUTES);
    h.io.readStdin = async () => 'x\n';
    const code = await run(['share', DECK.id, '--password', 'a', '--password-stdin', ...KEY], h.io);
    expect(code).toBe(1);
    expect(h.err()).toMatch(/not both/);
  });

  it('refuses to spend stdin twice in one invocation', async () => {
    const h = routedHarness(SHARE_ROUTES);
    h.io.readStdin = async () => 'slk_from_stdin\n';
    const code = await run(
      ['share', DECK.id, '--password-stdin', '--api-key-stdin', '--url', 'http://x'],
      h.io
    );
    expect(code).toBe(1);
    expect(h.err()).toMatch(/already claimed/);
  });
});
