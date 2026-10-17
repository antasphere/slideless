import { describe, expect, it } from 'vitest';
import { PlatformApiError } from '$lib/api';
import { bootstrap, type BootstrapApi, type BootstrapSelection } from '$lib/bootstrap';

/**
 * PRDCT-3584. The bootstrap went out as three serial round trips; now the
 * three reads go out together and only the two repairs cost a second trip.
 * Every fallback of the old chain is pinned here, with the number of
 * round trips each path costs.
 */

type Instance = { setupRequired: boolean };
type Me = { activeWorkspaceId: string | null; name: string };

function fakeApi(opts: {
  setupRequired?: boolean;
  session?: boolean;
  /** `me` answers per X-Workspace-Id selection (`null` = the server default); a function throws or returns. */
  me: (workspace: string | null) => Me | Error;
}) {
  const calls: string[] = [];
  const rounds: number[] = []; // the call index at which each round of awaits started
  let workspace: string | null = null;
  let inflight = 0;
  let round = 0;
  const track = async <T>(name: string, value: () => T | Promise<T>): Promise<T> => {
    calls.push(name);
    if (inflight === 0) round += 1;
    rounds.push(round);
    inflight += 1;
    try {
      await Promise.resolve();
      return await value();
    } finally {
      inflight -= 1;
    }
  };
  const api: BootstrapApi<Instance, Me> = {
    instance: () => track('instance', () => ({ setupRequired: opts.setupRequired ?? false })),
    session: () => track('session', () => (opts.session === false ? null : { user: { id: 'u1' } })),
    me: () =>
      track('me', () => {
        const out = opts.me(workspace);
        if (out instanceof Error) throw out;
        return out;
      }),
    setWorkspace: (id) => {
      workspace = id;
    }
  };
  return { api, calls, rounds: () => Math.max(0, ...rounds), selected: () => workspace };
}

/**
 * The workspace memory as `$lib/api` wires it: `remember` and `clear` also
 * move the client's selection (rememberWorkspace / clearWorkspaceSelection
 * both call `api.setWorkspace`), which is what the second read relies on.
 */
function fakeSelection(stored: string | null, api?: BootstrapApi<Instance, Me>) {
  const log: string[] = [];
  let value = stored;
  const selection: BootstrapSelection = {
    stored: () => value,
    remember: (id) => {
      value = id;
      api?.setWorkspace(id);
      log.push(`remember:${id}`);
    },
    clear: () => {
      value = null;
      api?.setWorkspace(null);
      log.push('clear');
    }
  };
  return { selection, log };
}

const unauthenticated = () => new PlatformApiError(401, 'unauthenticated', 'Authentication required');
const hubDown = () => new PlatformApiError(403, 'hub_unavailable', 'hub unreachable');

describe('bootstrap: the common paths cost one round trip', () => {
  it('a signed-in person: instance, session and me go out together', async () => {
    const f = fakeApi({ me: () => ({ activeWorkspaceId: 'w1', name: 'Ada' }) });
    const out = await bootstrap(f.api, fakeSelection(null).selection, null);
    expect(out.me?.name).toBe('Ada');
    expect(out.meError).toBeNull();
    expect(f.calls.sort()).toEqual(['instance', 'me', 'session']);
    expect(f.rounds()).toBe(1);
  });

  it('a signed-out visitor: one round trip, me dropped, nothing remembered or cleared', async () => {
    const f = fakeApi({ session: false, me: () => unauthenticated() });
    const sel = fakeSelection('w-remembered');
    const out = await bootstrap(f.api, sel.selection, null);
    expect(out.me).toBeNull();
    expect(out.meError).toBeNull();
    expect(f.rounds()).toBe(1);
    expect(sel.log).toEqual([]);
    expect(sel.selection.stored()).toBe('w-remembered');
  });

  it('a not-set-up instance answers setupRequired and ignores the person', async () => {
    const f = fakeApi({ setupRequired: true, me: () => ({ activeWorkspaceId: 'w1', name: 'Ada' }) });
    const out = await bootstrap(f.api, fakeSelection(null).selection, null);
    expect(out.instance.setupRequired).toBe(true);
    expect(out.me).toBeNull();
    expect(f.rounds()).toBe(1);
  });

  it('the hub unreachable beyond its window is surfaced, not read as signed out', async () => {
    const f = fakeApi({ me: () => hubDown() });
    const out = await bootstrap(f.api, fakeSelection(null).selection, null);
    expect(out.me).toBeNull();
    expect(out.meError).toBe('hub_unavailable');
  });
});

describe('bootstrap: nothing of a dropped read outlives the bootstrap', () => {
  it('a signed-out landing leaves the client on the stored selection, and the next bootstrap reads it', async () => {
    // The password sign-in re-runs the root load on the SAME client (invalidateAll).
    let signedIn = false;
    const f = fakeApi({
      session: false,
      me: (w) =>
        w === 'hub-org-x' ? unauthenticated() : { activeWorkspaceId: w ?? 'w-default', name: 'Ada' }
    });
    f.api.session = async () => (signedIn ? { user: { id: 'u1' } } : null);
    f.api.setWorkspace('w-stored');
    const sel = fakeSelection('w-stored', f.api);
    const first = await bootstrap(f.api, sel.selection, 'hub-org-x');
    expect(first.me).toBeNull();
    expect(first.meError).toBeNull();
    expect(f.selected()).toBe('w-stored');
    expect(sel.log).toEqual([]);
    signedIn = true;
    const second = await bootstrap(f.api, sel.selection, null);
    expect(second.me?.activeWorkspaceId).toBe('w-stored');
    expect(sel.selection.stored()).toBe('w-stored');
    expect(sel.log).toEqual([]);
  });

  it('a signed-out visitor whose dropped read met the hub refusal reads as plainly signed out', async () => {
    const f = fakeApi({ session: false, me: () => hubDown() });
    const out = await bootstrap(f.api, fakeSelection(null).selection, null);
    expect(out.me).toBeNull();
    expect(out.meError).toBeNull();
  });

  it('a not-set-up instance with a landing leaves the client selection alone', async () => {
    const f = fakeApi({ setupRequired: true, me: () => ({ activeWorkspaceId: 'x', name: 'Ada' }) });
    f.api.setWorkspace('w-stored');
    const out = await bootstrap(f.api, fakeSelection('w-stored', f.api).selection, 'hub-org-1');
    expect(out.me).toBeNull();
    expect(f.selected()).toBe('w-stored');
  });
});

describe('bootstrap: the two repairs cost a second round trip', () => {
  it('a landing the server resolves is remembered by its local id', async () => {
    const f = fakeApi({
      me: (w) => ({ activeWorkspaceId: w === 'hub-org-1' ? 'local-9' : 'w1', name: 'Ada' })
    });
    const sel = fakeSelection(null, f.api);
    const out = await bootstrap(f.api, sel.selection, 'hub-org-1');
    // the read went out under the hub id; the memory keeps the LOCAL id
    expect(f.selected()).toBe('local-9');
    expect(out.me?.activeWorkspaceId).toBe('local-9');
    expect(sel.log).toEqual(['remember:local-9']);
    expect(f.rounds()).toBe(1);
  });

  it('a refused landing falls back to the stored selection in a second trip', async () => {
    const f = fakeApi({
      me: (w) => (w === 'hub-org-x' ? unauthenticated() : { activeWorkspaceId: w, name: 'Ada' })
    });
    const sel = fakeSelection('w-stored');
    const out = await bootstrap(f.api, sel.selection, 'hub-org-x');
    expect(out.me?.activeWorkspaceId).toBe('w-stored');
    expect(out.meError).toBeNull();
    expect(f.selected()).toBe('w-stored');
    expect(sel.log).toEqual([]);
    expect(f.rounds()).toBe(2);
  });

  it('a stale stored selection is dropped and the server default read once more', async () => {
    const f = fakeApi({
      me: (w) => (w === 'w-stale' ? unauthenticated() : { activeWorkspaceId: 'w-default', name: 'Ada' })
    });
    f.api.setWorkspace('w-stale');
    const sel = fakeSelection('w-stale', f.api);
    const out = await bootstrap(f.api, sel.selection, null);
    expect(out.me?.activeWorkspaceId).toBe('w-default');
    expect(sel.log).toEqual(['clear']);
    expect(f.rounds()).toBe(2);
  });

  it('a signed-in person with no membership and no stored selection reads as signed out in one trip', async () => {
    const f = fakeApi({ me: () => unauthenticated() });
    const sel = fakeSelection(null);
    const out = await bootstrap(f.api, sel.selection, null);
    expect(out.me).toBeNull();
    expect(out.meError).toBeNull();
    expect(sel.log).toEqual([]);
    expect(f.rounds()).toBe(1);
  });
});
