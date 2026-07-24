import { createHmac } from 'node:crypto';
import { mintExpiringValue, verifyExpiringValue } from './signed-value.js';

/**
 * View-count de-dupe marker (PRDCT-1243): after an entry load is COUNTED, the
 * browser gets a short-lived signed cookie; while it presents a valid one,
 * repeat entry GETs are served but not re-counted. This collapses the
 * multi-GET reality of one "open" (speculative prefetch/prerender + the
 * navigation, reloads, second tabs) into one counted view. Stateless like the
 * unlock cookie (viewer/unlock.ts) — nothing stored server-side; the shared
 * `<expiry>.<mac>` envelope lives in viewer/signed-value.ts.
 *
 * Deliberate differences from the unlock cookie:
 *  - NO password-hash binding: this is a counting hint, never an authz input.
 *    The password gate reads only the `slv_` unlock cookie; forging or
 *    dropping a viewed cookie only changes whether a view is re-counted.
 *  - TTL is a parameter, not a constant: the window is operator-set
 *    (VIEW_DEDUPE_WINDOW_MINUTES, threaded through ViewerDeps in ms).
 */

/** Distinct MAC label — a viewed value can never verify as an unlock value. */
function mac(authSecret: string, tokenId: string, expiresAtMs: number): Buffer {
  return createHmac('sha256', authSecret).update(`viewer-viewed\n${tokenId}\n${expiresAtMs}`).digest();
}

export function mintViewedValue(authSecret: string, tokenId: string, ttlMs: number): string {
  return mintExpiringValue(ttlMs, (expiresAtMs) => mac(authSecret, tokenId, expiresAtMs));
}

export function verifyViewedValue(authSecret: string, tokenId: string, value: string): boolean {
  return verifyExpiringValue(value, (expiresAtMs) => mac(authSecret, tokenId, expiresAtMs));
}

/** Cookie name per token — `slvd_` so it can never shadow the `slv_` unlock cookie. */
export function viewedCookieName(tokenId: string): string {
  return `slvd_${tokenId}`;
}
