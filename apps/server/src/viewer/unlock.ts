import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Password-gate unlock proof (Phase 4): after a viewer presents the correct
 * share-link password, the browser gets a short-lived SIGNED cookie so it
 * does not re-prompt on every entry/asset request. Stateless by design —
 * nothing stored server-side, nothing revocable except by its own expiry.
 *
 * Value shape: `<expiry unix ms>.<base64url HMAC-SHA256>`, where the MAC
 * covers the token id, the expiry, AND a fingerprint of the CURRENT password
 * hash — so changing or clearing the token's password instantly invalidates
 * every outstanding unlock, and a cookie minted for one token can never
 * unlock another. The MAC key is the server auth secret.
 *
 * The cookie itself is scoped tight: name carries the token id, Path is the
 * token's own `/v/{secret}` subtree, HttpOnly + SameSite=Lax (+ Secure on
 * https deployments).
 */

export const UNLOCK_TTL_MS = 60 * 60 * 1000; // 1 h — re-prompt after that

/** Binds the MAC to the current password: rotate password → cookies die. */
function passwordFingerprint(passwordHash: string): string {
  return createHash('sha256').update(passwordHash).digest('hex').slice(0, 16);
}

function mac(authSecret: string, tokenId: string, expiresAtMs: number, passwordHash: string): Buffer {
  return createHmac('sha256', authSecret)
    .update(`viewer-unlock\n${tokenId}\n${expiresAtMs}\n${passwordFingerprint(passwordHash)}`)
    .digest();
}

export function mintUnlockValue(authSecret: string, tokenId: string, passwordHash: string): string {
  const expiresAtMs = Date.now() + UNLOCK_TTL_MS;
  return `${expiresAtMs}.${mac(authSecret, tokenId, expiresAtMs, passwordHash).toString('base64url')}`;
}

export function verifyUnlockValue(
  authSecret: string,
  tokenId: string,
  passwordHash: string,
  value: string
): boolean {
  const dot = value.indexOf('.');
  if (dot <= 0) return false;
  const expPart = value.slice(0, dot);
  if (!/^[0-9]{1,15}$/.test(expPart)) return false;
  const expiresAtMs = Number(expPart);
  if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= Date.now()) return false;
  let presented: Buffer;
  try {
    presented = Buffer.from(value.slice(dot + 1), 'base64url');
  } catch {
    return false;
  }
  const expected = mac(authSecret, tokenId, expiresAtMs, passwordHash);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

/** Cookie name per token (uuid dashes are cookie-name-safe). */
export function unlockCookieName(tokenId: string): string {
  return `slv_${tokenId}`;
}
