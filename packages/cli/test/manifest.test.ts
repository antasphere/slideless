import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  contentTypeFor,
  detectEntry,
  isIgnored,
  parseIgnoreFile,
  readLink,
  scanDeck,
  writeLink
} from '../src/manifest.js';

async function makeDeck(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'slideless-deck-'));
  await writeFile(join(dir, 'index.html'), '<html><body>hi</body></html>');
  await mkdir(join(dir, 'assets'), { recursive: true });
  await writeFile(join(dir, 'assets', 'style.css'), 'body{}');
  await writeFile(join(dir, 'assets', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
  return dir;
}

describe('deck scanning', () => {
  it('walks a folder recursively with sha256 + size + content type', async () => {
    const dir = await makeDeck();
    const scan = await scanDeck(dir);
    expect(scan.rootDir).toBe(dir);
    expect(scan.files.map((f) => f.path)).toEqual(['assets/logo.png', 'assets/style.css', 'index.html']);
    const entry = scan.files.find((f) => f.path === 'index.html')!;
    expect(entry.contentType).toBe('text/html');
    expect(entry.sha256).toBe(createHash('sha256').update('<html><body>hi</body></html>').digest('hex'));
    expect(scan.files.find((f) => f.path === 'assets/logo.png')!.contentType).toBe('image/png');
  });

  it('accepts a single HTML file (root = its directory)', async () => {
    const dir = await makeDeck();
    const scan = await scanDeck(join(dir, 'index.html'));
    expect(scan.rootDir).toBe(dir);
    expect(scan.files.map((f) => f.path)).toEqual(['index.html']);
  });

  it('honors .slidelessignore and the built-in ignores', async () => {
    const dir = await makeDeck();
    await mkdir(join(dir, 'node_modules', 'x'), { recursive: true });
    await writeFile(join(dir, 'node_modules', 'x', 'y.js'), 'ignored');
    await writeFile(join(dir, '.DS_Store'), 'junk');
    await writeFile(join(dir, 'notes.draft.md'), 'draft');
    await mkdir(join(dir, 'tmp'), { recursive: true });
    await writeFile(join(dir, 'tmp', 'scratch.txt'), 'scratch');
    await writeFile(join(dir, '.slidelessignore'), '# junk\n*.draft.md\ntmp/\n');
    await writeLink(dir, { presentationId: 'x', baseUrl: 'http://x' });
    const scan = await scanDeck(dir);
    expect(scan.files.map((f) => f.path)).toEqual(['assets/logo.png', 'assets/style.css', 'index.html']);
  });

  it('ignore rules: anchored, basename, dir-only, ** globs', () => {
    const rules = parseIgnoreFile('build/\n/secret.txt\n**/*.log\ndraft*\n');
    expect(isIgnored('build', true, rules)).toBe(true);
    expect(isIgnored('build', false, rules)).toBe(false); // dir-only
    expect(isIgnored('secret.txt', false, rules)).toBe(true);
    expect(isIgnored('deep/secret.txt', false, rules)).toBe(false); // anchored
    expect(isIgnored('a/b/c.log', false, rules)).toBe(true);
    expect(isIgnored('draft-1.html', false, rules)).toBe(true);
    expect(isIgnored('sub/draft-2.html', false, rules)).toBe(true); // basename match
  });

  it('detectEntry: explicit → index.html → the single html → error', async () => {
    const dir = await makeDeck();
    const scan = await scanDeck(dir);
    expect(detectEntry(scan)).toBe('index.html');
    expect(detectEntry(scan, 'assets/style.css')).toBe('assets/style.css');
    expect(() => detectEntry(scan, 'missing.html')).toThrow(/not among/);

    const single = await mkdtemp(join(tmpdir(), 'slideless-single-'));
    await writeFile(join(single, 'deck.html'), '<html></html>');
    expect(detectEntry(await scanDeck(single))).toBe('deck.html');

    const many = await mkdtemp(join(tmpdir(), 'slideless-many-'));
    await writeFile(join(many, 'a.html'), 'a');
    await writeFile(join(many, 'b.html'), 'b');
    const manyScan = await scanDeck(many);
    expect(() => detectEntry(manyScan)).toThrow(/--entry/);

    const none = await mkdtemp(join(tmpdir(), 'slideless-none-'));
    await writeFile(join(none, 'style.css'), 'x');
    const noneScan = await scanDeck(none);
    expect(() => detectEntry(noneScan)).toThrow(/HTML entry/);
  });

  it('link file round-trips and tolerates absence/corruption', async () => {
    const dir = await makeDeck();
    expect(await readLink(dir)).toBeNull();
    await writeLink(dir, { presentationId: 'abc', baseUrl: 'http://localhost:3100' });
    expect(await readLink(dir)).toEqual({ presentationId: 'abc', baseUrl: 'http://localhost:3100' });
    await writeFile(join(dir, '.slideless.json'), '{broken');
    expect(await readLink(dir)).toBeNull();
  });

  it('content types default to octet-stream', () => {
    expect(contentTypeFor('x.woff2')).toBe('font/woff2');
    expect(contentTypeFor('x.unknownext')).toBe('application/octet-stream');
  });
});
