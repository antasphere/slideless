import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  blobPath,
  defaultLocalStore,
  listLocalVersions,
  openLocalStore,
  readLocalVersion,
  snapshot
} from '../src/localversions.js';
import { run } from '../src/index.js';
import { routedHarness } from './harness.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

let deck: string;
let store: string;

beforeEach(async () => {
  deck = await realpath(await mkdtemp(join(tmpdir(), 'slideless-local-deck-')));
  store = await realpath(await mkdtemp(join(tmpdir(), 'slideless-local-store-')));
  await writeFile(join(deck, 'index.html'), '<h1>one</h1>');
  await mkdir(join(deck, 'img'));
  await writeFile(join(deck, 'img', 'a.svg'), '<svg/>');
});

describe('local versions: snapshot', () => {
  it('records the folder as version 1, in the server version shape, its files as blobs', async () => {
    const at = new Date('2026-11-09T22:00:00.000Z');
    const result = await snapshot(deck, { store, now: () => at });
    expect(result).toEqual({
      version: 1,
      created: true,
      entryPath: 'index.html',
      fileCount: 2,
      sizeBytes: 12 + 6,
      root: deck,
      store
    });
    const record = await readLocalVersion(store, deck, 1);
    expect(record).toEqual({
      v: 1,
      version: 1,
      root: deck,
      entryPath: 'index.html',
      createdAt: '2026-11-09T22:00:00.000Z',
      fileCount: 2,
      sizeBytes: 18,
      manifest: [
        { path: 'img/a.svg', sha256: sha('<svg/>'), sizeBytes: 6, contentType: 'image/svg+xml' },
        { path: 'index.html', sha256: sha('<h1>one</h1>'), sizeBytes: 12, contentType: 'text/html' }
      ]
    });
    expect(await readFile(blobPath(store, sha('<h1>one</h1>')), 'utf8')).toBe('<h1>one</h1>');
    expect(await readFile(blobPath(store, sha('<svg/>')), 'utf8')).toBe('<svg/>');
  });

  it('writes nothing when the folder has not changed since the latest version', async () => {
    await snapshot(deck, { store });
    const again = await snapshot(deck, { store });
    expect(again).toMatchObject({ version: 1, created: false });
    expect((await listLocalVersions(store, deck)).map((v) => v.version)).toEqual([1]);
  });

  it('records a change as the next version and leaves the earlier one as it was', async () => {
    await snapshot(deck, { store });
    await writeFile(join(deck, 'index.html'), '<h1>two</h1>');
    const second = await snapshot(deck, { store });
    expect(second).toMatchObject({ version: 2, created: true });
    expect((await readLocalVersion(store, deck, 1))!.manifest[1]!.sha256).toBe(sha('<h1>one</h1>'));
    expect((await readLocalVersion(store, deck, 2))!.manifest[1]!.sha256).toBe(sha('<h1>two</h1>'));
    // Unchanged content is stored once.
    expect(await readdir(join(store, 'blobs', sha('<svg/>').slice(0, 2)))).toEqual([sha('<svg/>')]);
  });

  it('counts a removed file and a changed entry as changes', async () => {
    await snapshot(deck, { store });
    await writeFile(join(deck, 'other.html'), '<p>other</p>');
    expect(await snapshot(deck, { store })).toMatchObject({ version: 2, created: true });
    expect(await snapshot(deck, { store, entry: 'other.html' })).toMatchObject({
      version: 3,
      created: true,
      entryPath: 'other.html'
    });
  });

  it('applies the push rules: no dot-prefixed file, the ignore file honoured', async () => {
    await writeFile(join(deck, '.env'), 'SECRET=1');
    await mkdir(join(deck, '.git'));
    await writeFile(join(deck, '.git', 'HEAD'), 'ref');
    await writeFile(join(deck, '.slidelessignore'), 'draft.md\n');
    await writeFile(join(deck, 'draft.md'), 'notes');
    await snapshot(deck, { store });
    const paths = (await readLocalVersion(store, deck, 1))!.manifest.map((f) => f.path);
    expect(paths).toEqual(['img/a.svg', 'index.html']);
  });

  it('answers ONE version to many snapshots of the same state taken at once', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => snapshot(deck, { store })));
    expect(results.map((r) => r.version)).toEqual(Array(8).fill(1));
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect((await listLocalVersions(store, deck)).map((v) => v.version)).toEqual([1]);
    // No temporary file is left beside the records.
    const dir = join(store, 'folders', sha(deck).slice(0, 24), 'versions');
    expect(await readdir(dir)).toEqual(['1.json']);
  });

  it('never overwrites a version: a number already taken goes to the next one', async () => {
    await snapshot(deck, { store });
    const dir = join(store, 'folders', sha(deck).slice(0, 24), 'versions');
    // A record that cannot be read is skipped in listings and never overwritten.
    await writeFile(join(dir, '2.json'), 'not json');
    await writeFile(join(deck, 'index.html'), '<h1>three</h1>');
    expect(await snapshot(deck, { store })).toMatchObject({ version: 3, created: true });
    expect(await readFile(join(dir, '2.json'), 'utf8')).toBe('not json');
    expect((await listLocalVersions(store, deck)).map((v) => v.version)).toEqual([1, 3]);
  });

  it('keeps the versions of two folders apart in one store', async () => {
    const other = await realpath(await mkdtemp(join(tmpdir(), 'slideless-local-other-')));
    await writeFile(join(other, 'index.html'), '<h1>other</h1>');
    await snapshot(deck, { store });
    await snapshot(other, { store });
    expect((await listLocalVersions(store, deck)).map((v) => v.root)).toEqual([deck]);
    expect((await listLocalVersions(store, other)).map((v) => v.root)).toEqual([other]);
  });

  it('says "Nothing to snapshot" for an empty folder and refuses a folder with no entry', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'slideless-local-empty-'));
    await expect(snapshot(empty, { store })).rejects.toThrow(/^Nothing to snapshot/);
    const noHtml = await mkdtemp(join(tmpdir(), 'slideless-local-nohtml-'));
    await writeFile(join(noHtml, 'a.css'), 'x');
    await expect(snapshot(noHtml, { store })).rejects.toThrow(/No HTML entry/);
  });
});

describe('local versions: the store', () => {
  it('refuses a store inside the folder, unless under a dot-prefixed directory', async () => {
    await expect(openLocalStore(deck, join(deck, 'versions'))).rejects.toThrow(/inside the folder/);
    await expect(openLocalStore(deck, deck)).rejects.toThrow(/inside the folder/);
    const hidden = await openLocalStore(deck, join(deck, '.slideless', 'versions'));
    expect(hidden.store).toBe(join(deck, '.slideless', 'versions'));
    // And a store kept there never shows up in a version.
    await snapshot(deck, { store: hidden.store });
    expect((await readLocalVersion(hidden.store, deck, 1))!.manifest.map((f) => f.path)).toEqual([
      'img/a.svg',
      'index.html'
    ]);
  });

  it('takes the environment first, then the user data folder', () => {
    expect(defaultLocalStore({ SLIDELESS_LOCAL_STORE: '/tmp/x-store' })).toBe('/tmp/x-store');
    if (process.platform !== 'win32') {
      expect(defaultLocalStore({ XDG_DATA_HOME: '/data' })).toBe('/data/antasphere/slideless/local');
      expect(defaultLocalStore({})).toMatch(/\.local\/share\/antasphere\/slideless\/local$/);
    }
  });

  it('refuses a malformed blob address', () => {
    expect(() => blobPath(store, '../../etc/passwd')).toThrow(/Not a sha256/);
  });
});

describe('local versions: round 1 fixes and gaps', () => {
  it('refuses a store inside a folder that itself sits under a dot-prefixed directory', async () => {
    const ws = await realpath(await mkdtemp(join(tmpdir(), 'slideless-local-ws-')));
    const nested = join(ws, '.workspace', 'deck');
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, 'index.html'), '<p>x</p>');
    await expect(openLocalStore(nested, join(nested, 'versions'))).rejects.toThrow(/inside the folder/);
  });

  it('creates nothing when it refuses a store', async () => {
    await expect(openLocalStore(deck, join(deck, 'versions', 'deeper'))).rejects.toThrow(/inside the folder/);
    expect(await readdir(deck)).toEqual(['img', 'index.html']);
  });

  it('says a missing folder plainly', async () => {
    await expect(snapshot(join(deck, 'nope'), { store })).rejects.toThrow(/^No such file or directory: /);
  });

  it('repairs a stored file that was cut short', async () => {
    await snapshot(deck, { store });
    const blob = blobPath(store, sha('<h1>one</h1>'));
    await writeFile(blob, '<h1>');
    await writeFile(join(deck, 'img', 'a.svg'), '<svg id="2"/>');
    await snapshot(deck, { store });
    expect(await readFile(blob, 'utf8')).toBe('<h1>one</h1>');
  });

  it('skips a record whose number does not match its file name', async () => {
    await snapshot(deck, { store });
    const dir = join(store, 'folders', sha(deck).slice(0, 24), 'versions');
    const one = await readFile(join(dir, '1.json'), 'utf8');
    await writeFile(join(dir, '2.json'), one);
    expect((await listLocalVersions(store, deck)).map((v) => v.version)).toEqual([1]);
    expect(await readLocalVersion(store, deck, 2)).toBeNull();
  });
});

describe('slideless snapshot / snapshots', () => {
  it('saves and lists local versions, in human and JSON form', async () => {
    const h = routedHarness([]);
    expect(await run(['snapshot', deck, '--store', store], h.io)).toBe(0);
    expect(h.out()).toMatch(/Saved .* as local version 1 \(2 files, 18 B\)/);

    const j = routedHarness([]);
    expect(await run(['snapshot', deck, '--store', store, '--json'], j.io)).toBe(0);
    expect(JSON.parse(j.out())).toMatchObject({ version: 1, created: false });

    const l = routedHarness([]);
    expect(await run(['snapshots', deck, '--store', store, '--json'], l.io)).toBe(0);
    const listed = JSON.parse(l.out()) as { versions: Array<{ version: number }> };
    expect(listed.versions.map((v) => v.version)).toEqual([1]);
  });

  it('says how to start when a folder has no version yet, and creates no store to say it', async () => {
    const h = routedHarness([]);
    const fresh = join(store, 'not-yet');
    expect(await run(['snapshots', deck, '--store', fresh], h.io)).toBe(0);
    expect(h.out()).toContain('No local versions');
    expect(await readdir(store)).not.toContain('not-yet');
  });
});
