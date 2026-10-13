import { describe, expect, it } from 'vitest';
import { appFact, appSentence, foldRows, hereFirst } from './apps';
import { en } from './i18n/en';
import { fr } from './i18n/fr';

/** The Apps page's words for one card: the sentence per known tool, the operator's, the generic; the facts. */
describe('appSentence', () => {
  it('says what a known tool is, whatever the file says', () => {
    expect(appSentence({ slug: 'finance', description: 'ignored' })).toBe(en['apps.desc.finance']);
    expect(appSentence({ slug: 'steward', description: null })).toBe(en['apps.desc.steward']);
  });

  it('gives this tool’s own card its own sentence, never the generic one', () => {
    expect(appSentence({ slug: 'wiki', description: null, current: true })).toBe(en['apps.descHere']);
    expect(appSentence({ slug: 'meet', description: null, current: true })).toBe(en['apps.desc.meet']);
  });

  it('takes the operator’s description for another tool, else a generic sentence', () => {
    expect(appSentence({ slug: 'wiki', description: 'Our notes.' })).toBe('Our notes.');
    expect(appSentence({ slug: 'wiki', description: null })).toBe('Another tool of your organization.');
  });

  it('has every sentence in both languages, the French with its typography', () => {
    const keys = Object.keys(en).filter((k) => k.startsWith('apps.'));
    expect(Object.keys(fr).filter((k) => k.startsWith('apps.'))).toEqual(keys);
    expect(fr['apps.desc.finance']).toContain('livre :');
    for (const key of keys) expect(fr[key as keyof typeof fr], key).not.toMatch(/ [?!:;]|'/);
  });
});

describe('appFact', () => {
  it('is null when the list says nothing of the person’s use', () => {
    expect(appFact({ firstUsedAt: null, lastUsedAt: null })).toBeNull();
  });

  it('says since when, and when last, joined', () => {
    expect(appFact({ firstUsedAt: '2026-01-15T10:00:00Z', lastUsedAt: '2026-10-10T10:00:00Z' })).toBe(
      'Connected since Jan 15, 2026 · last used Oct 10, 2026'
    );
    expect(appFact({ firstUsedAt: null, lastUsedAt: '2026-10-10T10:00:00Z' })).toBe('Last used Oct 10, 2026');
  });
});

describe('hereFirst', () => {
  it('puts this tool’s own card first and keeps the others in the list’s order', () => {
    const list = [
      { slug: 'crm', current: false },
      { slug: 'wiki', current: true },
      { slug: 'meet', current: false }
    ];
    expect(hereFirst(list).map((a) => a.slug)).toEqual(['wiki', 'crm', 'meet']);
  });
});

describe('foldRows', () => {
  const entry = (slug: string, name: string, current = false) => ({
    slug,
    name,
    launchUrl: `https://${slug}.example.com`,
    description: null,
    connected: false,
    firstUsedAt: null,
    lastUsedAt: null,
    current
  });

  it('puts the account first, then the tools in the list’s order, named without the company in front', () => {
    const rows = foldRows({
      apps: [entry('finance', 'Antasphere Finance'), entry('slideless', 'Slideless', true)],
      hub: { url: 'https://account.example.com', name: 'Antasphere Account' }
    });
    expect(rows.map((r) => [r.key, r.name])).toEqual([
      ['hub', 'Account'],
      ['finance', 'Finance'],
      ['slideless', 'Slideless']
    ]);
  });

  it('gives every other row its address, and this tool’s own row none: the reader is already here', () => {
    const rows = foldRows({
      apps: [entry('finance', 'Antasphere Finance'), entry('slideless', 'Slideless', true)],
      hub: null
    });
    expect(rows.find((r) => r.key === 'finance')).toMatchObject({
      href: 'https://finance.example.com',
      current: false
    });
    expect(rows.find((r) => r.key === 'slideless')).toMatchObject({ href: null, current: true });
  });

  it('lists no account row when the instance knows none', () => {
    expect(foldRows({ apps: [], hub: null })).toEqual([]);
  });
});
