/**
 * Whether the dark token set is on, as a reactive value. The theme boot script
 * in app.html sets `.dark` on <html> before first paint from the person's
 * choice (`slideless.theme`: light, dark, or nothing for the system's); the
 * account page's theme control is the one writer of that choice, and this
 * store is the one place the class is toggled afterwards, so a canvas that
 * paints with a palette (the page field, the pattern cards) watches it here
 * instead of guessing from the media query.
 */
export type ThemeMode = 'system' | 'light' | 'dark';
const MODE_KEY = 'slideless.theme';

/**
 * The paper: the ground scale the rail, the bars, the cards and the plates
 * are painted with, one of the brand's five (the website's recipe GROUNDS).
 * The person's, in this browser, like the mode: the boot script in app.html
 * reads `slideless.paper` and sets `data-paper` on <html> before first paint,
 * and tokens.css rewrites the ground side per scale. Creme is the default:
 * no stored value, or one this list does not know, is creme. The dark set
 * is one scale and wins over any paper.
 */
export const PAPER_KEYS = ['creme', 'graphite', 'porcelain', 'stone', 'fog'] as const;
export type PaperKey = (typeof PAPER_KEYS)[number];
export const DEFAULT_PAPER: PaperKey = 'creme';
const PAPER_KEY = 'slideless.paper';
export function isPaperKey(key: unknown): key is PaperKey {
  return typeof key === 'string' && (PAPER_KEYS as readonly string[]).includes(key);
}
/** Each paper's ground and hairline: the swatch the account page draws, the base the page field mixes from. */
export const PAPER_GROUNDS: Record<PaperKey, { ground: string; hairline: string }> = {
  creme: { ground: '#F7F4EC', hairline: '#E0DACA' },
  graphite: { ground: '#F7F6F4', hairline: '#DCDBD6' },
  porcelain: { ground: '#FCFBF8', hairline: '#E2E0D7' },
  stone: { ground: '#F4F1EB', hairline: '#D8D3C7' },
  fog: { ground: '#F7F8F8', hairline: '#D9DDDD' }
};

class ThemeWatch {
  dark = $state(false);
  /** The person's choice, this browser's. */
  mode = $state<ThemeMode>('system');
  /** The person's paper, this browser's. */
  paper = $state<PaperKey>(DEFAULT_PAPER);
  #started = false;

  /** Idempotent; called from a component's effect, so only ever in a browser. */
  start(): void {
    if (this.#started || typeof document === 'undefined') return;
    this.#started = true;
    const root = document.documentElement;
    this.dark = root.classList.contains('dark');
    try {
      const stored = localStorage.getItem(MODE_KEY);
      this.mode = stored === 'dark' || stored === 'light' ? stored : 'system';
    } catch {
      /* privacy modes: the system's */
    }
    try {
      const stored = localStorage.getItem(PAPER_KEY);
      this.paper = isPaperKey(stored) ? stored : DEFAULT_PAPER;
    } catch {
      /* privacy modes: creme */
    }
    new MutationObserver(() => {
      this.dark = root.classList.contains('dark');
    }).observe(root, { attributes: true, attributeFilter: ['class'] });
    // the system's choice, followed while no choice of the person's overrides it
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      if (this.mode === 'system') root.classList.toggle('dark', e.matches);
    });
  }

  /** The person's choice: applied at once, kept in this browser (the boot script reads it). */
  setMode(mode: ThemeMode): void {
    this.mode = mode;
    try {
      if (mode === 'system') localStorage.removeItem(MODE_KEY);
      else localStorage.setItem(MODE_KEY, mode);
    } catch {
      /* not persisted, still applied */
    }
    const dark =
      mode === 'dark' || (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark', dark);
  }

  /** The person's paper: applied at once, kept in this browser (the boot script reads it). */
  setPaper(paper: PaperKey): void {
    const next = isPaperKey(paper) ? paper : DEFAULT_PAPER;
    this.paper = next;
    try {
      if (next === DEFAULT_PAPER) localStorage.removeItem(PAPER_KEY);
      else localStorage.setItem(PAPER_KEY, next);
    } catch {
      /* not persisted, still applied */
    }
    const root = document.documentElement;
    if (next === DEFAULT_PAPER) root.removeAttribute('data-paper');
    else root.setAttribute('data-paper', next);
  }
}

export const theme = new ThemeWatch();

/** The palette a canvas paints with: its dark twin when the dark set is on and one exists. */
export function paletteFor(name: string, dark: boolean, known: Record<string, unknown>): string {
  return dark && known[`${name}-dark`] ? `${name}-dark` : name;
}
