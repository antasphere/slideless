import { describe, expect, it } from 'vitest';
import { hashViewerPassword, verifyViewerPassword } from '../../src/sharing/password.js';
import { mintUnlockValue, unlockCookieName, verifyUnlockValue } from '../../src/viewer/unlock.js';

const SECRET = 'unit-test-auth-secret-0123456789abcdef0123456789abcdef';
const TOKEN_ID = '11111111-1111-1111-1111-111111111111';

describe('viewer password hashing (scrypt)', () => {
  it('round-trips and rejects a wrong password', async () => {
    const stored = await hashViewerPassword('hunter2-but-longer');
    expect(stored.startsWith('scrypt:')).toBe(true);
    expect(stored).not.toContain('hunter2'); // never the plaintext
    expect(await verifyViewerPassword('hunter2-but-longer', stored)).toBe(true);
    expect(await verifyViewerPassword('hunter2-but-wrong', stored)).toBe(false);
  });

  it('salts: two hashes of the same password differ', async () => {
    const a = await hashViewerPassword('same-password');
    const b = await hashViewerPassword('same-password');
    expect(a).not.toBe(b);
    expect(await verifyViewerPassword('same-password', a)).toBe(true);
    expect(await verifyViewerPassword('same-password', b)).toBe(true);
  });

  it('fails closed on malformed or tampered stored hashes', async () => {
    expect(await verifyViewerPassword('x', '')).toBe(false);
    expect(await verifyViewerPassword('x', 'bcrypt:whatever')).toBe(false);
    expect(await verifyViewerPassword('x', 'scrypt:not-a-number:8:1:AAAA:BBBB')).toBe(false);
    const good = await hashViewerPassword('x');
    // Absurd work factor smuggled into the params → rejected, not executed.
    const parts = good.split(':');
    parts[1] = String(2 ** 30);
    expect(await verifyViewerPassword('x', parts.join(':'))).toBe(false);
  });
});

describe('unlock cookie MAC', () => {
  it('mints a value the verifier accepts for the same token + password hash', async () => {
    const pwHash = await hashViewerPassword('pw');
    const value = mintUnlockValue(SECRET, TOKEN_ID, pwHash);
    expect(verifyUnlockValue(SECRET, TOKEN_ID, pwHash, value)).toBe(true);
  });

  it('rejects a value for a DIFFERENT token (no cross-token unlock)', async () => {
    const pwHash = await hashViewerPassword('pw');
    const value = mintUnlockValue(SECRET, TOKEN_ID, pwHash);
    expect(verifyUnlockValue(SECRET, '22222222-2222-2222-2222-222222222222', pwHash, value)).toBe(false);
  });

  it('dies when the password changes (hash fingerprint is MACed)', async () => {
    const oldHash = await hashViewerPassword('old');
    const newHash = await hashViewerPassword('new');
    const value = mintUnlockValue(SECRET, TOKEN_ID, oldHash);
    expect(verifyUnlockValue(SECRET, TOKEN_ID, newHash, value)).toBe(false);
  });

  it('rejects expiry tampering and garbage', async () => {
    const pwHash = await hashViewerPassword('pw');
    const value = mintUnlockValue(SECRET, TOKEN_ID, pwHash);
    const [, mac] = value.split('.');
    // Forged far-future expiry with the old MAC.
    expect(verifyUnlockValue(SECRET, TOKEN_ID, pwHash, `${Date.now() + 10 ** 9}.${mac}`)).toBe(false);
    // Expired.
    expect(verifyUnlockValue(SECRET, TOKEN_ID, pwHash, `1.${mac}`)).toBe(false);
    expect(verifyUnlockValue(SECRET, TOKEN_ID, pwHash, 'garbage')).toBe(false);
    expect(verifyUnlockValue(SECRET, TOKEN_ID, pwHash, '')).toBe(false);
  });

  it('cookie name is token-scoped', () => {
    expect(unlockCookieName(TOKEN_ID)).toBe(`slv_${TOKEN_ID}`);
  });
});
