import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The person's paper (PRDCT-4189): the theme store keeps it in this browser
 * under `slideless.paper`, sets `data-paper` on <html>, and reads anything it
 * does not know as creme. No DOM in this suite: <html>, localStorage and the
 * two browser APIs `start` touches are stubbed, and the module is imported
 * fresh per test so its `start` runs again.
 */

class FakeRoot {
  attrs = new Map<string, string>();
  classes = new Set<string>();
  classList = {
    contains: (c: string) => this.classes.has(c),
    toggle: (c: string, on?: boolean) => {
      const next = on ?? !this.classes.has(c);
      if (next) this.classes.add(c);
      else this.classes.delete(c);
      return next;
    }
  };
  setAttribute(name: string, value: string) {
    this.attrs.set(name, value);
  }
  removeAttribute(name: string) {
    this.attrs.delete(name);
  }
  getAttribute(name: string) {
    return this.attrs.get(name) ?? null;
  }
}

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    map
  };
}

/** localStorage as a privacy mode makes it: every call throws. */
const lockedStorage = {
  getItem: () => {
    throw new Error('SecurityError');
  },
  setItem: () => {
    throw new Error('SecurityError');
  },
  removeItem: () => {
    throw new Error('SecurityError');
  }
};

let root: FakeRoot;

function stubBrowser(storage: unknown) {
  root = new FakeRoot();
  vi.stubGlobal('document', { documentElement: root });
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal(
    'MutationObserver',
    class {
      observe() {}
    }
  );
  vi.stubGlobal('window', {
    matchMedia: () => ({ matches: false, addEventListener: () => {} })
  });
}

async function freshTheme() {
  vi.resetModules();
  return import('./theme.svelte');
}

// The first import of the runes module compiles it, which can take more than a
// test's five seconds on a loaded machine (a full turbo run, a tool's CI). Warm
// it once here, with room, so each test's fresh import only re-evaluates it.
beforeAll(async () => {
  stubBrowser(memoryStorage());
  await import('./theme.svelte');
  vi.unstubAllGlobals();
}, 60_000);
beforeEach(() => stubBrowser(memoryStorage()));
afterEach(() => vi.unstubAllGlobals());

describe('the paper keys', () => {
  it('are the five brand grounds, creme first and the default', async () => {
    const { PAPER_KEYS, DEFAULT_PAPER, PAPER_GROUNDS } = await freshTheme();
    expect(PAPER_KEYS).toEqual(['creme', 'graphite', 'porcelain', 'stone', 'fog']);
    expect(DEFAULT_PAPER).toBe('creme');
    expect(Object.keys(PAPER_GROUNDS)).toEqual([...PAPER_KEYS]);
  });

  it('the guard takes the five and nothing else', async () => {
    const { isPaperKey } = await freshTheme();
    for (const k of ['creme', 'graphite', 'porcelain', 'stone', 'fog']) expect(isPaperKey(k)).toBe(true);
    for (const k of ['Fog', 'paper', 'dark', '', null, undefined, 3, {}]) expect(isPaperKey(k)).toBe(false);
  });
});

describe('theme.paper', () => {
  it('starts on creme when nothing is stored', async () => {
    const { theme } = await freshTheme();
    theme.start();
    expect(theme.paper).toBe('creme');
  });

  it('starts on the stored paper', async () => {
    stubBrowser(memoryStorage({ 'slideless.paper': 'stone' }));
    const { theme } = await freshTheme();
    theme.start();
    expect(theme.paper).toBe('stone');
  });

  it('reads an unknown stored value as creme', async () => {
    stubBrowser(memoryStorage({ 'slideless.paper': 'midnight' }));
    const { theme } = await freshTheme();
    theme.start();
    expect(theme.paper).toBe('creme');
  });

  it('reads creme when the storage refuses (privacy modes)', async () => {
    stubBrowser(lockedStorage);
    const { theme } = await freshTheme();
    expect(() => theme.start()).not.toThrow();
    expect(theme.paper).toBe('creme');
  });
});

describe('theme.setPaper', () => {
  it('applies the paper on <html> and keeps it in this browser', async () => {
    const storage = memoryStorage();
    stubBrowser(storage);
    const { theme } = await freshTheme();
    theme.setPaper('fog');
    expect(theme.paper).toBe('fog');
    expect(root.getAttribute('data-paper')).toBe('fog');
    expect(storage.map.get('slideless.paper')).toBe('fog');
  });

  it('back to creme removes the attribute and the stored value', async () => {
    const storage = memoryStorage({ 'slideless.paper': 'graphite' });
    stubBrowser(storage);
    root.setAttribute('data-paper', 'graphite');
    const { theme } = await freshTheme();
    theme.setPaper('creme');
    expect(theme.paper).toBe('creme');
    expect(root.getAttribute('data-paper')).toBeNull();
    expect(storage.map.has('slideless.paper')).toBe(false);
  });

  it('an unknown paper falls back to creme instead of writing it', async () => {
    const storage = memoryStorage({ 'slideless.paper': 'stone' });
    stubBrowser(storage);
    const { theme } = await freshTheme();
    theme.setPaper('midnight' as never);
    expect(theme.paper).toBe('creme');
    expect(root.getAttribute('data-paper')).toBeNull();
    expect(storage.map.has('slideless.paper')).toBe(false);
  });

  it('still applies when the storage refuses', async () => {
    stubBrowser(lockedStorage);
    const { theme } = await freshTheme();
    expect(() => theme.setPaper('porcelain')).not.toThrow();
    expect(theme.paper).toBe('porcelain');
    expect(root.getAttribute('data-paper')).toBe('porcelain');
  });

  it('leaves the light or dark choice alone', async () => {
    const storage = memoryStorage({ 'slideless.theme': 'dark' });
    stubBrowser(storage);
    root.classList.toggle('dark', true);
    const { theme } = await freshTheme();
    theme.start();
    theme.setPaper('stone');
    expect(root.classList.contains('dark')).toBe(true);
    expect(storage.map.get('slideless.theme')).toBe('dark');
    expect(theme.mode).toBe('dark');
  });
});
