import { beforeEach, describe, expect, it, vi } from 'vitest';
import Presentation from '@lucide/svelte/icons/presentation';

// Plain vitest has no SvelteKit runtime; the deck components the contribution carries import it.
vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/'), params: {} } }));
vi.mock('$app/navigation', () => ({ goto: vi.fn(), invalidateAll: vi.fn(), onNavigate: vi.fn() }));
vi.mock('$app/environment', () => ({ browser: false, dev: false, building: false }));

const presentations = vi.fn();
const defaultReference = vi.fn();
vi.mock('$lib/api', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  api: { presentations, defaultReference }
}));

const { tool } = await import('./index');
const { behindWorkspace, buildNav, phoneTabs } = await import('$lib/nav');
const { actionFamilies } = await import('$lib/components/audit/audit-filters');
const { createDeckOverview } = await import('./overview.svelte');
const { listScope } = await import('$lib/stores/pagedList.svelte');

/**
 * What Slideless hands the shell (PRDCT-2532). The boundary test holds the
 * shape of the split; this one holds its content: an entry, a tab, a route or
 * an action dropped from the contribution changes a page and nothing else
 * would say so.
 */
describe('the menu', () => {
  it('a member gets decks, brands and templates, right after the overview', () => {
    const nav = buildNav({ role: 'member', origin: 'local' });
    expect(nav.primary.map((i) => [i.id, i.href, i.pattern])).toEqual([
      ['overview', '/', 'rings'],
      ['decks', '/decks', 'slides'],
      ['brands', '/brands', 'aurora'],
      ['templates', '/templates', 'crosses']
    ]);
    expect(nav.primary[1].icon).toBe(Presentation);
    for (const item of nav.primary.slice(1)) expect(item.title && item.blurb).toBeTruthy();
  });

  it('a guest reads no workspace reference: decks only', () => {
    expect(tool.nav({ role: 'member', origin: 'guest' }).map((i) => i.id)).toEqual(['decks']);
    expect(buildNav({ role: 'member', origin: 'guest' }).primary.map((i) => i.id)).toEqual([
      'overview',
      'decks'
    ]);
  });

  it('a phone keeps decks as a thumb tab and folds the references behind the workspace entry', () => {
    const nav = buildNav({ role: 'owner', origin: 'local' });
    expect(phoneTabs(nav).map((i) => i.id)).toEqual(['overview', 'decks', 'workspace', 'settings']);
    expect(behindWorkspace(nav).map((i) => i.id)).toEqual([
      'brands',
      'templates',
      'members',
      'api-keys',
      'files',
      'audit'
    ]);
    const workspace = phoneTabs(nav).find((i) => i.id === 'workspace')!;
    expect(workspace.also).toEqual(expect.arrayContaining(['/brands', '/templates']));
    expect(workspace.also).not.toContain('/decks');
  });
});

describe('the gate', () => {
  it('the collaborator claim page turns like the gate’s own pages', () => {
    expect(tool.gateRoutes).toEqual(['collab']);
  });
});

describe('the audit vocabulary', () => {
  it('names every action the deck routes write, sorted', () => {
    expect(tool.audit.actions).toHaveLength(20);
    expect(tool.audit.actions).toEqual([...tool.audit.actions].sort());
    expect(tool.audit.actions.filter((a) => a.startsWith('presentation.'))).toHaveLength(19);
    for (const action of [
      'collaborator.claim',
      'presentation.version_commit',
      'presentation.share_token_send'
    ])
      expect(tool.audit.actions).toContain(action);
  });

  it('the filter panel offers the presentation family before a single row has loaded', () => {
    const families = actionFamilies([...tool.audit.actions]);
    expect(families.find((f) => f.family === 'presentation')?.actions).toHaveLength(19);
    expect(families.find((f) => f.family === 'collaborator')?.actions).toEqual(['collaborator.claim']);
  });

  it('names its resource types', () => {
    expect(tool.audit.resourceTypes).toEqual([
      'annotation',
      'collaborator',
      'form_response',
      'presentation',
      'share_token',
      'upload_session'
    ]);
  });

  it('draws a deck line with the presentation drawing', () => {
    const glyph = (kind: string) => tool.audit.glyphs.find((g) => g.test.test(kind))?.icon;
    expect(glyph('presentation presentation.create')).toBe(Presentation);
    expect(glyph('share_token presentation.share_token_create')).toBe(Presentation);
    expect(glyph('api_key apikey.create')).toBeUndefined();
  });
});

describe('the list to warm', () => {
  beforeEach(() => presentations.mockReset());

  it('asks for the first page of decks, the call the decks page remembers', () => {
    presentations.mockResolvedValue({ presentations: [], nextCursor: null });
    tool.warm();
    expect(presentations).toHaveBeenCalledTimes(1);
    expect(presentations).toHaveBeenCalledWith({});
  });
});

describe('the overview’s deck pieces', () => {
  const deck = (id: string, totalViews: number, updatedAt: string) => ({
    id,
    totalViews,
    updatedAt,
    reference: null
  });
  const facts = (isGuest = false) => ({ isGuest: () => isGuest, workspaceName: () => 'Northwind' });

  let scope = 0;
  beforeEach(() => {
    presentations.mockReset();
    defaultReference.mockReset();
    // the store remembers a list under its name for the next visit: a new scope forgets it
    listScope(`overview-test-${++scope}`);
  });

  it('says nothing while it loads, so the shell says its own sentence', async () => {
    presentations.mockReturnValue(new Promise(() => {}));
    defaultReference.mockReturnValue(new Promise(() => {}));
    const model = createDeckOverview(facts());
    model.load();
    expect(model.lede).toBeNull();
    expect(model.stats.map((s) => [s.id, s.value, s.href, s.drawing])).toEqual([
      ['decks', null, '/decks', 'decks'],
      ['opens', null, '/decks', 'opens']
    ]);
    expect(model.brand).toBeUndefined();
  });

  it('counts the decks and their opens, and keeps the three latest', async () => {
    presentations.mockResolvedValue({
      presentations: [
        deck('a', 2, '2026-09-01T00:00:00Z'),
        deck('b', 5, '2026-09-04T00:00:00Z'),
        deck('c', 0, '2026-09-02T00:00:00Z'),
        deck('d', 1, '2026-09-03T00:00:00Z')
      ],
      nextCursor: null
    });
    defaultReference.mockResolvedValue(null);
    const model = createDeckOverview(facts());
    model.load();
    await vi.waitFor(() => expect(model.lede).not.toBeNull());
    expect(model.lede).toBe('4 decks in Northwind, opened 8 times.');
    expect(model.stats.map((s) => s.value)).toEqual(['4', '8']);
    expect(model.recentDecks.map((d) => d.id)).toEqual(['b', 'd', 'c']);
    await vi.waitFor(() => expect(model.brand).toBeNull());
  });

  it('an empty workspace gets the invitation to push, and a guest asks for no brand', async () => {
    presentations.mockResolvedValue({ presentations: [], nextCursor: null });
    const model = createDeckOverview(facts(true));
    model.load();
    await vi.waitFor(() => expect(model.lede).not.toBeNull());
    expect(model.lede).toBe('Nothing shared yet. Your first deck is one push away.');
    expect(defaultReference).not.toHaveBeenCalled();
    expect(model.isGuest).toBe(true);
  });
});
