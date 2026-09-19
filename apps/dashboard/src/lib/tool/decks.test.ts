import { describe, expect, it } from 'vitest';
import { isPreviewToken, kindLabel, PREVIEW_SANDBOX, tokenStatus } from './decks';

describe('PREVIEW_SANDBOX (ADR 012 Surface D tripwire)', () => {
  it('never contains allow-same-origin — that one token re-opens session theft', () => {
    expect(PREVIEW_SANDBOX).not.toContain('allow-same-origin');
  });

  it('never contains allow-top-navigation (framebust)', () => {
    expect(PREVIEW_SANDBOX).not.toContain('allow-top-navigation');
  });

  it('carries allow-popups-to-escape-sandbox — a window the deck opens runs unsandboxed (PRDCT-2268)', () => {
    expect(PREVIEW_SANDBOX).toContain('allow-popups-to-escape-sandbox');
  });

  it('is the exact ADR 012 set, in order', () => {
    expect(PREVIEW_SANDBOX).toBe(
      'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads'
    );
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
  it('keys on the SERVER-SET purpose column, never the client-controlled name', () => {
    expect(isPreviewToken({ purpose: 'preview' })).toBe(true);
    expect(isPreviewToken({ purpose: 'share' })).toBe(false);
  });

  it('SECURITY: a share token merely NAMED "Dashboard preview" stays visible', () => {
    // Any deck writer (a dev collaborator included) controls token names;
    // hiding by name was a covert-channel primitive. purpose 'share' must
    // never be filtered from the panel, whatever the name says.
    const spoofed = { name: 'Dashboard preview', purpose: 'share' } as const;
    expect(isPreviewToken(spoofed)).toBe(false);
  });
});

describe('kindLabel', () => {
  it('maps every kind to a label (en catalog under vitest)', () => {
    expect(kindLabel('presentation')).toBe('Presentation');
    expect(kindLabel('app')).toBe('App');
    expect(kindLabel('plan')).toBe('Plan');
  });
});
