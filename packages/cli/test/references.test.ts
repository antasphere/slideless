import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Presentation } from '@slideless/contract';
import { isIgnored, scanDeck, writeLink } from '../src/manifest.js';
import {
  mergeProvenance,
  provenanceOf,
  readFrontmatter,
  readReferenceLink,
  REFERENCE_DIR,
  referenceDirFor,
  resolveReference,
  scaffoldReference,
  splitRefAtVersion,
  stripTypeLine
} from '../src/references.js';
import { DECK } from './harness.js';

/**
 * PRDCT-2420, the pure half (`src/references.ts`): the frontmatter read and
 * strip, the `<ref>` resolution, the `@n` split, the provenance merge, the
 * scaffold, the dot-folder exclusion and the reference link file. No
 * network, no clock — everything is a function of its arguments, so these
 * tests name the exact input and the exact output.
 */

// ── Presentation-shaped candidates ───────────────────────────────────────────

let seq = 0;
function ref(title: string, over: Partial<Presentation> & { id?: string } = {}): Presentation {
  seq += 1;
  const id = over.id ?? `${String(seq).padStart(8, '0')}-1111-4111-8111-111111111111`;
  return {
    ...DECK,
    ...over,
    id,
    title,
    reference: over.reference ?? { type: 'brand' },
    audience: over.audience ?? 'workspace',
    defaultReference: over.defaultReference ?? false,
    metadata: over.metadata ?? {}
  } as unknown as Presentation;
}

// ── readFrontmatter ──────────────────────────────────────────────────────────

describe('readFrontmatter', () => {
  it('a file with no frontmatter declares nothing', () => {
    expect(readFrontmatter('# Just a title\n\nsome body\n')).toEqual({
      frontmatter: false,
      declared: null,
      type: null,
      title: null
    });
  });

  it('an empty text declares nothing', () => {
    expect(readFrontmatter('')).toEqual({
      frontmatter: false,
      declared: null,
      type: null,
      title: null
    });
  });

  it('a frontmatter with no type: line is a block without a declaration', () => {
    const text = '---\ntitle: House\ndescription: nothing typed\n---\n\n# House\n';
    expect(readFrontmatter(text)).toEqual({
      frontmatter: true,
      declared: null,
      type: null,
      title: 'House'
    });
  });

  it('`type: Brand` is the brand type, lowercased', () => {
    const read = readFrontmatter('---\ntype: Brand\ntitle: House\n---\n');
    expect(read).toEqual({ frontmatter: true, declared: 'Brand', type: 'brand', title: 'House' });
  });

  it('`type: "Template"` quoted is the template type, the quotes stripped', () => {
    const read = readFrontmatter('---\ntype: "Template"\ntitle: Monthly\n---\n');
    expect(read).toEqual({ frontmatter: true, declared: 'Template', type: 'template', title: 'Monthly' });
  });

  it('single quotes are stripped too', () => {
    expect(readFrontmatter("---\ntype: 'brand'\n---\n").type).toBe('brand');
  });

  it('an unknown type reports what was declared and no known type', () => {
    expect(readFrontmatter('---\ntype: Deck\n---\n')).toEqual({
      frontmatter: true,
      declared: 'Deck',
      type: null,
      title: null
    });
  });

  it('a BOM before the opening fence still opens the block', () => {
    const read = readFrontmatter('﻿---\ntype: brand\ntitle: House\n---\n\n# House\n');
    expect(read).toEqual({ frontmatter: true, declared: 'brand', type: 'brand', title: 'House' });
  });

  it('CRLF line endings are read the same way', () => {
    const read = readFrontmatter('---\r\ntype: Template\r\ntitle: Monthly\r\n---\r\n\r\n# Monthly\r\n');
    expect(read).toEqual({ frontmatter: true, declared: 'Template', type: 'template', title: 'Monthly' });
  });

  it('a `---` further down the body is not a closing fence: the block already closed', () => {
    // The body's horizontal rule sits AFTER the real close; a `type:` under
    // it is body text, not a declaration.
    const text = ['---', 'title: House', '---', '', '# House', '', '---', '', 'type: brand', ''].join('\n');
    expect(readFrontmatter(text)).toEqual({
      frontmatter: true,
      declared: null,
      type: null,
      title: 'House'
    });
  });

  it('`...` closes the block the way `---` does', () => {
    expect(readFrontmatter('---\ntype: brand\n...\n\n# House\n')).toEqual({
      frontmatter: true,
      declared: 'brand',
      type: 'brand',
      title: null
    });
  });

  it('an unterminated block is "no frontmatter"', () => {
    const text = '---\ntype: brand\ntitle: House\n\n# House, with no closing fence\n';
    expect(readFrontmatter(text)).toEqual({
      frontmatter: false,
      declared: null,
      type: null,
      title: null
    });
  });

  it('an indented `type:` inside a nested mapping is not THE type', () => {
    const text = ['---', 'title: House', 'fonts:', '  type: brand', '---', '', '# House', ''].join('\n');
    expect(readFrontmatter(text)).toEqual({
      frontmatter: true,
      declared: null,
      type: null,
      title: 'House'
    });
  });

  it('reads the block’s top-level title, plain', () => {
    expect(readFrontmatter('---\ntype: brand\ntitle: House brand\n---\n').title).toBe('House brand');
  });

  it('a double-quoted title is JSON-unquoted, colon and escapes included', () => {
    expect(readFrontmatter('---\ntype: brand\ntitle: "Acme: the 2026 look"\n---\n').title).toBe(
      'Acme: the 2026 look'
    );
    expect(readFrontmatter('---\ntype: brand\ntitle: "The \\"big\\" review"\n---\n').title).toBe(
      'The "big" review'
    );
  });

  it('a single-quoted title is unquoted, a doubled quote is one quote', () => {
    expect(readFrontmatter("---\ntype: brand\ntitle: 'House brand'\n---\n").title).toBe('House brand');
    expect(readFrontmatter("---\ntype: brand\ntitle: 'Sam''s brand'\n---\n").title).toBe("Sam's brand");
  });

  it('an absent or empty title is null', () => {
    expect(readFrontmatter('---\ntype: brand\n---\n').title).toBeNull();
    expect(readFrontmatter('---\ntype: brand\ntitle:\n---\n').title).toBeNull();
    expect(readFrontmatter('---\ntype: brand\ntitle: ""\n---\n').title).toBeNull();
  });

  it('a control character spelled by a JSON escape is dropped from the title (Note 7)', () => {
    // `\u001b[2K` is an erase-line sequence: a title is text for a screen,
    // never a terminal instruction. The escape decodes, the control byte goes.
    const title = readFrontmatter('---\ntype: brand\ntitle: "EVIL\\u001b[2KHARMLESS"\n---\n').title;
    expect(title).toBe('EVIL[2KHARMLESS');
    // eslint-disable-next-line no-control-regex -- the point of the assertion.
    expect(/[\u0000-\u001f]/.test(title!)).toBe(false);
  });

  it('control characters are dropped from an unquoted and a single-quoted title too', () => {
    expect(readFrontmatter("---\ntype: brand\ntitle: 'EVIL\u001b[2KHARMLESS'\n---\n").title).toBe(
      'EVIL[2KHARMLESS'
    );
    expect(readFrontmatter('---\ntype: brand\ntitle: EVIL\u0007BELL\n---\n').title).toBe('EVILBELL');
  });

  it('a title that is ONLY control characters reads as no title at all', () => {
    expect(readFrontmatter('---\ntype: brand\ntitle: "\\u001b\\u0007"\n---\n').title).toBeNull();
  });

  it('an indented title inside a nested mapping is not THE title', () => {
    const text = ['---', 'type: brand', 'voice:', '  title: not this one', '---', ''].join('\n');
    expect(readFrontmatter(text).title).toBeNull();
  });

  it('the FIRST top-level title wins', () => {
    expect(readFrontmatter('---\ntitle: first\ntitle: second\n---\n').title).toBe('first');
  });

  it('a `type:` line after the closing fence is not read', () => {
    const text = '---\ntitle: House\n---\ntype: brand\n';
    expect(readFrontmatter(text).declared).toBeNull();
  });
});

// ── stripTypeLine ────────────────────────────────────────────────────────────

describe('stripTypeLine', () => {
  it('removes exactly the type line, keeping title and description', () => {
    const text = '---\ntype: Brand\ntitle: House\ndescription: the look\n---\n\n# House\n\ntype: body text\n';
    expect(stripTypeLine(text)).toBe(
      '---\ntitle: House\ndescription: the look\n---\n\n# House\n\ntype: body text\n'
    );
  });

  it('preserves CRLF endings on the lines it keeps', () => {
    const text = '---\r\ntype: Brand\r\ntitle: House\r\n---\r\n\r\n# House\r\n';
    expect(stripTypeLine(text)).toBe('---\r\ntitle: House\r\n---\r\n\r\n# House\r\n');
  });

  it('a text with no frontmatter comes back byte-identical', () => {
    const text = '# House\n\ntype: brand\n';
    expect(stripTypeLine(text)).toBe(text);
  });

  it('a frontmatter with no type line comes back byte-identical', () => {
    const text = '---\ntitle: House\n---\n\n# House\n';
    expect(stripTypeLine(text)).toBe(text);
  });

  it('the stripped text no longer declares a type', () => {
    const stripped = stripTypeLine('---\ntype: brand\ntitle: House\n---\n');
    expect(readFrontmatter(stripped)).toEqual({
      frontmatter: true,
      declared: null,
      type: null,
      title: 'House'
    });
  });
});

// ── resolveReference ─────────────────────────────────────────────────────────

describe('resolveReference', () => {
  const house = ref('House brand', { id: 'aaaaaaaa-1111-4111-8111-111111111111' });
  const harbour = ref('Harbour brand', { id: 'bbbbbbbb-1111-4111-8111-111111111111' });
  const candidates = [house, harbour];

  it('finds by id, whatever the case of the id', () => {
    expect(resolveReference(candidates, house.id, 'brand')).toBe(house);
    expect(resolveReference(candidates, house.id.toUpperCase(), 'brand')).toBe(house);
  });

  it('finds by exact title', () => {
    expect(resolveReference(candidates, 'Harbour brand', 'brand')).toBe(harbour);
  });

  it('finds by a unique case-insensitive prefix', () => {
    expect(resolveReference(candidates, 'harb', 'brand')).toBe(harbour);
    expect(resolveReference(candidates, 'HOUSE', 'brand')).toBe(house);
  });

  it('an exact title wins over a prefix that would be ambiguous', () => {
    const exact = ref('House', { id: 'cccccccc-1111-4111-8111-111111111111' });
    expect(resolveReference([exact, house], 'House', 'brand')).toBe(exact);
  });

  it('several exact titles are ambiguous, and the error lists the candidates', () => {
    const twin = ref('House brand', { id: 'dddddddd-1111-4111-8111-111111111111' });
    expect(() => resolveReference([house, twin], 'House brand', 'brand')).toThrow(/names several brands/);
    try {
      resolveReference([house, twin], 'House brand', 'brand');
    } catch (e) {
      const message = (e as Error).message;
      expect(message).toContain(house.id);
      expect(message).toContain(twin.id);
    }
  });

  it('several prefix matches are ambiguous, and the error lists them', () => {
    const a = ref('Nord light', { id: 'eeeeeeee-1111-4111-8111-111111111111' });
    const b = ref('Nord dark', { id: 'ffffffff-1111-4111-8111-111111111111' });
    try {
      resolveReference([a, b], 'nord', 'brand');
      throw new Error('expected a refusal');
    } catch (e) {
      const message = (e as Error).message;
      expect(message).toContain('names several brands');
      expect(message).toContain(a.id);
      expect(message).toContain(b.id);
    }
  });

  it('no match names the value and lists what there is', () => {
    try {
      resolveReference(candidates, 'Nowhere', 'brand');
      throw new Error('expected a refusal');
    } catch (e) {
      const message = (e as Error).message;
      expect(message).toContain('No brand named "Nowhere"');
      expect(message).toContain('House brand');
    }
  });

  it('no candidates at all says so', () => {
    expect(() => resolveReference([], 'Nowhere', 'template')).toThrow(/there are none/);
  });

  it('an empty value is a usage error asking for a name', () => {
    expect(() => resolveReference(candidates, '   ', 'reference')).toThrow(/Name a reference/);
  });

  it('a default reference is marked in the candidate listing', () => {
    const d = ref('Default brand', { id: '99999999-1111-4111-8111-111111111111', defaultReference: true });
    try {
      resolveReference([d], 'Nowhere', 'brand');
      throw new Error('expected a refusal');
    } catch (e) {
      expect((e as Error).message).toContain('(default)');
    }
  });
});

// ── splitRefAtVersion ────────────────────────────────────────────────────────

describe('splitRefAtVersion', () => {
  it('`house@3` splits into the ref and the version', () => {
    expect(splitRefAtVersion('house@3')).toEqual({ ref: 'house', version: 3 });
  });

  it('`house` alone leaves the version undefined', () => {
    expect(splitRefAtVersion('house')).toEqual({ ref: 'house', version: undefined });
  });

  it('a title carrying an `@` not followed by trailing digits stays whole', () => {
    expect(splitRefAtVersion('brand@acme')).toEqual({ ref: 'brand@acme', version: undefined });
    expect(splitRefAtVersion('brand@2x')).toEqual({ ref: 'brand@2x', version: undefined });
  });

  it('only the LAST @digits is the version', () => {
    expect(splitRefAtVersion('brand@acme@7')).toEqual({ ref: 'brand@acme', version: 7 });
  });

  it('`@0` is refused: a version is a whole number from 1', () => {
    expect(() => splitRefAtVersion('house@0')).toThrow(/whole number from 1/);
  });
});

// ── mergeProvenance / provenanceOf ───────────────────────────────────────────

const BRAND_ID = 'aaaaaaaa-2222-4222-8222-222222222222';
const TEMPLATE_ID = 'bbbbbbbb-2222-4222-8222-222222222222';

describe('mergeProvenance', () => {
  it('keeps the owner’s other keys', () => {
    const merged = mergeProvenance({ client: 'Acme', tags: ['q1'] }, [
      { type: 'brand', id: BRAND_ID, version: 2 }
    ]);
    expect(merged.client).toBe('Acme');
    expect(merged.tags).toEqual(['q1']);
    expect(merged.references).toEqual([{ type: 'brand', id: BRAND_ID, version: 2 }]);
  });

  it('replaces the entry of the same type and keeps the other types', () => {
    const merged = mergeProvenance(
      {
        references: [
          { type: 'brand', id: 'old', version: 1 },
          { type: 'template', id: TEMPLATE_ID, version: 4 }
        ]
      },
      [{ type: 'brand', id: BRAND_ID, version: 9 }]
    );
    expect(merged.references).toEqual([
      { type: 'template', id: TEMPLATE_ID, version: 4 },
      { type: 'brand', id: BRAND_ID, version: 9 }
    ]);
  });

  it('drops the invalid entries of an existing list', () => {
    const merged = mergeProvenance(
      {
        references: [
          { type: 'brand', id: 'kept-brand', version: 1 },
          { type: 'colour', id: 'x', version: 1 },
          { type: 'template', id: 'no version' },
          { type: 'template', id: 't', version: 0 },
          { type: 'template', id: 't', version: 1.5 },
          'nonsense',
          null,
          ['not an object']
        ]
      },
      [{ type: 'template', id: TEMPLATE_ID, version: 1 }]
    );
    expect(merged.references).toEqual([
      { type: 'brand', id: 'kept-brand', version: 1 },
      { type: 'template', id: TEMPLATE_ID, version: 1 }
    ]);
  });

  it('a non-array `references` is replaced, not merged', () => {
    expect(
      mergeProvenance({ references: 'the house brand' }, [{ type: 'brand', id: BRAND_ID, version: 1 }])
        .references
    ).toEqual([{ type: 'brand', id: BRAND_ID, version: 1 }]);
    expect(mergeProvenance({ references: { type: 'brand' } }, []).references).toEqual([]);
  });

  it('writes only the three fields of an entry, never whatever else it carried', () => {
    const merged = mergeProvenance({}, [{ type: 'brand', id: BRAND_ID, version: 1, note: 'extra' } as never]);
    expect(merged.references).toEqual([{ type: 'brand', id: BRAND_ID, version: 1 }]);
  });

  it('no entries keeps the existing valid list', () => {
    const merged = mergeProvenance({ references: [{ type: 'brand', id: BRAND_ID, version: 3 }] }, []);
    expect(merged.references).toEqual([{ type: 'brand', id: BRAND_ID, version: 3 }]);
  });
});

describe('provenanceOf', () => {
  it('returns only the valid entries', () => {
    expect(
      provenanceOf({
        references: [
          { type: 'brand', id: BRAND_ID, version: 2 },
          { type: 'nope', id: 'x', version: 1 },
          { type: 'template', id: 't', version: -1 },
          42
        ]
      })
    ).toEqual([{ type: 'brand', id: BRAND_ID, version: 2 }]);
  });

  it('a metadata with no references, or a non-array one, is empty', () => {
    expect(provenanceOf({})).toEqual([]);
    expect(provenanceOf({ references: 'brand' })).toEqual([]);
  });
});

// ── scaffoldReference ────────────────────────────────────────────────────────

describe('scaffoldReference', () => {
  const agentOf = (s: { files: Array<{ path: string; content: string }> }) =>
    s.files.find((f) => f.path === 'AGENT.md')!.content;

  it('a brand scaffold declares the brand type and ships index.html', () => {
    const s = scaffoldReference('brand', 'House brand');
    expect(s.files.map((f) => f.path).sort()).toEqual(['AGENT.md', 'index.html']);
    expect(readFrontmatter(agentOf(s))).toMatchObject({ frontmatter: true, type: 'brand' });
    expect(s.dirs).toEqual(['assets', 'assets/fonts']);
  });

  it('a template scaffold declares the template type', () => {
    const s = scaffoldReference('template', 'Quarterly review');
    expect(readFrontmatter(agentOf(s))).toMatchObject({ frontmatter: true, type: 'template' });
    expect(s.dirs).toEqual(['assets']);
  });

  it('the brand frontmatter carries every brand field', () => {
    const agent = agentOf(scaffoldReference('brand', 'House brand'));
    for (const key of ['fonts:', 'colors:', 'background:', 'shape:', 'motion:', 'voice:']) {
      expect(agent).toContain(`\n${key}`);
    }
  });

  it('the template frontmatter carries every template field', () => {
    const agent = agentOf(scaffoldReference('template', 'Quarterly review'));
    for (const key of ['purpose:', 'pages:', 'fill:']) {
      expect(agent).toContain(`\n${key}`);
    }
  });

  it('a title with a colon survives: the frontmatter still closes and still declares the type', () => {
    const title = 'Acme: the 2026 look';
    const s = scaffoldReference('brand', title);
    const agent = agentOf(s);
    expect(agent).toContain(`title: ${JSON.stringify(title)}`);
    expect(readFrontmatter(agent)).toMatchObject({ frontmatter: true, type: 'brand' });
    // The heading carries the title as typed.
    expect(agent).toContain(`# ${title}`);
  });

  it('a title with a double quote is quoted safely too', () => {
    const s = scaffoldReference('template', 'The "big" review');
    expect(readFrontmatter(agentOf(s))).toMatchObject({ type: 'template' });
    expect(agentOf(s)).toContain('title: "The \\"big\\" review"');
  });

  it('a title with HTML is escaped in the deck', () => {
    const s = scaffoldReference('brand', '<script>x</script>');
    const html = s.files.find((f) => f.path === 'index.html')!.content;
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('no title falls back to an invented one, and the timestamp is the clock passed in', () => {
    const s = scaffoldReference('brand', undefined, new Date('2026-03-04T05:06:07.890Z'));
    const agent = agentOf(s);
    expect(agent).toContain('title: "Meridian Cartography brand"');
    expect(agent).toContain('timestamp: 2026-03-04T05:06:07Z');
    expect(scaffoldReference('template', undefined).files[0]!.content).toContain(
      'title: "Monthly project update"'
    );
  });

  it('the scaffolded AGENT.md, stripped, declares no type (what `start` writes)', () => {
    const agent = agentOf(scaffoldReference('brand', 'House brand'));
    expect(readFrontmatter(stripTypeLine(agent)).type).toBeNull();
    expect(stripTypeLine(agent)).toContain('title: "House brand"');
  });
});

// ── The dot-folder exclusion ─────────────────────────────────────────────────

describe('a pulled reference never leaks into the deck beside it', () => {
  it('scanDeck lists the deck’s own files and nothing under .slideless/', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'slideless-ref-scan-'));
    await writeFile(join(dir, 'index.html'), '<html>deck</html>');
    await writeFile(join(dir, 'AGENT.md'), '# deck\n');
    const brandDir = referenceDirFor(dir, 'brand');
    await mkdir(brandDir, { recursive: true });
    await writeFile(join(brandDir, 'AGENT.md'), '---\ntype: brand\n---\n');
    await writeFile(join(brandDir, 'index.html'), '<html>brand</html>');

    const scan = await scanDeck(dir);
    expect(scan.files.map((f) => f.path).sort()).toEqual(['AGENT.md', 'index.html']);
  });

  it('referenceDirFor is .slideless/<type> under the deck root', () => {
    expect(referenceDirFor('/decks/q1', 'brand')).toBe(join('/decks/q1', '.slideless', 'brand'));
    expect(referenceDirFor('/decks/q1', 'template')).toBe(join('/decks/q1', '.slideless', 'template'));
    expect(REFERENCE_DIR).toBe('.slideless');
  });

  it('isIgnored refuses the dot folder itself', () => {
    expect(isIgnored(REFERENCE_DIR, true, [])).toBe(true);
    // The walk never descends past the dot folder, so its nested segments are
    // never offered to `isIgnored`; the basename rule is what stops it.
    expect(isIgnored('index.html', false, [])).toBe(false);
  });
});

// ── readReferenceLink ────────────────────────────────────────────────────────

describe('readReferenceLink', () => {
  const PID = '11111111-1111-1111-1111-111111111111';

  const tempDir = () => mkdtemp(join(tmpdir(), 'slideless-ref-link-'));

  it('reads a link carrying a reference block', async () => {
    const dir = await tempDir();
    await writeLink(dir, {
      presentationId: PID,
      baseUrl: 'http://x',
      reference: { type: 'brand', version: 3 }
    });
    expect(await readReferenceLink(dir)).toEqual({
      presentationId: PID,
      baseUrl: 'http://x',
      reference: { type: 'brand', version: 3 }
    });
  });

  it('a plain deck link is not a reference link', async () => {
    const dir = await tempDir();
    await writeLink(dir, { presentationId: PID, baseUrl: 'http://x' });
    expect(await readReferenceLink(dir)).toBeNull();
  });

  it('a malformed reference block is not a reference link', async () => {
    for (const reference of [
      { type: 'colour', version: 1 },
      { type: 'brand', version: 0 },
      { type: 'brand', version: 1.5 },
      { type: 'brand' },
      'brand',
      null
    ]) {
      const dir = await tempDir();
      await writeFile(
        join(dir, '.slideless.json'),
        JSON.stringify({ presentationId: PID, baseUrl: 'http://x', reference })
      );
      expect(await readReferenceLink(dir)).toBeNull();
    }
  });

  it('a missing or unparsable file is null, never a throw', async () => {
    const dir = await tempDir();
    expect(await readReferenceLink(dir)).toBeNull();
    await writeFile(join(dir, '.slideless.json'), 'not json');
    expect(await readReferenceLink(dir)).toBeNull();
  });

  it('the plain deck fields still read off a reference link (a push targets the reference)', async () => {
    const dir = await tempDir();
    await writeLink(dir, {
      presentationId: PID,
      baseUrl: 'http://x',
      reference: { type: 'template', version: 2 }
    });
    const { readLink } = await import('../src/manifest.js');
    expect(await readLink(dir)).toEqual({ presentationId: PID, baseUrl: 'http://x' });
  });
});
