import { describe, expect, it } from 'vitest';
import { filterScope, readArchivedFilter, writeArchivedFilter } from './filter';

const me = 'u1:w1';

function memory(initial: Record<string, string> = {}) {
  const kept = { ...initial };
  return {
    kept,
    getItem: (key: string) => kept[key] ?? null,
    setItem: (key: string, value: string) => {
      kept[key] = value;
    }
  };
}

const refusing = {
  getItem: () => {
    throw new Error('storage is off');
  },
  setItem: () => {
    throw new Error('storage is off');
  }
};

describe('the remembered choice of the projects list', () => {
  it('opens on the active projects when nothing is remembered', () => {
    expect(readArchivedFilter(me, memory())).toBe('false');
    expect(readArchivedFilter(me, null)).toBe('false');
  });

  it.each(['false', 'true', 'all'] as const)('reads back %s once written', (choice) => {
    const storage = memory();
    writeArchivedFilter(me, choice, storage);
    expect(readArchivedFilter(me, storage)).toBe(choice);
    // the next person at the same browser opens on their own choice
    expect(readArchivedFilter('u2:w1', storage)).toBe('false');
  });

  it('reads a value it never wrote as the active projects', () => {
    expect(readArchivedFilter(me, memory({ 'projects.archived:u1:w1': 'archived' }))).toBe('false');
    expect(readArchivedFilter(me, memory({ 'projects.archived:u1:w1': '' }))).toBe('false');
  });

  it('survives a browser that refuses storage', () => {
    expect(readArchivedFilter(me, refusing)).toBe('false');
    expect(() => writeArchivedFilter(me, 'true', refusing)).not.toThrow();
    expect(() => writeArchivedFilter(me, 'true', null)).not.toThrow();
  });

  it('names the scope after the person and the open workspace', () => {
    expect(filterScope({ user: { id: 'u1' }, activeWorkspaceId: 'w1' } as never)).toBe('u1:w1');
    expect(filterScope({ user: { id: 'u1' }, activeWorkspaceId: null } as never)).toBe('u1:');
  });
});
