import { describe, expect, it, vi } from 'vitest';
import { HINT_WATCH_THROTTLE_MS, createHintWatch, shouldHintWatchSignOut } from './hint-watch';
import type { SsoDiscovery } from './sso';

const SSO: SsoDiscovery = { hintCookieName: 'ant_sso_hint', hintCookieDomain: 'antasphere.com' };

/**
 * SL-4 operator-safety pins. The single most dangerous regression here is
 * the watch signing out a break-glass operator (or firing on oss at all) —
 * the truth table nails every axis of the predicate.
 */
describe('shouldHintWatchSignOut — predicate truth table', () => {
  const HUB_USER = { via: 'session', ssoOnly: true } as const;

  it('fires: cloud posture + session + ssoOnly + hint ABSENT', () => {
    expect(shouldHintWatchSignOut({ sso: SSO, me: HUB_USER, cookies: '' })).toBe(true);
  });

  it('never on oss: no auth.sso in discovery → false even with every other condition met', () => {
    expect(shouldHintWatchSignOut({ sso: null, me: HUB_USER, cookies: '' })).toBe(false);
    expect(shouldHintWatchSignOut({ sso: undefined, me: HUB_USER, cookies: '' })).toBe(false);
  });

  it('hint present → false (the signed-in steady state)', () => {
    expect(shouldHintWatchSignOut({ sso: SSO, me: HUB_USER, cookies: 'ant_sso_hint=1' })).toBe(false);
  });

  it('OPERATOR SAFETY: ssoOnly false → never signs out, hint or no hint', () => {
    expect(shouldHintWatchSignOut({ sso: SSO, me: { via: 'session', ssoOnly: false }, cookies: '' })).toBe(
      false
    );
  });

  it('OPERATOR SAFETY: ssoOnly ABSENT (oss shape, older server) → never — exactly-true is the bar', () => {
    expect(shouldHintWatchSignOut({ sso: SSO, me: { via: 'session' }, cookies: '' })).toBe(false);
  });

  it('machine credentials are never watch targets', () => {
    expect(shouldHintWatchSignOut({ sso: SSO, me: { via: 'api_key', ssoOnly: true }, cookies: '' })).toBe(
      false
    );
    expect(shouldHintWatchSignOut({ sso: SSO, me: { via: 'oauth', ssoOnly: true }, cookies: '' })).toBe(
      false
    );
  });

  it('no me (signed out) → false', () => {
    expect(shouldHintWatchSignOut({ sso: SSO, me: null, cookies: '' })).toBe(false);
  });
});

describe('createHintWatch — throttle + single fire', () => {
  function watchHarness(opts: { cookies?: () => string } = {}) {
    let now = 1_000_000;
    const signOut = vi.fn();
    const watch = createHintWatch({
      getSso: () => SSO,
      getMe: () => ({ via: 'session', ssoOnly: true }),
      getCookies: opts.cookies ?? (() => 'ant_sso_hint=1'),
      signOut,
      now: () => now
    });
    return { watch, signOut, advance: (ms: number) => (now += ms) };
  }

  it('visibility checks inside the throttle window are skipped; a later one runs', () => {
    let cookies = 'ant_sso_hint=1';
    const h = watchHarness({ cookies: () => cookies });
    expect(h.watch.check()).toBe(false); // bootstrap: hint present, no fire
    cookies = ''; // hub logout happened in another tab
    h.advance(HINT_WATCH_THROTTLE_MS - 1);
    expect(h.watch.check()).toBe(false); // throttled — not even evaluated
    expect(h.signOut).not.toHaveBeenCalled();
    h.advance(2);
    expect(h.watch.check()).toBe(true); // past the throttle: fires
    expect(h.signOut).toHaveBeenCalledTimes(1);
  });

  it('fires at most once per page lifetime', () => {
    const h = watchHarness({ cookies: () => '' });
    expect(h.watch.check()).toBe(true);
    h.advance(HINT_WATCH_THROTTLE_MS * 2);
    expect(h.watch.check()).toBe(false);
    expect(h.signOut).toHaveBeenCalledTimes(1);
  });

  it('the first (bootstrap) check is never throttled', () => {
    const h = watchHarness({ cookies: () => '' });
    expect(h.watch.check()).toBe(true);
  });
});
