import { describe, expect, it } from 'vitest';
import { createPagedList, type Page } from './pagedList.svelte';

/**
 * The paged-list contract, against a stubbed fetchPage: cursor threading,
 * loading flags, and keep-stale-on-error (items only move on success).
 */

interface Row {
  id: string;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Stub fetchPage: records params, answers from a queue of pages/errors. */
function stub(responses: Array<Page<Row> | Error>) {
  const calls: Array<{ cursor?: string; limit?: number }> = [];
  const queue = [...responses];
  const fetchPage = async (p: { cursor?: string; limit?: number }): Promise<Page<Row>> => {
    calls.push(p);
    const next = queue.shift();
    if (!next) throw new Error('stub exhausted');
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetchPage, calls };
}

describe('createPagedList', () => {
  it('load populates items and toggles loading around the flight', async () => {
    const gate = deferred<Page<Row>>();
    const list = createPagedList<Row>(() => gate.promise, { limit: 25 });
    expect(list.loading).toBe(false);

    const inFlight = list.load();
    expect(list.loading).toBe(true);
    gate.resolve({ items: [{ id: 'a' }, { id: 'b' }], nextCursor: 'b' });
    await inFlight;

    expect(list.loading).toBe(false);
    expect(list.items).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(list.nextCursor).toBe('b');
    expect(list.error).toBeNull();
  });

  it('loadMore appends the next page and threads the cursor + limit', async () => {
    const { fetchPage, calls } = stub([
      { items: [{ id: 'a' }], nextCursor: 'a' },
      { items: [{ id: 'b' }], nextCursor: null }
    ]);
    const list = createPagedList<Row>(fetchPage, { limit: 1 });
    await list.load();
    await list.loadMore();

    expect(calls).toEqual([{ limit: 1 }, { cursor: 'a', limit: 1 }]);
    expect(list.items).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(list.nextCursor).toBeNull();

    // Everything loaded: another loadMore is a no-op.
    await list.loadMore();
    expect(calls).toHaveLength(2);
  });

  it('a failed loadMore keeps the shown items and sets error', async () => {
    const { fetchPage } = stub([{ items: [{ id: 'a' }], nextCursor: 'a' }, new Error('network down')]);
    const list = createPagedList<Row>(fetchPage);
    await list.load();
    await list.loadMore();

    expect(list.items).toEqual([{ id: 'a' }]);
    expect(list.error).toBe('network down');
    expect(list.loadingMore).toBe(false);
  });

  it('a failed first load leaves items empty and sets error', async () => {
    const { fetchPage } = stub([new Error('boom')]);
    const list = createPagedList<Row>(fetchPage);
    await list.load();

    expect(list.items).toEqual([]);
    expect(list.error).toBe('boom');
    expect(list.loading).toBe(false);
  });

  it('refresh resets to page 1', async () => {
    const { fetchPage, calls } = stub([
      { items: [{ id: 'a' }], nextCursor: 'a' },
      { items: [{ id: 'b' }], nextCursor: null },
      { items: [{ id: 'fresh' }], nextCursor: 'fresh' }
    ]);
    const list = createPagedList<Row>(fetchPage);
    await list.load();
    await list.loadMore();
    await list.refresh();

    expect(calls[2]).toEqual({});
    expect(list.items).toEqual([{ id: 'fresh' }]);
    expect(list.nextCursor).toBe('fresh');
  });

  it('a failed refresh keeps the shown items', async () => {
    const { fetchPage } = stub([{ items: [{ id: 'a' }], nextCursor: null }, new Error('flaky')]);
    const list = createPagedList<Row>(fetchPage);
    await list.load();
    await list.refresh();

    expect(list.items).toEqual([{ id: 'a' }]);
    expect(list.error).toBe('flaky');
  });
});
