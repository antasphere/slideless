/**
 * The signed-in app scrolls in the shell's `<main class="app-main">`, never in
 * the window. SvelteKit resets (and on back and forward restores) the WINDOW's
 * scroll on a navigation, so without this every page opened at the scroll
 * position the previous one was left at: the pages read as one shared scroll
 * (reported on the brand kit, 2026-11-05).
 *
 * `followNavigation` puts the window's behaviour back on that element: a new
 * page opens at its top (or at its `#anchor`), back and forward land where the
 * page was left, and a change of the query string alone (a filter, a sort, a
 * selection inside one page) keeps the position. `scrollAfter` is the decision,
 * pure, so it is tested without a browser (`mainScroll.test.ts`).
 */
import { afterNavigate, beforeNavigate } from '$app/navigation';

/** What a navigation does to the scroll: nothing, a position, or an anchor. */
export type ScrollMove = { kind: 'keep' } | { kind: 'top'; to: number } | { kind: 'anchor'; id: string };

/** The history entry a position is remembered under: the page and its query, not the anchor. */
export const scrollKey = (url: URL) => url.pathname + url.search;

export function scrollAfter(
  nav: { type: string; from: URL | null; to: URL | null },
  saved: ReadonlyMap<string, number>
): ScrollMove {
  const { type, from, to } = nav;
  // the first load (`enter`) and a change of the query on the same page keep where they are
  if (type === 'enter' || !from || !to || from.pathname === to.pathname) return { kind: 'keep' };
  if (type === 'popstate') return { kind: 'top', to: saved.get(scrollKey(to)) ?? 0 };
  if (to.hash.length > 1) return { kind: 'anchor', id: decodeURIComponent(to.hash.slice(1)) };
  return { kind: 'top', to: 0 };
}

/** Call once from the component that owns the scroll container, during its init. */
export function followNavigation(root: () => HTMLElement | undefined): void {
  const saved = new Map<string, number>();

  beforeNavigate(({ from }) => {
    const el = root();
    if (from && el) saved.set(scrollKey(from.url), el.scrollTop);
  });

  afterNavigate(({ from, to, type }) => {
    const el = root();
    if (!el) return;
    const move = scrollAfter({ type, from: from?.url ?? null, to: to?.url ?? null }, saved);
    if (move.kind === 'top') el.scrollTop = move.to;
    else if (move.kind === 'anchor') {
      const target = document.getElementById(move.id);
      if (target) target.scrollIntoView({ block: 'start' });
      else el.scrollTop = 0;
    }
  });
}
