import { describe, expect, it } from 'vitest';
import { hashViewerPassword } from '../../src/sharing/password.js';
import { mintUnlockValue, unlockCookieName, verifyUnlockValue } from '../../src/viewer/unlock.js';
import { mintViewedValue, verifyViewedValue, viewedCookieName } from '../../src/viewer/viewed.js';

const SECRET = 'unit-test-auth-secret-0123456789abcdef0123456789abcdef';
const TOKEN_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_TOKEN_ID = '22222222-2222-2222-2222-222222222222';
const TTL_MS = 10 * 60 * 1000;

describe('viewed cookie MAC (view-count de-dupe)', () => {
  it('mints a value the verifier accepts for the same token', () => {
    const value = mintViewedValue(SECRET, TOKEN_ID, TTL_MS);
    expect(verifyViewedValue(SECRET, TOKEN_ID, value)).toBe(true);
  });

  it('rejects a value for a DIFFERENT token (no cross-token de-dupe)', () => {
    const value = mintViewedValue(SECRET, TOKEN_ID, TTL_MS);
    expect(verifyViewedValue(SECRET, OTHER_TOKEN_ID, value)).toBe(false);
  });

  it('rejects an expired value (TTL is what the operator set, in ms)', () => {
    const expired = mintViewedValue(SECRET, TOKEN_ID, -1000);
    expect(verifyViewedValue(SECRET, TOKEN_ID, expired)).toBe(false);
  });

  it('rejects expiry tampering and garbage', () => {
    const value = mintViewedValue(SECRET, TOKEN_ID, TTL_MS);
    const [, mac] = value.split('.');
    // Forged far-future expiry with the old MAC.
    expect(verifyViewedValue(SECRET, TOKEN_ID, `${Date.now() + 10 ** 9}.${mac}`)).toBe(false);
    // Expired timestamp with the old MAC.
    expect(verifyViewedValue(SECRET, TOKEN_ID, `1.${mac}`)).toBe(false);
    expect(verifyViewedValue(SECRET, TOKEN_ID, 'garbage')).toBe(false);
    expect(verifyViewedValue(SECRET, TOKEN_ID, '')).toBe(false);
  });

  it('cookie name is token-scoped and never shadows the unlock cookie', () => {
    expect(viewedCookieName(TOKEN_ID)).toBe(`slvd_${TOKEN_ID}`);
    expect(viewedCookieName(TOKEN_ID)).not.toBe(unlockCookieName(TOKEN_ID));
  });

  it('viewed and unlock values never cross-verify (distinct MAC labels)', async () => {
    const pwHash = await hashViewerPassword('pw');
    const viewed = mintViewedValue(SECRET, TOKEN_ID, TTL_MS);
    const unlock = mintUnlockValue(SECRET, TOKEN_ID, pwHash);
    expect(verifyUnlockValue(SECRET, TOKEN_ID, pwHash, viewed)).toBe(false);
    expect(verifyViewedValue(SECRET, TOKEN_ID, unlock)).toBe(false);
  });
});
