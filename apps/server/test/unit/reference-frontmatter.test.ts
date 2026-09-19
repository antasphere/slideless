import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { REFERENCE_MAX_LENGTH, type ManifestEntry } from '@slideless/contract';
import {
  FRONTMATTER_READ_CAP,
  parseReferenceFrontmatter,
  readReference
} from '../../src/presentations/reference-frontmatter.js';
import type { StorageDriver } from '../../src/storage/driver.js';

/**
 * ADR 024: the AGENT.md frontmatter reader. It classifies and never refuses:
 * every unusable shape is an ordinary deck, with a warning only where the
 * author visibly tried to declare a reference.
 */
const read = (text: string, truncated = false) => parseReferenceFrontmatter(Buffer.from(text), truncated);
const ORDINARY = { reference: null, warning: null };
/** Built from its code point: an invisible literal in a source file is a trap. */
const BOM = String.fromCharCode(0xfeff);

/** Every warning is one sentence, opens and closes the same way, and stays short. */
function expectWarning(
  result: { reference: unknown; warning: string | null },
  fragment: string | RegExp
): string {
  expect(result.reference).toBeNull();
  expect(result.warning).not.toBeNull();
  const warning = result.warning!;
  expect(warning.startsWith('AGENT.md frontmatter ')).toBe(true);
  expect(warning.endsWith('; the deck was saved as an ordinary deck.')).toBe(true);
  // eslint-disable-next-line no-control-regex
  expect(warning).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  expect(warning.length).toBeLessThan(260);
  if (typeof fragment === 'string') expect(warning).toContain(fragment);
  else expect(warning).toMatch(fragment);
  return warning;
}

const BRAND = `---
type: Brand
name: Antasphere
version: 3
updated: 2026-09-01T10:00:00Z
released: 2026-09-01
fonts:
  heading: { family: "Inter Tight", weights: [600, 700] }
  body:
    family: Inter
    fallback: [system-ui, sans-serif]
colors:
  primary: "#5B21B6"
  surface:
    light: "#FFFFFF"
    dark: "#0B0B10"
tags: [brand, 2026, official]
dark_mode: true
notes: |
  Two lines,
  kept verbatim.
---
# Briefing

Use the brand as it stands.
`;

describe('parseReferenceFrontmatter: references', () => {
  it('mirrors a full Brand frontmatter: type lowercased, every other key verbatim', () => {
    const result = read(BRAND);
    expect(result.warning).toBeNull();
    expect(result.reference).toEqual({
      type: 'brand',
      name: 'Antasphere',
      version: 3,
      // The core schema has no timestamp type: both stay the strings the author wrote.
      updated: '2026-09-01T10:00:00Z',
      released: '2026-09-01',
      fonts: {
        heading: { family: 'Inter Tight', weights: [600, 700] },
        body: { family: 'Inter', fallback: ['system-ui', 'sans-serif'] }
      },
      colors: { primary: '#5B21B6', surface: { light: '#FFFFFF', dark: '#0B0B10' } },
      tags: ['brand', 2026, 'official'],
      dark_mode: true,
      notes: 'Two lines,\nkept verbatim.\n'
    });
    // Body content never leaks into the mirror.
    expect(JSON.stringify(result.reference)).not.toContain('Briefing');
  });

  it('reads a Template', () => {
    expect(read('---\ntype: Template\nslides: 12\n---\nbody')).toEqual({
      reference: { type: 'template', slides: 12 },
      warning: null
    });
  });

  it.each([
    ['brand', 'brand'],
    ['BRAND', 'brand'],
    ['Brand', 'brand'],
    ['"  TeMpLaTe  "', 'template']
  ])('matches type %s case-insensitively, after trim', (written, stored) => {
    expect(read(`---\ntype: ${written}\n---\n`)).toEqual({ reference: { type: stored }, warning: null });
  });

  it('strips a UTF-8 BOM', () => {
    expect(read(BOM + '---\ntype: Brand\n---\n').reference).toEqual({ type: 'brand' });
  });

  it('accepts CRLF line endings', () => {
    expect(read('---\r\ntype: Brand\r\nname: Acme\r\n---\r\n# Body\r\n')).toEqual({
      reference: { type: 'brand', name: 'Acme' },
      warning: null
    });
  });

  it('tolerates trailing spaces and tabs on both fences, and a `...` closing fence', () => {
    expect(read('--- \t\ntype: Brand\n---\t \nbody').reference).toEqual({ type: 'brand' });
    expect(read('---\ntype: Brand\n...\nbody').reference).toEqual({ type: 'brand' });
  });

  it('takes a closing fence on the last line of a file with no final newline', () => {
    expect(read('---\ntype: Brand\n---').reference).toEqual({ type: 'brand' });
  });

  it('stops at the FIRST closing fence: a later `---` in the body changes nothing', () => {
    const result = read(
      '---\ntype: Brand\nname: Acme\n---\n# Body\n\n---\ntype: Template\nleak: true\n---\nmore\n'
    );
    expect(result).toEqual({ reference: { type: 'brand', name: 'Acme' }, warning: null });
  });

  it('keeps a reference whose body runs past the cap, as long as the fence closed inside it', () => {
    const head = Buffer.from(`---\ntype: Brand\n---\n${'x'.repeat(FRONTMATTER_READ_CAP)}`).subarray(
      0,
      FRONTMATTER_READ_CAP
    );
    expect(parseReferenceFrontmatter(head, true)).toEqual({ reference: { type: 'brand' }, warning: null });
  });

  it('normalises through JSON: an aliased node is copied, .nan becomes null', () => {
    const result = read('---\ntype: Brand\nbase: &b { a: 1 }\ncopy: *b\nratio: .nan\n---\n');
    expect(result).toEqual({
      reference: { type: 'brand', base: { a: 1 }, copy: { a: 1 }, ratio: null },
      warning: null
    });
  });

  it('hands back a fresh result each time', () => {
    const first = read('plain');
    first.warning = 'mutated';
    expect(read('plain')).toEqual(ORDINARY);
  });
});

describe('parseReferenceFrontmatter: ordinary decks, silently', () => {
  it.each([
    ['no frontmatter at all', '# Briefing\n\nJust a deck.\n'],
    ['an empty file', ''],
    ['a fence that is not on the very first line', '\n---\ntype: Brand\n---\n'],
    ['a first line that only starts like a fence', '---- \ntype: Brand\n---\n'],
    ['an indented fence', ' ---\ntype: Brand\n---\n'],
    ['a frontmatter with no `type` key', '---\ntitle: Q3 review\nauthor: Romain\n---\nbody'],
    ['a `Type` key in another case (the key is exact)', '---\nType: Brand\n---\n'],
    ['an empty frontmatter', '---\n---\nbody'],
    ['a comment-only frontmatter', '---\n# nothing here\n---\nbody']
  ])('%s', (_label, text) => {
    expect(read(text)).toEqual(ORDINARY);
  });

  it('a truncated head whose first line is not a fence', () => {
    expect(read('x'.repeat(200), true)).toEqual(ORDINARY);
  });
});

describe('parseReferenceFrontmatter: warnings', () => {
  it('no closing fence in a complete file', () => {
    const warning = expectWarning(read('---\ntype: Brand\nname: Acme\n'), 'has no closing "---" line');
    expect(warning).not.toContain('16 KB');
  });

  it('no closing fence within the cap of a longer file', () => {
    const head = Buffer.from(`---\ntype: Brand\nnotes: |\n${'  filler line\n'.repeat(2000)}`).subarray(
      0,
      FRONTMATTER_READ_CAP
    );
    expectWarning(parseReferenceFrontmatter(head, true), 'has no closing "---" line within the first 16 KB');
  });

  it('a `---` cut by the cap is half a line, not a fence', () => {
    // Complete, the same bytes close; truncated, the line may go on (`---more`).
    expect(read('---\ntype: Brand\n---').reference).toEqual({ type: 'brand' });
    expectWarning(read('---\ntype: Brand\n---', true), 'within the first 16 KB');
  });

  it('a YAML list', () => {
    expectWarning(read('---\n- type: Brand\n- other\n---\n'), 'but it is a list');
  });

  it('a scalar', () => {
    expectWarning(read('---\njust a sentence\n---\n'), 'but it is a string');
    expectWarning(read('---\n42\n---\n'), 'but it is a number');
  });

  it('a mirror over the serialized cap', () => {
    // Aliases let a source under the READ cap serialize over the MIRROR cap: the second limit is what fires.
    const aliased = `---\ntype: Brand\nbase: &b "${'a'.repeat(4000)}"\nc1: *b\nc2: *b\nc3: *b\nc4: *b\n---\n`;
    expect(Buffer.byteLength(aliased)).toBeLessThan(FRONTMATTER_READ_CAP);
    const warning = expectWarning(read(aliased), 'is too large to keep');
    expect(warning).toContain(`the limit is ${REFERENCE_MAX_LENGTH}`);
  });

  it('an unknown type is named, with the known ones', () => {
    const warning = expectWarning(read('---\ntype: Poster\n---\n'), 'names the type "Poster"');
    expect(warning).toBe(
      'AGENT.md frontmatter names the type "Poster", which is not a known reference type (brand, template); the deck was saved as an ordinary deck.'
    );
  });

  it('echoes at most a short, control-free slice of an unknown type', () => {
    const hostile = `Pos\\u001b[31mter\\u202E${'z'.repeat(500)}`;
    const warning = expectWarning(read(`---\ntype: "${hostile}"\n---\n`), 'names the type "Pos[31mter');
    expect(warning).not.toContain(String.fromCharCode(0x202e));
    expect(warning).not.toContain('z'.repeat(61));
  });

  it.each([
    ['12', 'a number'],
    ['true', 'a true/false value'],
    ['[brand]', 'a list'],
    ['{ name: brand }', 'a mapping'],
    ['', 'empty']
  ])('a type that is not text: %s', (written, named) => {
    expectWarning(read(`---\ntype: ${written}\n---\n`), `has a "type" that is not text (it is ${named})`);
  });

  it('malformed YAML', () => {
    expectWarning(read('---\ntype: Brand\nkey: [unclosed\n---\n'), 'could not be parsed as YAML');
  });

  it('duplicate keys', () => {
    expectWarning(
      read('---\ntype: Brand\nname: one\nname: two\n---\n'),
      'could not be parsed as YAML (duplicate key)'
    );
  });

  it('an alias bomb returns fast, as a warning', () => {
    let bomb = '---\ntype: Brand\na0: &a0 [x,x,x,x,x,x,x,x,x]\n';
    for (let i = 1; i < 12; i++)
      bomb += `a${i}: &a${i} [${Array(9)
        .fill(`*a${i - 1}`)
        .join(',')}]\n`;
    bomb += '---\n';
    const started = Date.now();
    const result = read(bomb);
    expect(Date.now() - started).toBeLessThan(1000);
    expectWarning(result, 'could not be parsed as YAML');
  });

  it('an alias that points back at itself', () => {
    expectWarning(read('---\ntype: Brand\nloop: &l [*l]\n---\n'), 'could not be converted to JSON');
  });

  it('hostile nesting neither hangs nor throws', () => {
    const deep = `---\ntype: Brand\ndeep: ${'['.repeat(7000)}${']'.repeat(7000)}\n---\n`;
    expectWarning(read(deep), /could not be parsed as YAML|nests deeper/);
    const forty = `---\ntype: Brand\ndeep: ${'['.repeat(40)}${']'.repeat(40)}\n---\n`;
    expectWarning(read(forty), 'nests deeper than 32 levels');
  });

  it.each([
    ['__proto__', '---\ntype: Brand\n__proto__: { polluted: true }\n---\n'],
    ['constructor', '---\ntype: Brand\ncolors:\n  constructor: 1\n---\n'],
    ['prototype', '---\ntype: Brand\nlist:\n  - deep: { prototype: x }\n---\n']
  ])('a reserved key at any depth: %s', (key, text) => {
    expectWarning(read(text), `uses the reserved key "${key}"`);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('a NUL character in a value or a key', () => {
    expectWarning(read('---\ntype: Brand\nname: "a\\0b"\n---\n'), 'contains a NUL character');
    expectWarning(read('---\ntype: Brand\n"k\\0": 1\n---\n'), 'contains a NUL character');
  });

  it('a value JSON cannot hold (!!binary hands back a Buffer)', () => {
    expectWarning(
      read('---\ntype: Brand\nlogo: !!binary aGVsbG8=\n---\n'),
      'holds a value that cannot be kept as JSON'
    );
  });

  it('never throws on arbitrary bytes', () => {
    const noise = Buffer.concat([
      Buffer.from('---\n'),
      Buffer.from([0xff, 0xfe, 0x00, 0xc3, 0x28]),
      Buffer.from('\n---\n')
    ]);
    expect(() => parseReferenceFrontmatter(noise, false)).not.toThrow();
    expect(parseReferenceFrontmatter(noise, false).reference).toBeNull();
  });
});

// ── readReference over an in-memory store ────────────────────────────────────

const WS = '11111111-1111-1111-1111-111111111111';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const entry = (path: string, body: string): ManifestEntry => ({
  path,
  sha256: sha(body),
  sizeBytes: Buffer.byteLength(body),
  contentType: 'text/markdown'
});

interface Probe {
  storage: StorageDriver;
  keys: string[];
  /** Chunks the reader actually pulled off the last stream. */
  pulled: () => number;
  destroyed: () => boolean;
}

function store(blobs: string[], chunk = 64): Probe {
  const bySha = new Map(blobs.map((body) => [sha(body), body] as const));
  const keys: string[] = [];
  let pulled = 0;
  let last: Readable | undefined;
  const storage = {
    name: 'local',
    async getStream(key: string) {
      keys.push(key);
      const body = bySha.get(key.split('/').pop()!);
      if (body === undefined) throw new Error('missing');
      const bytes = Buffer.from(body);
      pulled = 0;
      function* pieces() {
        for (let i = 0; i < bytes.length; i += chunk) {
          pulled++;
          yield bytes.subarray(i, i + chunk);
        }
      }
      last = Readable.from(pieces(), { highWaterMark: 1 });
      return last;
    }
  } as unknown as StorageDriver;
  return { storage, keys, pulled: () => pulled, destroyed: () => last?.destroyed === true };
}

describe('readReference', () => {
  it('reads the reference off the AGENT.md blob, across tiny chunks', async () => {
    const probe = store([BRAND], 5);
    const result = await readReference(probe.storage, WS, [
      entry('index.html', '<html>'),
      entry('AGENT.md', BRAND)
    ]);
    expect(result.warning).toBeNull();
    expect(result.reference).toMatchObject({ type: 'brand', name: 'Antasphere' });
    expect(probe.keys).toEqual([`ws/${WS}/${sha(BRAND).slice(0, 2)}/${sha(BRAND)}`]);
    expect(probe.destroyed()).toBe(true);
  });

  it('gives the same answer whatever the chunking', async () => {
    const expected = read(BRAND);
    for (const chunk of [1, 2, 3, 4, 7, 100, 100_000]) {
      const result = await readReference(store([BRAND], chunk).storage, WS, [entry('AGENT.md', BRAND)]);
      expect(result).toEqual(expected);
    }
  });

  it('no AGENT.md entry: ordinary, and storage is never touched', async () => {
    const probe = store([]);
    expect(await readReference(probe.storage, WS, [entry('index.html', '<html>')])).toEqual(ORDINARY);
    expect(await readReference(probe.storage, WS, [])).toEqual(ORDINARY);
    expect(probe.keys).toEqual([]);
  });

  it('a nested or differently-cased AGENT.md does not count', async () => {
    const probe = store([BRAND]);
    const manifest = [entry('docs/AGENT.md', BRAND), entry('agent.md', BRAND), entry('AGENT.MD', BRAND)];
    expect(await readReference(probe.storage, WS, manifest)).toEqual(ORDINARY);
    expect(probe.keys).toEqual([]);
  });

  it('a missing blob (storage throws): ordinary, no warning, no throw', async () => {
    const probe = store([]);
    expect(await readReference(probe.storage, WS, [entry('AGENT.md', BRAND)])).toEqual(ORDINARY);
    expect(probe.keys).toHaveLength(1);
  });

  it('a stream that fails midway: ordinary, no throw', async () => {
    const storage = {
      name: 'local',
      async getStream() {
        return Readable.from(
          (function* () {
            yield Buffer.from('---\ntype: Brand\n');
            throw new Error('connection reset');
          })()
        );
      }
    } as unknown as StorageDriver;
    expect(await readReference(storage, WS, [entry('AGENT.md', BRAND)])).toEqual(ORDINARY);
  });

  it('an invalid workspace id or sha resolves to ordinary instead of throwing', async () => {
    const probe = store([BRAND]);
    expect(await readReference(probe.storage, 'not-a-uuid', [entry('AGENT.md', BRAND)])).toEqual(ORDINARY);
    expect(
      await readReference(probe.storage, WS, [{ ...entry('AGENT.md', BRAND), sha256: '../../etc' }])
    ).toEqual(ORDINARY);
    expect(probe.keys).toEqual([]);
  });

  it('stops reading as soon as the closing fence is seen, however long the body', async () => {
    const body = `---\ntype: Template\nname: Pitch\n---\n${'# a long briefing line\n'.repeat(20_000)}`;
    expect(Buffer.byteLength(body)).toBeGreaterThan(FRONTMATTER_READ_CAP * 10);
    const probe = store([body], 64);
    const result = await readReference(probe.storage, WS, [entry('AGENT.md', body)]);
    expect(result).toEqual({ reference: { type: 'template', name: 'Pitch' }, warning: null });
    // The frontmatter is 35 bytes: one 64-byte chunk decides it (plus the stream's own read-ahead).
    expect(probe.pulled()).toBeLessThanOrEqual(4);
    expect(probe.destroyed()).toBe(true);
  });

  it('stops reading at once when the first line is not a fence', async () => {
    const body = `# Briefing\n${'text\n'.repeat(50_000)}`;
    const probe = store([body], 64);
    expect(await readReference(probe.storage, WS, [entry('AGENT.md', body)])).toEqual(ORDINARY);
    expect(probe.pulled()).toBeLessThanOrEqual(4);
    expect(probe.destroyed()).toBe(true);
  });

  it('never reads far past the cap when the frontmatter does not close', async () => {
    const body = `---\ntype: Brand\nnotes: |\n${'  filler line\n'.repeat(20_000)}---\n`;
    const probe = store([body], 1024);
    const result = await readReference(probe.storage, WS, [entry('AGENT.md', body)]);
    expectWarning(result, 'has no closing "---" line within the first 16 KB');
    expect(probe.pulled()).toBeLessThanOrEqual(FRONTMATTER_READ_CAP / 1024 + 4);
    expect(probe.destroyed()).toBe(true);
  });

  it('a fence that closes exactly past the cap is outside it, whatever the chunking', async () => {
    const filler = `---\ntype: Brand\nnotes: "${'n'.repeat(FRONTMATTER_READ_CAP)}"\n---\n`;
    for (const chunk of [1000, 1_000_000]) {
      const result = await readReference(store([filler], chunk).storage, WS, [entry('AGENT.md', filler)]);
      expectWarning(result, 'within the first 16 KB');
    }
  });
});
