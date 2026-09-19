import { describe, expect, it } from 'vitest';
import type { ManifestEntry, Reference } from '@slideless/contract';
import {
  audienceSentence,
  basenameOf,
  canSetAudience,
  canSetDefault,
  descriptionOf,
  entriesOf,
  extraFieldsOf,
  fileGroupsOf,
  fontsOf,
  googleFontOf,
  googleFontsHref,
  hexOf,
  linesOf,
  matchesQuery,
  plainValue,
  readView,
  referenceRefusal,
  swatchesOf,
  tagsOf,
  viewKeyOf,
  voiceOf,
  writeView
} from './references';

/** The docs' brand, as the server mirrors it (type lowercased, the rest verbatim). */
const northwind: Reference = {
  type: 'brand',
  title: 'Northwind Freight brand',
  description: 'The look and the voice of every Northwind Freight deck.',
  tags: ['brand', 'northwind'],
  timestamp: '2026-09-12T09:00:00Z',
  fonts: {
    heading: { family: 'Fraunces', weights: [600, 700], source: 'assets/fonts/fraunces.woff2' },
    body: { family: 'Inter', weights: [400, 500] },
    mono: 'Berkeley Mono'
  },
  colors: [
    { name: 'Harbour', hex: '#0b3954', role: 'primary, headings and the cover background' },
    { name: 'Signal', hex: '#FF6B35', role: 'accent, one element per page at most' },
    { name: 'Chalk', hex: 'not a colour', role: 'page background' }
  ],
  background: { default: 'Chalk, flat', never: ['gradients', 'photographs behind text'] },
  shape: { radius: '4px', logo: 'assets/logo.svg' },
  motion: 'fade, 200ms, ease-out',
  voice: {
    tone: 'plain, direct, numbers before adjectives',
    avoid: ['seamless', 'world-class'],
    person: 'we',
    example: 'We moved 41,000 containers in Q2.'
  },
  season: 'winter 2026',
  owner: { team: 'marketing', since: 2024 }
};

describe('the frontmatter laid flat', () => {
  it('plainValue keeps a string, spells a number, joins a list, flattens an object', () => {
    expect(plainValue(' 4px ')).toBe('4px');
    expect(plainValue(600)).toBe('600');
    expect(plainValue(true)).toBe('true');
    expect(plainValue(['fade', 200, 'ease-out'])).toBe('fade, 200, ease-out');
    expect(plainValue({ radius: '4px', logo: 'assets/logo.svg' })).toBe('radius: 4px; logo: assets/logo.svg');
    expect(plainValue(null)).toBe('');
    expect(plainValue(undefined)).toBe('');
  });

  it('linesOf and entriesOf turn any shape into rows and never throw', () => {
    expect(linesOf(['Cover.', 'The quarter in three figures.'])).toEqual([
      'Cover.',
      'The quarter in three figures.'
    ]);
    expect(linesOf('one line')).toEqual(['one line']);
    expect(linesOf({ keep: 'the order', change: ['every figure', 'the names'] })).toEqual([
      'keep: the order',
      'change: every figure, the names'
    ]);
    expect(entriesOf({ data: 'downloads/figures.csv', empty: '' })).toEqual([
      { key: 'data', value: 'downloads/figures.csv' }
    ]);
    expect(entriesOf(['a', 'b'])).toEqual([
      { key: '1', value: 'a' },
      { key: '2', value: 'b' }
    ]);
    expect(entriesOf('one')).toEqual([{ key: '', value: 'one' }]);
    expect(entriesOf(42)).toEqual([{ key: '', value: '42' }]);
  });

  it('descriptionOf and tagsOf read the common fields, tolerant of their absence', () => {
    expect(descriptionOf(northwind)).toBe('The look and the voice of every Northwind Freight deck.');
    expect(descriptionOf({ type: 'brand', description: 12 })).toBe('');
    expect(descriptionOf(null)).toBe('');
    expect(tagsOf(northwind)).toEqual(['brand', 'northwind']);
    expect(tagsOf({ type: 'template', tags: 'qbr, customer' })).toEqual(['qbr', 'customer']);
    expect(tagsOf({ type: 'template' })).toEqual([]);
  });
});

describe('the colours', () => {
  it('hexOf accepts CSS hex colours only: a swatch background is an inline style', () => {
    expect(hexOf('#0b3954')).toBe('#0B3954');
    expect(hexOf('#FFF')).toBe('#FFF');
    expect(hexOf('#FF6B35CC')).toBe('#FF6B35CC');
    expect(hexOf('red')).toBeNull();
    expect(hexOf('url(x)')).toBeNull();
    expect(hexOf('#0b3954; background: url(x)')).toBeNull();
    expect(hexOf(0x0b3954)).toBeNull();
  });

  it('swatchesOf reads the docs shape and keeps a colour whose hex is unusable as a name', () => {
    expect(swatchesOf(northwind)).toEqual([
      { name: 'Harbour', hex: '#0B3954', role: 'primary, headings and the cover background' },
      { name: 'Signal', hex: '#FF6B35', role: 'accent, one element per page at most' },
      { name: 'Chalk', hex: '', role: 'page background' }
    ]);
  });

  it('swatchesOf reads a list of hexes and an object of names to hexes', () => {
    expect(swatchesOf({ type: 'brand', colors: ['#111', 'nope', '#222222'] })).toEqual([
      { name: '#111', hex: '#111', role: '' },
      { name: '#222222', hex: '#222222', role: '' }
    ]);
    expect(
      swatchesOf({ type: 'brand', colors: { Ink: '#1b1b1e', Tide: { hex: '#8FB8C9', role: 'charts' } } })
    ).toEqual([
      { name: 'Ink', hex: '#1B1B1E', role: '' },
      { name: 'Tide', hex: '#8FB8C9', role: 'charts' }
    ]);
    expect(swatchesOf({ type: 'brand', colors: 'blue' })).toEqual([]);
    expect(swatchesOf({ type: 'template' })).toEqual([]);
  });
});

describe('the fonts', () => {
  it('fontsOf reads a slot object, a bare family and a list', () => {
    expect(fontsOf(northwind)).toEqual([
      { slot: 'heading', family: 'Fraunces', weights: [600, 700], source: 'assets/fonts/fraunces.woff2' },
      { slot: 'body', family: 'Inter', weights: [400, 500], source: '' },
      { slot: 'mono', family: 'Berkeley Mono', weights: [], source: '' }
    ]);
    expect(
      fontsOf({ type: 'brand', fonts: [{ slot: 'display', family: 'Lora', weight: 500 }, 'Karla'] })
    ).toEqual([
      { slot: 'display', family: 'Lora', weights: [500], source: '' },
      { slot: '2', family: 'Karla', weights: [], source: '' }
    ]);
    expect(fontsOf({ type: 'brand', fonts: { heading: { weights: [700] } } })).toEqual([]);
    // the database keeps JSON keys sorted, so body arrives before heading: the reading order wins
    expect(
      fontsOf({
        type: 'brand',
        fonts: { body: 'Inter', mono: 'DM Mono', heading: 'Fraunces', eyebrow: 'Karla' }
      }).map((f) => f.slot)
    ).toEqual(['heading', 'body', 'mono', 'eyebrow']);
    expect(fontsOf(null)).toEqual([]);
  });

  it('googleFontOf matches the list without case and refuses everything else', () => {
    expect(googleFontOf('fraunces')).toBe('Fraunces');
    expect(googleFontOf('  Inter ')).toBe('Inter');
    expect(googleFontOf('Berkeley Mono')).toBeNull();
    expect(googleFontOf('Inter; background: url(x)')).toBeNull();
  });

  it('googleFontsHref names the served families once, spaces as plus, and is null when none is served', () => {
    expect(googleFontsHref(fontsOf(northwind))).toBe(
      'https://fonts.googleapis.com/css2?family=Fraunces&family=Inter&display=swap'
    );
    expect(googleFontsHref([{ family: 'Space Grotesk' }, { family: 'space grotesk' }])).toBe(
      'https://fonts.googleapis.com/css2?family=Space+Grotesk&display=swap'
    );
    expect(googleFontsHref([{ family: 'Berkeley Mono' }])).toBeNull();
    expect(googleFontsHref([])).toBeNull();
  });
});

describe('the voice and the extra keys', () => {
  it('voiceOf splits the tones and the words to avoid, and keeps the rest as rows', () => {
    expect(voiceOf(northwind)).toEqual({
      tone: ['plain', 'direct', 'numbers before adjectives'],
      avoid: ['seamless', 'world-class'],
      rest: [
        { key: 'person', value: 'we' },
        { key: 'example', value: 'We moved 41,000 containers in Q2.' }
      ]
    });
    expect(voiceOf({ type: 'brand', voice: 'warm' })).toEqual({ tone: ['warm'], avoid: [], rest: [] });
    expect(voiceOf({ type: 'brand' })).toBeNull();
  });

  it('extraFieldsOf keeps every key the type does not define, nothing dropped', () => {
    expect(extraFieldsOf(northwind, 'brand')).toEqual([
      { key: 'season', value: 'winter 2026' },
      { key: 'owner', value: 'team: marketing; since: 2024' }
    ]);
    // read as a template, the brand's own fields are the extras
    expect(extraFieldsOf(northwind, 'template').map((e) => e.key)).toEqual([
      'fonts',
      'colors',
      'background',
      'shape',
      'motion',
      'voice',
      'season',
      'owner'
    ]);
    expect(extraFieldsOf(null, 'brand')).toEqual([]);
  });
});

describe('who may do what', () => {
  const me = (role: 'owner' | 'admin' | 'member', id = 'u1') => ({ role, user: { id, email: '', name: '' } });
  it('the audience is the deck administrators’, the default the workspace admins’', () => {
    expect(canSetAudience(me('member'), { ownerUserId: 'u1' })).toBe(true);
    expect(canSetAudience(me('member'), { ownerUserId: 'u2' })).toBe(false);
    expect(canSetAudience(me('admin'), { ownerUserId: 'u2' })).toBe(true);
    expect(canSetAudience(me('owner'), { ownerUserId: null })).toBe(true);
    expect(canSetDefault(me('member'))).toBe(false);
    expect(canSetDefault(me('admin'))).toBe(true);
    expect(canSetDefault(me('owner'))).toBe(true);
  });

  it('audienceSentence says who reads it, and the refusals are sentences', () => {
    expect(audienceSentence('private')).toContain('invited');
    expect(audienceSentence('workspace')).toContain('Every member');
    expect(referenceRefusal('default_reference', 'brand')).toContain('default brand');
    expect(referenceRefusal('audience_private', 'template')).toContain('Publish');
    expect(referenceRefusal('forbidden', 'brand')).toBeNull();
    expect(referenceRefusal(undefined, 'brand')).toBeNull();
  });
});

describe('the view kept per section', () => {
  function memory(initial: Record<string, string> = {}) {
    const store = new Map(Object.entries(initial));
    return {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      store
    };
  }

  it('each section has its own key, cards by default, table when remembered', () => {
    expect(viewKeyOf('brand')).toBe('slideless.brands.view');
    expect(viewKeyOf('template')).toBe('slideless.templates.view');
    const s = memory({ 'slideless.brands.view': 'table' });
    expect(readView('brand', s)).toBe('table');
    expect(readView('template', s)).toBe('cards');
    writeView('template', 'table', s);
    expect(s.store.get('slideless.templates.view')).toBe('table');
    expect(readView('template', s)).toBe('table');
  });

  it('a browser that refuses storage still answers cards and never throws', () => {
    const broken = {
      getItem: () => {
        throw new Error('privacy mode');
      },
      setItem: () => {
        throw new Error('privacy mode');
      }
    };
    expect(readView('brand', broken)).toBe('cards');
    expect(() => writeView('brand', 'table', broken)).not.toThrow();
    expect(readView('brand', null)).toBe('cards');
  });
});

describe('the files and the search', () => {
  const entry = (path: string): ManifestEntry => ({
    path,
    sha256: 'a'.repeat(64),
    sizeBytes: 1,
    contentType: 'application/octet-stream'
  });

  it('fileGroupsOf puts assets/ first, sorted, and leaves an empty group out', () => {
    const groups = fileGroupsOf([
      entry('index.html'),
      entry('assets/logo.svg'),
      entry('AGENT.md'),
      entry('assets/fonts/a.woff2')
    ]);
    expect(groups.map((g) => g.id)).toEqual(['assets', 'root']);
    expect(groups[0]!.files.map((f) => f.path)).toEqual(['assets/fonts/a.woff2', 'assets/logo.svg']);
    expect(groups[1]!.files.map((f) => f.path)).toEqual(['AGENT.md', 'index.html']);
    expect(fileGroupsOf([entry('index.html')]).map((g) => g.id)).toEqual(['root']);
    expect(basenameOf('assets/fonts/a.woff2')).toBe('a.woff2');
    expect(basenameOf('AGENT.md')).toBe('AGENT.md');
  });

  it('matchesQuery reads the title and the description, without case', () => {
    const deck = { title: 'House brand · Northwind', reference: northwind };
    expect(matchesQuery(deck, '')).toBe(true);
    expect(matchesQuery(deck, 'northwind')).toBe(true);
    expect(matchesQuery(deck, 'VOICE')).toBe(true);
    expect(matchesQuery(deck, 'harbour')).toBe(false);
    expect(matchesQuery({ title: 'Plain', reference: null }, 'plain')).toBe(true);
  });
});
