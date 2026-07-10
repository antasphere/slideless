import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * Viewer-password hashing for share tokens (Phase 4).
 *
 * Share-link passwords are LOW-ENTROPY human secrets — unlike the 384-bit
 * token secrets (fast sha256+pepper is fine there), these need a deliberately
 * slow, salted KDF so a leaked database does not yield the passwords to a
 * dictionary run. scrypt via node:crypto keeps the dependency surface at
 * zero; parameters ride inside the stored string so they can be raised later
 * without invalidating existing hashes.
 *
 * Stored shape: `scrypt:<N>:<r>:<p>:<salt b64url>:<key b64url>`.
 * Verification is constant-time over the derived key (timingSafeEqual).
 */

const SCRYPT_N = 16384; // 2^14 — interactive-login work factor
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 32;
const SALT_BYTES = 16;

function deriveKey(
  password: string,
  salt: Buffer,
  N: number,
  r: number,
  p: number
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // maxmem must cover 128*N*r bytes (16 MiB at the defaults) plus headroom.
    scrypt(password, salt, KEY_LENGTH, { N, r, p, maxmem: 256 * N * r }, (err, key) =>
      err ? reject(err) : resolve(key)
    );
  });
}

export async function hashViewerPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await deriveKey(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return [
    'scrypt',
    String(SCRYPT_N),
    String(SCRYPT_R),
    String(SCRYPT_P),
    salt.toString('base64url'),
    key.toString('base64url')
  ].join(':');
}

/** Constant-time verification; a malformed stored hash fails closed (false). */
export async function verifyViewerPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isSafeInteger(N) || !Number.isSafeInteger(r) || !Number.isSafeInteger(p)) return false;
  if (N < 2 || N > 1 << 20 || r < 1 || r > 32 || p < 1 || p > 4) return false;
  const salt = Buffer.from(parts[4]!, 'base64url');
  const expected = Buffer.from(parts[5]!, 'base64url');
  if (salt.length === 0 || expected.length !== KEY_LENGTH) return false;
  try {
    const key = await deriveKey(password, salt, N, r, p);
    return key.length === expected.length && timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}
