import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The thumbnail controller's token hygiene (PRDCT-2308, verifier round 1,
 * F1 and G4): every preview token a popover minted is revoked when the
 * page's component is torn down, AND when the page goes away without a
 * teardown (`pagehide`: a reload, a typed URL, a closed tab), through a
 * keepalive DELETE on the SDK's own revoke route.
 */
vi.mock('$lib/api', () => {
  const createPreviewToken = vi.fn(async (_deck: string, req: { version?: number }) => ({
    shareToken: { id: `tok-${req.version}` },
    url: `http://app.test/v/secret-${req.version}/`
  }));
  const revokeShareToken = vi.fn(async () => ({}));
  return {
    api: { createPreviewToken, revokeShareToken },
    errorMessage: (e: unknown) => String(e),
    storedWorkspaceId: () => 'ws-1'
  };
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('createThumbnailController', () => {
  const listeners = new Map<string, Array<() => void>>();
  const fetchSpy = vi.fn(async () => new Response(null, { status: 200 }));

  beforeEach(() => {
    listeners.clear();
    vi.stubGlobal('window', {
      addEventListener: (type: string, fn: () => void) => {
        listeners.set(type, [...(listeners.get(type) ?? []), fn]);
      },
      removeEventListener: (type: string, fn: () => void) => {
        listeners.set(
          type,
          (listeners.get(type) ?? []).filter((f) => f !== fn)
        );
      }
    });
    vi.stubGlobal('fetch', fetchSpy);
    fetchSpy.mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('mints once per version, only for a caller who may preview, and revokes every token on destroy', async () => {
    const { createThumbnailController } = await import('./preview.svelte');
    const { api } = await import('$lib/api');
    const thumbs = createThumbnailController('deck-1', { canPreview: () => true });
    expect(thumbs.url(1)).toBeNull();
    thumbs.request(1);
    thumbs.request(1);
    thumbs.request(2);
    await flush();
    expect(api.createPreviewToken).toHaveBeenCalledTimes(2);
    expect(thumbs.url(1)).toBe('http://app.test/v/secret-1/');
    thumbs.request(1);
    await flush();
    expect(api.createPreviewToken).toHaveBeenCalledTimes(2);
    thumbs.destroy();
    expect(api.revokeShareToken).toHaveBeenCalledWith('deck-1', 'tok-1');
    expect(api.revokeShareToken).toHaveBeenCalledWith('deck-1', 'tok-2');
    // The page-hide listener is gone with the controller.
    expect(listeners.get('pagehide') ?? []).toHaveLength(0);

    const blind = createThumbnailController('deck-1', { canPreview: () => false });
    blind.request(3);
    await flush();
    expect(api.createPreviewToken).toHaveBeenCalledTimes(2);
    blind.destroy();
  });

  it('on pagehide, revokes every minted token with a keepalive DELETE on the revoke route', async () => {
    const { createThumbnailController, revokePath } = await import('./preview.svelte');
    const thumbs = createThumbnailController('deck-9', { canPreview: () => true });
    thumbs.request(4);
    thumbs.request(5);
    await flush();
    for (const fn of listeners.get('pagehide') ?? []) fn();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const calls = fetchSpy.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls.map(([url]) => url).sort()).toEqual([
      revokePath('deck-9', 'tok-4'),
      revokePath('deck-9', 'tok-5')
    ]);
    for (const [, init] of calls) {
      expect(init.method).toBe('DELETE');
      expect(init.keepalive).toBe(true);
      expect(init.headers).toEqual({ 'x-workspace-id': 'ws-1' });
    }
    // A second pagehide has nothing left to revoke.
    for (const fn of listeners.get('pagehide') ?? []) fn();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('spells the revoke route the way the SDK does', async () => {
    const { revokePath } = await import('./preview.svelte');
    expect(revokePath('a b', 'c/d')).toBe('/api/v1/presentations/a%20b/tokens/c%2Fd');
  });
});
