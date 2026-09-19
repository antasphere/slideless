/**
 * Rune-based cursor-paginated list over an SDK-shaped page fetcher.
 *
 * Usage (local to a page component):
 *   const list = createPagedList<FileInfo>(async (p) => {
 *     const { files, nextCursor } = await api.files(p);
 *     return { items: files, nextCursor };
 *   });
 *
 * In component:
 *   list.load();       // first page (in $effect)
 *   list.loadMore();   // append the next page while nextCursor is non-null
 *   list.refresh();    // back to page 1 (post-mutation invalidate)
 *   list.items         // reactive: accumulated rows
 *   list.nextCursor    // reactive: null when everything is loaded
 *
 * Items are only assigned on success — a failed load/refresh keeps whatever
 * is currently shown and sets `error` (the keep-stale-on-error contract the
 * page render pattern relies on).
 *
 * `remember: '<name>'` keeps the list's first page for the session, under that
 * name. A page always used to open on nothing, so every visit went table →
 * empty → table, however fast the server; a remembered list opens on the rows
 * it had last time, in its very first frame, and the load that follows brings
 * it up to date under them (`loading` stays false: there is something to
 * show). Only for a list whose fetch takes no filter of the page's own. What is
 * remembered belongs to one person in one workspace (`listScope`, the app
 * layout): a change of either forgets everything.
 */

import { t } from '$lib/i18n';

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface PagedList<T> {
  readonly items: T[];
  readonly nextCursor: string | null;
  readonly loading: boolean; // first load in flight
  readonly loadingMore: boolean; // subsequent page in flight
  readonly error: string | null; // last failure; items stay as-shown on failure
  load(): Promise<void>;
  loadMore(): Promise<void>;
  refresh(): Promise<void>;
}

// never rendered from: a plain record on purpose
let kept: Record<string, Page<unknown>> = {};
let scope = '';

/** Whose lists these are. A new scope forgets every remembered list. */
export function listScope(next: string): void {
  if (next === scope) return;
  scope = next;
  kept = {};
}

/**
 * Fetch a remembered list's first page ahead of its page being opened, so the
 * first visit opens on rows too. Quiet by design: a list this person may not
 * read (a role-gated one) simply stays unremembered, and an answer that comes
 * back after the scope changed is dropped.
 */
export async function warmList<T>(name: string, fetchPage: () => Promise<Page<T>>): Promise<void> {
  if (name in kept) return;
  const asked = scope;
  try {
    const page = await fetchPage();
    if (asked === scope && !(name in kept)) kept[name] = page;
  } catch {
    // the page itself will say what went wrong, if it is ever opened
  }
}

export function createPagedList<T>(
  fetchPage: (p: { cursor?: string; limit?: number }) => Promise<Page<T>>,
  opts: { limit?: number; remember?: string } = {}
): PagedList<T> {
  const memory = opts.remember ? (kept[opts.remember] as Page<T> | undefined) : undefined;
  // rows on screen that come from the memory, not yet confirmed by a load
  let unconfirmed = memory !== undefined;
  let items = $state<T[]>(memory?.items ?? []);
  let nextCursor = $state<string | null>(memory?.nextCursor ?? null);
  let loading = $state(false);
  let loadingMore = $state(false);
  let error = $state<string | null>(null);
  let inflight = false;

  const limitParam = opts.limit !== undefined ? { limit: opts.limit } : {};

  async function fetchFirstPage(): Promise<void> {
    if (inflight) return;
    inflight = true;
    try {
      const page = await fetchPage({ ...limitParam });
      items = page.items;
      nextCursor = page.nextCursor;
      unconfirmed = false;
      if (opts.remember) kept[opts.remember] = page;
      error = null;
    } catch (e) {
      error = e instanceof Error ? e.message : t('common.genericError');
      // remembered rows a load could not confirm are not shown on its word
      if (unconfirmed) {
        items = [];
        nextCursor = null;
        unconfirmed = false;
        if (opts.remember) delete kept[opts.remember];
      }
    } finally {
      inflight = false;
    }
  }

  return {
    get items() {
      return items;
    },
    get nextCursor() {
      return nextCursor;
    },
    get loading() {
      return loading;
    },
    get loadingMore() {
      return loadingMore;
    },
    get error() {
      return error;
    },
    async load() {
      loading = !unconfirmed;
      await fetchFirstPage();
      loading = false;
    },
    async loadMore() {
      if (!nextCursor || inflight) return;
      inflight = true;
      loadingMore = true;
      try {
        const page = await fetchPage({ cursor: nextCursor, ...limitParam });
        items = [...items, ...page.items];
        nextCursor = page.nextCursor;
        error = null;
      } catch (e) {
        error = e instanceof Error ? e.message : t('common.genericError');
      } finally {
        inflight = false;
        loadingMore = false;
      }
    },
    // Back to page 1; the shown rows survive until the fresh page arrives.
    async refresh() {
      await fetchFirstPage();
    }
  };
}
