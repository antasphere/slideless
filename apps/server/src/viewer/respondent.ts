import { createHmac } from 'node:crypto';
import { mintExpiringValue, verifyExpiringValue } from './signed-value.js';

/**
 * Signed-in respondent assertion (ADR 022 leg 3): when the share-link
 * DOCUMENT request carries a live first-party session, the server injects
 * this signed value into the forms runtime config; the runtime echoes it on
 * submit, and verification is the ONLY way `form_responses.respondent_user_id`
 * is ever written — a client claim alone never is.
 *
 * Value shape: `<base64url userId>.<expiry unix ms>.<base64url MAC>` — the
 * shared expiring envelope (viewer/signed-value.ts) prefixed with the
 * asserted user id, which the MAC covers together with the token id and the
 * expiry (its own `viewer-respondent` label keeps it from ever
 * cross-verifying with the unlock or view-dedupe values). Token-scoped: an
 * assertion minted into one link's document cannot vouch on another link.
 *
 * Expiry posture: a STALE assertion degrades the submit to anonymous
 * (respondent_user_id null) rather than failing it — identity attribution
 * is best-effort courtesy, never a gate on responding.
 */

export const RESPONDENT_TTL_MS = 60 * 60 * 1000; // matches the unlock proof

function mac(authSecret: string, tokenId: string, userId: string, expiresAtMs: number): Buffer {
  return createHmac('sha256', authSecret)
    .update(`viewer-respondent\n${tokenId}\n${userId}\n${expiresAtMs}`)
    .digest();
}

export function mintRespondentAssertion(authSecret: string, tokenId: string, userId: string): string {
  const encoded = Buffer.from(userId, 'utf8').toString('base64url');
  return `${encoded}.${mintExpiringValue(RESPONDENT_TTL_MS, (exp) => mac(authSecret, tokenId, userId, exp))}`;
}

/** The asserted user id, or null when absent/expired/forged/foreign-token. */
export function verifyRespondentAssertion(
  authSecret: string,
  tokenId: string,
  value: string
): string | null {
  const dot = value.indexOf('.');
  if (dot <= 0) return null;
  let userId: string;
  try {
    userId = Buffer.from(value.slice(0, dot), 'base64url').toString('utf8');
  } catch {
    return null;
  }
  if (userId.length === 0 || userId.length > 128) return null;
  const ok = verifyExpiringValue(value.slice(dot + 1), (exp) => mac(authSecret, tokenId, userId, exp));
  return ok ? userId : null;
}
