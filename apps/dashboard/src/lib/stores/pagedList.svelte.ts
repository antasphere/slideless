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

export function createPagedList<T>(
  fetchPage: (p: { cursor?: string; limit?: number }) => Promise<Page<T>>,
  opts: { limit?: number } = {}
): PagedList<T> {
  let items = $state<T[]>([]);
  let nextCursor = $state<string | null>(null);
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
      error = null;
    } catch (e) {
      error = e instanceof Error ? e.message : t('common.genericError');
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
      loading = true;
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
