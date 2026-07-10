import { describe, expect, it } from 'vitest';
import {
  isPreviewToken,
  kindLabel,
  PREVIEW_SANDBOX,
  PREVIEW_TOKEN_NAME,
  tokenStatus
} from './decks';

describe('PREVIEW_SANDBOX (ADR 012 Surface D tripwire)', () => {
  it('never contains allow-same-origin — that one token re-opens session theft', () => {
    expect(PREVIEW_SANDBOX).not.toContain('allow-same-origin');
  });

  it('never contains allow-top-navigation (framebust)', () => {
    expect(PREVIEW_SANDBOX).not.toContain('allow-top-navigation');
  });

  it('is the exact ADR 012 set, in order', () => {
    expect(PREVIEW_SANDBOX).toBe('allow-scripts allow-forms allow-popups allow-modals allow-downloads');
  });
});

describe('tokenStatus', () => {
  const NOW = new Date('2026-07-10T12:00:00Z');
  const past = '2026-07-10T11:59:59Z';
  const future = '2026-07-10T12:00:01Z';

  it('is active without revocation or expiry', () => {
    expect(tokenStatus({ revokedAt: null, expiresAt: null }, NOW)).toBe('active');
    expect(tokenStatus({ revokedAt: null, expiresAt: future }, NOW)).toBe('active');
  });

  it('is expired once expiresAt passed', () => {
    expect(tokenStatus({ revokedAt: null, expiresAt: past }, NOW)).toBe('expired');
  });

  it('revoked beats expired (the viewer resolves revocation first)', () => {
    expect(tokenStatus({ revokedAt: past, expiresAt: past }, NOW)).toBe('revoked');
    expect(tokenStatus({ revokedAt: past, expiresAt: null }, NOW)).toBe('revoked');
  });
});

describe('isPreviewToken', () => {
  it('matches the reserved preview name exactly', () => {
    expect(isPreviewToken({ name: PREVIEW_TOKEN_NAME })).toBe(true);
    expect(isPreviewToken({ name: 'alice@client.com' })).toBe(false);
    expect(isPreviewToken({ name: `${PREVIEW_TOKEN_NAME} 2` })).toBe(false);
  });
});

describe('kindLabel', () => {
  it('maps every kind to a label (en catalog under vitest)', () => {
    expect(kindLabel('presentation')).toBe('Presentation');
    expect(kindLabel('app')).toBe('App');
    expect(kindLabel('plan')).toBe('Plan');
  });
});
