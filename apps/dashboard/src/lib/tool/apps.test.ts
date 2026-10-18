import { describe, expect, it } from 'vitest';
import { TOOL_DRAWINGS, TOOL_ICONS } from '@antasphere/chassis-contract';
import { appFact, appSentence, hereFirst, shortName, sortApps } from './apps';
import { TOOL_ICON_COMPONENTS, toolIconComponent } from './components/apps/ToolIcon.svelte';
import { DRAWN_KINDS } from './components/apps/AppDrawing.svelte';
import { en } from './i18n/en';
import { fr } from './i18n/fr';

/** The Apps page's words for one card: the registry's sentence, this tool's own, the generic; the facts. */
describe('appSentence', () => {
  it('says what the registry says of a tool, whatever its slug', () => {
    expect(appSentence({ descriptor: { description: 'The ledger.' } })).toBe('The ledger.');
    expect(appSentence({ descriptor: { description: 'The ledger.' }, current: true })).toBe('The ledger.');
  });

  it('gives this tool’s own card its own sentence when the registry says nothing, else the generic one', () => {
    expect(appSentence({ descriptor: undefined, current: true })).toBe(en['apps.descHere']);
    expect(appSentence({ descriptor: { icon: 'mail' }, current: true })).toBe(en['apps.descHere']);
    expect(appSentence({ descriptor: undefined })).toBe('Another tool of your organization.');
  });

  it('knows no tool by name: every sentence of the page is in both languages, the French with its typography', () => {
    const keys = Object.keys(en).filter((k) => k.startsWith('apps.'));
    expect(keys.some((k) => k.startsWith('apps.desc.'))).toBe(false);
    expect(Object.keys(fr).filter((k) => k.startsWith('apps.'))).toEqual(keys);
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

/** The order the fold and the page show the tools in: by name, the company's prefix ignored. */
describe('sortApps and hereFirst', () => {
  const list = [
    { slug: 'sign', name: 'Antasphere Sign', current: false },
    { slug: 'exos', name: 'Exos', current: false },
    { slug: 'mail', name: 'Antasphere Mail', current: false },
    { slug: 'wiki', name: 'Wiki', current: true },
    { slug: 'finance', name: 'antasphère finance', current: false }
  ];

  it('sorts by short name, case and accents ignored, whatever the list’s order', () => {
    expect(sortApps(list).map((a) => a.slug)).toEqual(['exos', 'finance', 'mail', 'sign', 'wiki']);
    expect(list[0]!.slug).toBe('sign');
  });

  it('puts this tool’s own card first and keeps the others by name', () => {
    expect(hereFirst(list).map((a) => a.slug)).toEqual(['wiki', 'exos', 'finance', 'mail', 'sign']);
  });

  it('drops the company prefix for the short name only', () => {
    expect(shortName('Antasphere Finance')).toBe('Finance');
    expect(shortName('Exos')).toBe('Exos');
  });
});

/** Every icon and every drawing the contract allows has a component here, and nothing else is claimed. */
describe('the icon map, the drawings and the contract agree', () => {
  it('one icon component per name of TOOL_ICONS, the grid for an unknown or missing name', () => {
    expect(Object.keys(TOOL_ICON_COMPONENTS).sort()).toEqual([...TOOL_ICONS].sort());
    expect(toolIconComponent(undefined)).toBe(TOOL_ICON_COMPONENTS['layout-grid']);
    expect(toolIconComponent('skull')).toBe(TOOL_ICON_COMPONENTS['layout-grid']);
    expect(toolIconComponent('mail')).toBe(TOOL_ICON_COMPONENTS.mail);
  });

  it('one drawing per name of TOOL_DRAWINGS', () => {
    expect([...DRAWN_KINDS].sort()).toEqual([...TOOL_DRAWINGS].sort());
  });
});
