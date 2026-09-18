/**
 * Whether the dark token set is on, as a reactive value. The theme boot script
 * in app.html sets `.dark` on <html> before first paint; nothing else in the
 * app owns that class, so a canvas that paints with a palette (the page field,
 * the pattern cards) watches it here instead of guessing from the media query.
 */
class ThemeWatch {
  dark = $state(false);
  #started = false;

  /** Idempotent; called from a component's effect, so only ever in a browser. */
  start(): void {
    if (this.#started || typeof document === 'undefined') return;
    this.#started = true;
    const root = document.documentElement;
    this.dark = root.classList.contains('dark');
    new MutationObserver(() => {
      this.dark = root.classList.contains('dark');
    }).observe(root, { attributes: true, attributeFilter: ['class'] });
  }
}

export const theme = new ThemeWatch();

/** The palette a canvas paints with: its dark twin when the dark set is on and one exists. */
export function paletteFor(name: string, dark: boolean, known: Record<string, unknown>): string {
  return dark && known[`${name}-dark`] ? `${name}-dark` : name;
}
