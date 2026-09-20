import { describe, expect, it } from 'vitest';
import { readArchivedFilter, writeArchivedFilter } from './filter';

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
    expect(readArchivedFilter(memory())).toBe('false');
    expect(readArchivedFilter(null)).toBe('false');
  });

  it.each(['false', 'true', 'all'] as const)('reads back %s once written', (choice) => {
    const storage = memory();
    writeArchivedFilter(choice, storage);
    expect(readArchivedFilter(storage)).toBe(choice);
  });

  it('reads a value it never wrote as the active projects', () => {
    expect(readArchivedFilter(memory({ 'projects.archived': 'archived' }))).toBe('false');
    expect(readArchivedFilter(memory({ 'projects.archived': '' }))).toBe('false');
  });

  it('survives a browser that refuses storage', () => {
    expect(readArchivedFilter(refusing)).toBe('false');
    expect(() => writeArchivedFilter('true', refusing)).not.toThrow();
    expect(() => writeArchivedFilter('true', null)).not.toThrow();
  });
});
