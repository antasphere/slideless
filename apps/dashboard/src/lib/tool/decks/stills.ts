import { api, PlatformApiError } from '$lib/api';

/**
 * The still image of a deck version (PRDCT-2725): the server captures ONE
 * WebP per version when it is pushed and serves it to everyone who can read
 * the deck. This module fetches it once per version for the page's life and
 * hands the components an object URL. A picture only: no deck HTML is ever
 * loaded here.
 *
 * A version whose image is still being made (`thumbnail_pending`) is asked
 * again after 2, 4, 8 and 16 seconds, since a just-pushed deck's image
 * arrives within seconds; after that the answer is null, and that null is
 * NOT kept, so a later mount asks again. Every other refusal (failed, not
 * found, the network) is a null kept for the page's life. An instance that
 * makes no images at all (`thumbnail_unavailable`) is remembered for the
 * page's life too: every later load resolves null at once, with no request,
 * so no card ever shows a skeleton there. The cache holds at most
 * MAX_ENTRIES versions; the oldest goes first and its object URL is revoked.
 */

/** Where a still stands in a component: not yet in view, being fetched or made, shown, or none to show. */
export type StillState = 'idle' | 'loading' | 'loaded' | 'none';

const MAX_ENTRIES = 300;
const RETRY_DELAYS_MS = [2000, 4000, 8000, 16000];

// Bookkeeping, never read by a template: a plain Map on purpose.
const cache = new Map<string, Promise<string | null>>();
// The URL each settled entry holds, so an eviction can revoke it.
const settled = new Map<string, string | null>();

const PENDING = Symbol('pending');

// Set by the first `thumbnail_unavailable`: the instance has no renderer.
let instanceMakesNoImages = false;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchOnce(deckId: string, version: number): Promise<string | null | typeof PENDING> {
  try {
    const res = await api.versionThumbnail(deckId, version);
    return URL.createObjectURL(await res.blob());
  } catch (e) {
    if (e instanceof PlatformApiError && e.code === 'thumbnail_pending') return PENDING;
    if (e instanceof PlatformApiError && e.code === 'thumbnail_unavailable') instanceMakesNoImages = true;
    return null;
  }
}

async function fetchStill(deckId: string, version: number): Promise<{ url: string | null; keep: boolean }> {
  for (let attempt = 0; ; attempt++) {
    const answer = await fetchOnce(deckId, version);
    if (answer !== PENDING) return { url: answer, keep: true };
    if (attempt >= RETRY_DELAYS_MS.length) return { url: null, keep: false };
    await wait(RETRY_DELAYS_MS[attempt]);
  }
}

function evictOldest(): void {
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value as string;
    cache.delete(oldest);
    const url = settled.get(oldest);
    settled.delete(oldest);
    if (url) URL.revokeObjectURL(url);
  }
}

/** The object URL of a version's still image, or null when there is none to show. */
export function loadStill(deckId: string, version: number): Promise<string | null> {
  if (instanceMakesNoImages) return Promise.resolve(null);
  const key = `${deckId}:${version}`;
  const known = cache.get(key);
  if (known) return known;

  const promise = fetchStill(deckId, version).then(({ url, keep }) => {
    if (cache.get(key) !== promise) {
      // Evicted (or reset) while in flight: nobody holds the URL for later.
      return url;
    }
    if (keep) settled.set(key, url);
    else cache.delete(key);
    return url;
  });
  cache.set(key, promise);
  evictOldest();
  return promise;
}

/** Tests only: forget every entry (object URLs are revoked) and the instance's answer. */
export function __resetStills(): void {
  for (const url of settled.values()) if (url) URL.revokeObjectURL(url);
  cache.clear();
  settled.clear();
  instanceMakesNoImages = false;
}
