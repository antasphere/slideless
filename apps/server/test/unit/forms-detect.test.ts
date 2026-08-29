import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { ManifestEntry } from '@slideless/contract';
import { entryKind, manifestHasForms } from '../../src/forms/detect.js';
import type { StorageDriver } from '../../src/storage/driver.js';

/**
 * PRDCT-1810: THE RULE of commit-time form detection, over an in-memory
 * store. Runnable code is inconclusive and ARMS the runtime (a byte scan
 * cannot see a marker born at runtime); a script-less deck is decided by
 * the literal marker in its HTML or JSON; styles, fonts and images never
 * arm it.
 */
const WS = '11111111-1111-1111-1111-111111111111';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function store(blobs: Record<string, string>, chunk = 7): StorageDriver {
  const bySha = new Map(Object.entries(blobs).map(([, v]) => [sha(v), v] as const));
  return {
    name: 'local',
    async getStream(key: string) {
      const body = bySha.get(key.split('/').pop()!);
      if (body === undefined) throw new Error('missing');
      // Tiny chunks: a needle straddling a chunk boundary must still match.
      const pieces: Buffer[] = [];
      for (let i = 0; i < body.length; i += chunk) pieces.push(Buffer.from(body.slice(i, i + chunk)));
      return Readable.from(pieces);
    }
  } as unknown as StorageDriver;
}
const entry = (path: string, body: string, contentType: string): ManifestEntry => ({
  path,
  sha256: sha(body),
  sizeBytes: body.length,
  contentType
});

const SHELL = '<!doctype html><html><body><div id="deck"></div><script src="app.js"></script></body></html>';
const PLAIN = '<!doctype html><html><body><h1>Just slides</h1></body></html>';
const INLINE = '<!doctype html><html><body><SCRIPT>document.body.innerHTML="x"</SCRIPT></body></html>';
const MARKED = '<html><body><form DATA-SLIDELESS-FORM="rsvp"></form></body></html>';
const JS_DATASET = "var f=document.createElement('form');f.dataset.slidelessForm='contact';";
const JSON_MARKED = '{"form":{"attrs":{"data-slideless-form":"survey"}}}';
const CSS_DECOY = '/* data-slideless-form="decoy" */ body{margin:0}';

describe('entryKind', () => {
  it('classifies by declared type OR extension, case-insensitively', () => {
    expect(entryKind(entry('a.html', PLAIN, 'text/html; charset=utf-8'))).toBe('html');
    expect(entryKind(entry('APP.JS', JS_DATASET, 'application/octet-stream'))).toBe('script');
    expect(entryKind(entry('bundle.txt', JS_DATASET, 'text/javascript'))).toBe('script');
    expect(entryKind(entry('slides.json', JSON_MARKED, 'application/octet-stream'))).toBe('json');
    expect(entryKind(entry('data.txt', JSON_MARKED, 'application/json'))).toBe('json');
    expect(entryKind(entry('theme.css', CSS_DECOY, 'text/css'))).toBe('inert');
  });
});

describe('manifestHasForms (PRDCT-1810)', () => {
  const s = store({ SHELL, PLAIN, INLINE, MARKED, JS_DATASET, JSON_MARKED, CSS_DECOY });

  it('a script entry arms the runtime by presence, marker or not (runtime-authored forms are invisible to a scan)', async () => {
    expect(
      await manifestHasForms(s, WS, [
        entry('index.html', SHELL, 'text/html'),
        entry('app.js', JS_DATASET, 'text/javascript')
      ])
    ).toBe(true);
    // …even when the script blob is not readable: presence is the signal.
    expect(
      await manifestHasForms(s, WS, [
        entry('index.html', PLAIN, 'text/html'),
        entry('app.js', 'not-uploaded', 'text/javascript')
      ])
    ).toBe(true);
  });

  it('an HTML page with an inline <script> arms it; a script-less, marker-less page does not', async () => {
    expect(await manifestHasForms(s, WS, [entry('index.html', INLINE, 'text/html')])).toBe(true);
    expect(await manifestHasForms(s, WS, [entry('index.html', PLAIN, 'text/html')])).toBe(false);
  });

  it('a script-less deck is decided by the literal marker in HTML (case-insensitive) or JSON', async () => {
    expect(await manifestHasForms(s, WS, [entry('index.html', MARKED, 'text/html')])).toBe(true);
    expect(
      await manifestHasForms(s, WS, [
        entry('index.html', PLAIN, 'text/html'),
        entry('slides.json', JSON_MARKED, 'application/json')
      ])
    ).toBe(true);
  });

  it('styles never arm it, even carrying the marker text', async () => {
    expect(
      await manifestHasForms(s, WS, [
        entry('index.html', PLAIN, 'text/html'),
        entry('theme.css', CSS_DECOY, 'text/css')
      ])
    ).toBe(false);
  });

  it('a needle split across stream chunks still matches (the carry)', async () => {
    for (const chunk of [1, 2, 3, 5, 11]) {
      const tiny = store({ MARKED, INLINE }, chunk);
      expect(await manifestHasForms(tiny, WS, [entry('index.html', MARKED, 'text/html')])).toBe(true);
      expect(await manifestHasForms(tiny, WS, [entry('index.html', INLINE, 'text/html')])).toBe(true);
    }
  });
});
