import { describe, expect, it } from 'vitest';
import {
  administersDeck,
  canUnlinkFrom,
  projectFilterKey,
  projectsToAddTo,
  readProjectFilter,
  rememberedListName,
  standingFilter,
  writeProjectFilter
} from './project-filter';

function memory(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (k: string) => data[k] ?? null,
    setItem: (k: string, v: string) => void (data[k] = v),
    removeItem: (k: string) => void delete data[k]
  };
}
const refusing = {
  getItem: () => {
    throw new Error('denied');
  },
  setItem: () => {
    throw new Error('denied');
  },
  removeItem: () => {
    throw new Error('denied');
  }
};

describe('the remembered project filter', () => {
  it('keeps one key per page', () => {
    expect(projectFilterKey('decks')).toBe('slideless.decks.project');
    expect(projectFilterKey('brands')).toBe('slideless.brands.project');
    expect(projectFilterKey('templates')).toBe('slideless.templates.project');
  });

  it('reads back what it wrote, page by page', () => {
    const storage = memory();
    writeProjectFilter('decks', 'p1', storage);
    writeProjectFilter('brands', 'p2', storage);
    expect(readProjectFilter('decks', storage)).toBe('p1');
    expect(readProjectFilter('brands', storage)).toBe('p2');
    expect(readProjectFilter('templates', storage)).toBeNull();
  });

  it('forgets on null: the key is removed, not emptied', () => {
    const storage = memory({ 'slideless.decks.project': 'p1' });
    writeProjectFilter('decks', null, storage);
    expect(storage.data).toEqual({});
    expect(readProjectFilter('decks', storage)).toBeNull();
  });

  it('reads an empty value as no filter', () => {
    expect(readProjectFilter('decks', memory({ 'slideless.decks.project': '' }))).toBeNull();
  });

  it('lives without storage, and with a storage that refuses', () => {
    expect(readProjectFilter('decks', null)).toBeNull();
    expect(() => writeProjectFilter('decks', 'p1', null)).not.toThrow();
    expect(readProjectFilter('decks', refusing)).toBeNull();
    expect(() => writeProjectFilter('decks', 'p1', refusing)).not.toThrow();
    expect(() => writeProjectFilter('decks', null, refusing)).not.toThrow();
  });
});

describe('the list a filter is remembered under', () => {
  it('keeps the bare name with no filter, the one the shell warms', () => {
    expect(rememberedListName('decks', null)).toBe('decks');
  });
  it('is one name per project', () => {
    expect(rememberedListName('decks', 'p1')).toBe('decks.p1');
    expect(rememberedListName('references.brand', 'p1')).toBe('references.brand.p1');
  });
});

describe('a remembered project the reader no longer reads', () => {
  it('stands while the project is readable', () => {
    expect(standingFilter('p1', [{ id: 'p1' }, { id: 'p2' }])).toBe('p1');
  });
  it('falls back to all projects when it is gone', () => {
    expect(standingFilter('p3', [{ id: 'p1' }])).toBeNull();
    expect(standingFilter('p1', [])).toBeNull();
    expect(standingFilter(null, [{ id: 'p1' }])).toBeNull();
  });
});

describe('who links and unlinks a deck', () => {
  const me = (role: 'owner' | 'admin' | 'member', id = 'u1') => ({ role, user: { id } }) as never;
  const project = (
    id: string,
    myRole: 'manager' | 'editor' | 'viewer',
    archivedAt: string | null = null
  ) => ({
    id,
    myRole,
    archivedAt
  });

  it('the deck owner and the workspace admins administer a deck', () => {
    expect(administersDeck(me('member'), { ownerUserId: 'u1' })).toBe(true);
    expect(administersDeck(me('member'), { ownerUserId: 'u2' })).toBe(false);
    expect(administersDeck(me('member'), { ownerUserId: null })).toBe(false);
    expect(administersDeck(me('admin'), { ownerUserId: 'u2' })).toBe(true);
    expect(administersDeck(me('owner'), { ownerUserId: null })).toBe(true);
  });

  it('a deck is added where the reader writes, never where it already is', () => {
    const readable = [
      project('a', 'manager'),
      project('b', 'editor'),
      project('c', 'viewer'),
      project('d', 'manager', '2026-06-30T17:00:00.000Z'),
      project('e', 'editor')
    ];
    expect(projectsToAddTo(readable, [{ id: 'e' }]).map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('unlinking is for who administers the deck, or manages the project', () => {
    const readable = [project('a', 'manager'), project('b', 'editor'), project('c', 'viewer')];
    expect(canUnlinkFrom('b', readable, true)).toBe(true);
    expect(canUnlinkFrom('a', readable, false)).toBe(true);
    expect(canUnlinkFrom('b', readable, false)).toBe(false);
    expect(canUnlinkFrom('c', readable, false)).toBe(false);
  });

  it('an archived project, or one missing from the readable list, takes no change', () => {
    expect(canUnlinkFrom('z', [project('a', 'manager')], true)).toBe(false);
    expect(canUnlinkFrom('a', [project('a', 'manager', '2026-06-30T17:00:00.000Z')], true)).toBe(false);
  });
});
