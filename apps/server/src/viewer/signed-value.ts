import { timingSafeEqual } from 'node:crypto';

/**
 * The `<expiry unix ms>.<base64url MAC>` envelope shared by the viewer's
 * stateless cookies (unlock.ts, viewed.ts). This module owns only the wire
 * format and the expiry discipline; WHAT gets MACed stays each caller's own
 * (`macFor`), so the two cookies keep their distinct labels and inputs and
 * can never cross-verify. CONTRACT: a caller's MAC input must cover the
 * expiry it receives — otherwise expiry tampering would go unnoticed.
 */

export function mintExpiringValue(ttlMs: number, macFor: (expiresAtMs: number) => Buffer): string {
  const expiresAtMs = Date.now() + ttlMs;
  return `${expiresAtMs}.${macFor(expiresAtMs).toString('base64url')}`;
}

export function verifyExpiringValue(value: string, macFor: (expiresAtMs: number) => Buffer): boolean {
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
  const expected = macFor(expiresAtMs);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}
