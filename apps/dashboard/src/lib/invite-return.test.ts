import { describe, expect, it } from 'vitest';
import { ACCEPT_MARK_TTL_MS, markAcceptOnReturn, takeAcceptOnReturn } from './invite-return';

function memoryStore() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key)
  };
}

describe('the acceptance on the return from the sign-in', () => {
  it('nothing is taken when nothing was marked: a link alone never accepts', () => {
    expect(takeAcceptOnReturn('tok', 1_000, memoryStore())).toBe(false);
  });

  it('a mark is taken once, then it is gone', () => {
    const store = memoryStore();
    markAcceptOnReturn('tok', 1_000, store);
    expect(takeAcceptOnReturn('tok', 2_000, store)).toBe(true);
    expect(takeAcceptOnReturn('tok', 2_001, store)).toBe(false);
    expect(store.values.size).toBe(0);
  });

  it('a mark names one invitation: another invitation finds none, and leaves it in place', () => {
    const store = memoryStore();
    markAcceptOnReturn('asked-for', 1_000, store);
    expect(takeAcceptOnReturn('another', 2_000, store)).toBe(false);
    expect(takeAcceptOnReturn('asked-for', 2_000, store)).toBe(true);
  });

  it('a mark older than ten minutes accepts nothing, and is removed', () => {
    const store = memoryStore();
    markAcceptOnReturn('tok', 1_000, store);
    expect(takeAcceptOnReturn('tok', 1_000 + ACCEPT_MARK_TTL_MS, store)).toBe(false);
    expect(store.values.size).toBe(0);
    markAcceptOnReturn('tok', 1_000, store);
    expect(takeAcceptOnReturn('tok', 1_000 + ACCEPT_MARK_TTL_MS - 1, store)).toBe(true);
  });

  it('a value that is not a time accepts nothing', () => {
    const store = memoryStore();
    store.setItem('platform.inviteAccept.tok', 'yes');
    expect(takeAcceptOnReturn('tok', 1_000, store)).toBe(false);
  });

  it('no storage, or a storage that throws: no mark and no acceptance', () => {
    expect(() => markAcceptOnReturn('tok', 1_000, null)).not.toThrow();
    expect(takeAcceptOnReturn('tok', 1_000, null)).toBe(false);
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => undefined
    };
    expect(() => markAcceptOnReturn('tok', 1_000, broken)).not.toThrow();
    expect(takeAcceptOnReturn('tok', 1_000, broken)).toBe(false);
  });
});
