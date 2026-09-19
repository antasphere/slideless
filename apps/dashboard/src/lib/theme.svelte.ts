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

class ThemeWatch {
  dark = $state(false);
  /** The person's choice, this browser's. */
  mode = $state<ThemeMode>('system');
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
}

export const theme = new ThemeWatch();

/** The palette a canvas paints with: its dark twin when the dark set is on and one exists. */
export function paletteFor(name: string, dark: boolean, known: Record<string, unknown>): string {
  return dark && known[`${name}-dark`] ? `${name}-dark` : name;
}
