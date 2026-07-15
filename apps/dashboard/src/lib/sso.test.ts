import { describe, expect, it } from 'vitest';
import {
  SSO_ATTEMPT_TTL_MS,
  SSO_PENDING_NEXT_KEY,
  SSO_PENDING_NEXT_TTL_MS,
  clearAttemptMarker,
  consumePendingNext,
  evaluateAutoConnect,
  hasCookie,
  isAttemptMarkerFresh,
  isLoginRequiredError,
  readAttemptMarker,
  writeAttemptMarker,
  writePendingNext,
  type AutoConnectContext,
  type StorageLike
} from './sso';

/**
 * SL-3 loop-safety pins. The lattice is the ONLY thing standing between
 * "seamless" and an infinite redirect cycle (or an insta-relogin after
 * logout) — every gate and every known cycle entry gets its own row here.
 */

const SSO = { hintCookieName: 'ant_sso_hint', hintCookieDomain: 'antasphere.com' };
const NOW = 1_700_000_000_000;

function ctx(overrides: Partial<AutoConnectContext> = {}): AutoConnectContext {
  return {
    sso: SSO,
    methods: ['antasphere', 'api-key', 'oauth'],
    cookies: 'ant_sso_hint=1',
    params: new URLSearchParams(),
    attemptMarker: null,
    now: NOW,
    signedIn: false,
    ...overrides
  };
}

function memoryStorage(seed: Record<string, string> = {}): StorageLike & { data: Map<string, string> } {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k)
  };
}

describe('evaluateAutoConnect — the gate table', () => {
  it('attempts when every gate is green', () => {
    expect(evaluateAutoConnect(ctx())).toEqual({ attempt: true, clearStaleHint: false, signedOut: false });
  });

  it('gate A (posture): no auth.sso in discovery → never, even with a hint present (oss leakage pin)', () => {
    // The hint cookie is parent-domain shared, so an oss instance hosted
    // under the same parent WOULD see it — discovery absence must win.
    expect(evaluateAutoConnect(ctx({ sso: null })).attempt).toBe(false);
    expect(evaluateAutoConnect(ctx({ sso: undefined })).blockedBy).toBe('posture');
  });

  it('gate A (posture): antasphere method absent → never', () => {
    expect(evaluateAutoConnect(ctx({ methods: ['password', 'api-key'] })).blockedBy).toBe('posture');
  });

  it('gate B (hint): no hint cookie → an anonymous visitor triggers ZERO sign-in traffic', () => {
    expect(evaluateAutoConnect(ctx({ cookies: '' })).blockedBy).toBe('no_hint');
    expect(evaluateAutoConnect(ctx({ cookies: 'other=1' })).blockedBy).toBe('no_hint');
  });

  it('gate B: an emptied hint value counts as absent', () => {
    expect(evaluateAutoConnect(ctx({ cookies: 'ant_sso_hint=' })).blockedBy).toBe('no_hint');
  });

  it('gate C (params): any ?error= blocks the attempt', () => {
    const decision = evaluateAutoConnect(ctx({ params: new URLSearchParams('error=whatever') }));
    expect(decision.attempt).toBe(false);
    expect(decision.blockedBy).toBe('error_param');
  });

  it('gate C (params): ?signed_out=1 blocks and flags the quiet notice', () => {
    const decision = evaluateAutoConnect(ctx({ params: new URLSearchParams('signed_out=1') }));
    expect(decision).toMatchObject({ attempt: false, blockedBy: 'signed_out', signedOut: true });
  });

  it('gate D (marker): a fresh per-tab attempt marker blocks re-attempts', () => {
    const decision = evaluateAutoConnect(ctx({ attemptMarker: String(NOW - 30_000) }));
    expect(decision.blockedBy).toBe('recent_attempt');
  });

  it('gate D: a marker past the TTL no longer blocks', () => {
    expect(evaluateAutoConnect(ctx({ attemptMarker: String(NOW - SSO_ATTEMPT_TTL_MS - 1) })).attempt).toBe(
      true
    );
  });

  it('gate D: a FUTURE-dated marker still blocks (clock skew never opens a loop)', () => {
    expect(evaluateAutoConnect(ctx({ attemptMarker: String(NOW + 60_000) })).blockedBy).toBe(
      'recent_attempt'
    );
  });

  it('gate D: a garbage marker is ignored (the write path immediately replaces it)', () => {
    expect(evaluateAutoConnect(ctx({ attemptMarker: 'not-a-number' })).attempt).toBe(true);
  });

  it('gate E (session): a live signed-in bootstrap never attempts', () => {
    expect(evaluateAutoConnect(ctx({ signedIn: true })).blockedBy).toBe('live_session');
  });
});

describe('evaluateAutoConnect — the four cycle entries stay bounded', () => {
  it('1. AS silent-failure (?error=login_required) → no attempt + the stale hint is cleared', () => {
    const decision = evaluateAutoConnect(ctx({ params: new URLSearchParams('error=login_required') }));
    expect(decision.attempt).toBe(false);
    expect(decision.clearStaleHint).toBe(true);
  });

  it('…the whole login_required family clears the hint; other codes do NOT', () => {
    for (const code of [
      'login_required',
      'interaction_required',
      'account_selection_required',
      'consent_required'
    ]) {
      expect(isLoginRequiredError(code)).toBe(true);
      expect(evaluateAutoConnect(ctx({ params: new URLSearchParams(`error=${code}`) })).clearStaleHint).toBe(
        true
      );
    }
    expect(isLoginRequiredError('sso_email_conflict')).toBe(false);
    expect(isLoginRequiredError(null)).toBe(false);
  });

  it('…but never signals a hint clear on oss (no auth.sso → nothing to clear)', () => {
    const decision = evaluateAutoConnect(
      ctx({ sso: null, params: new URLSearchParams('error=login_required') })
    );
    expect(decision.clearStaleHint).toBe(false);
  });

  it('2. after-hook fail-closed landing (?error=sso_projection_failed) → no attempt, hint KEPT (banner case)', () => {
    const decision = evaluateAutoConnect(ctx({ params: new URLSearchParams('error=sso_projection_failed') }));
    expect(decision).toMatchObject({ attempt: false, blockedBy: 'error_param', clearStaleHint: false });
  });

  it('3. logout landing: ?signed_out=1 AND no hint each block independently (insta-relogin pin)', () => {
    // Both gates must hold on their own: the signed_out param alone…
    expect(evaluateAutoConnect(ctx({ params: new URLSearchParams('signed_out=1') })).attempt).toBe(false);
    // …and the cleared hint alone (e.g. the user navigates to a bare /login
    // right after logout) — no re-connect either way.
    expect(evaluateAutoConnect(ctx({ cookies: '' })).attempt).toBe(false);
  });

  it('4. anything unforeseen: the marker bounds it to one attempt per tab per TTL', () => {
    // First pass attempts; the marker (written before navigating) blocks the second.
    expect(evaluateAutoConnect(ctx()).attempt).toBe(true);
    expect(evaluateAutoConnect(ctx({ attemptMarker: String(NOW) })).attempt).toBe(false);
  });
});

describe('gate D without storage (locked-down/private browsers)', () => {
  // The one cycle that carries NO ?error= param — the (app) guard bouncing
  // a me=null visitor to a bare /login while the hub hint is live — is
  // bounded by gate D ALONE. These pins prove the bound survives a
  // sessionStorage that is blocked or throwing: the in-memory fallback
  // still caps re-attempts within the page/JS lifetime.

  function throwingStorage(): StorageLike {
    const blocked = () => {
      throw new Error('storage blocked');
    };
    return { getItem: blocked, setItem: blocked, removeItem: blocked };
  }

  it('sessionStorage throws on setItem/getItem → a recorded attempt STILL blocks the second evaluation', () => {
    const storage = throwingStorage();
    clearAttemptMarker(storage); // reset the module-level fallback between tests

    // First evaluation: no marker anywhere — the silent attempt proceeds…
    expect(evaluateAutoConnect(ctx({ attemptMarker: readAttemptMarker(storage) })).attempt).toBe(true);
    // …and the pre-navigation write cannot persist to storage:
    writeAttemptMarker(NOW, storage);
    // Second evaluation in the same JS lifetime: gate D holds regardless.
    const second = evaluateAutoConnect(ctx({ attemptMarker: readAttemptMarker(storage), now: NOW + 1_000 }));
    expect(second.attempt).toBe(false);
    expect(second.blockedBy).toBe('recent_attempt');
  });

  it('storage entirely unavailable (null) → same bound', () => {
    clearAttemptMarker(null);
    writeAttemptMarker(NOW, null);
    expect(evaluateAutoConnect(ctx({ attemptMarker: readAttemptMarker(null), now: NOW + 1 })).blockedBy).toBe(
      'recent_attempt'
    );
  });

  it('classic private mode (getItem works, setItem throws) → same bound', () => {
    const backing = memoryStorage();
    const quotaBlocked: StorageLike = {
      getItem: (k) => backing.getItem(k),
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: (k) => backing.removeItem(k)
    };
    clearAttemptMarker(quotaBlocked);
    writeAttemptMarker(NOW, quotaBlocked);
    expect(readAttemptMarker(quotaBlocked)).toBe(String(NOW));
  });

  it('the TTL semantics hold on the fallback too: past the window the attempt reopens', () => {
    const storage = throwingStorage();
    clearAttemptMarker(storage);
    writeAttemptMarker(NOW, storage);
    expect(
      evaluateAutoConnect(
        ctx({ attemptMarker: readAttemptMarker(storage), now: NOW + SSO_ATTEMPT_TTL_MS + 1 })
      ).attempt
    ).toBe(true);
  });

  it('a successful bootstrap clears the fallback too (clearAttemptMarker)', () => {
    const storage = throwingStorage();
    writeAttemptMarker(NOW, storage);
    clearAttemptMarker(storage);
    expect(readAttemptMarker(storage)).toBeNull();
  });

  it('when storage WORKS, the storage-backed per-tab marker still round-trips', () => {
    const storage = memoryStorage();
    clearAttemptMarker(storage);
    writeAttemptMarker(NOW, storage);
    expect(storage.getItem('sso.attempt')).toBe(String(NOW));
    expect(readAttemptMarker(storage)).toBe(String(NOW));
    clearAttemptMarker(storage);
    expect(storage.data.has('sso.attempt')).toBe(false);
    expect(readAttemptMarker(storage)).toBeNull();
  });
});

describe('cookie + marker helpers', () => {
  it('hasCookie matches the exact name only', () => {
    expect(hasCookie('ant_sso_hint=1', 'ant_sso_hint')).toBe(true);
    expect(hasCookie('a=b; ant_sso_hint=1; c=d', 'ant_sso_hint')).toBe(true);
    expect(hasCookie('ant_sso_hint2=1', 'ant_sso_hint')).toBe(false);
    expect(hasCookie('xant_sso_hint=1', 'ant_sso_hint')).toBe(false);
    expect(hasCookie('', 'ant_sso_hint')).toBe(false);
  });

  it('isAttemptMarkerFresh: null/garbage → stale; in-window → fresh', () => {
    expect(isAttemptMarkerFresh(null, NOW)).toBe(false);
    expect(isAttemptMarkerFresh('junk', NOW)).toBe(false);
    expect(isAttemptMarkerFresh(String(NOW - 1), NOW)).toBe(true);
    expect(isAttemptMarkerFresh(String(NOW - SSO_ATTEMPT_TTL_MS), NOW)).toBe(false);
  });
});

describe('pendingNext (decision 7)', () => {
  it('write → consume returns the value ONCE; the second consume is null', () => {
    const storage = memoryStorage();
    writePendingNext(storage, '/decks/abc?tab=versions', NOW);
    expect(consumePendingNext(storage, NOW + 1_000)).toBe('/decks/abc?tab=versions');
    expect(consumePendingNext(storage, NOW + 1_000)).toBeNull();
  });

  it('expiry: a value past the TTL consumes as null (and is removed)', () => {
    const storage = memoryStorage();
    writePendingNext(storage, '/decks/abc', NOW);
    expect(consumePendingNext(storage, NOW + SSO_PENDING_NEXT_TTL_MS + 1)).toBeNull();
    expect(storage.data.has(SSO_PENDING_NEXT_KEY)).toBe(false);
  });

  it('hostile write value: safeNext applies on WRITE (never stores an external target)', () => {
    const storage = memoryStorage();
    writePendingNext(storage, 'https://evil.example', NOW);
    expect(consumePendingNext(storage, NOW)).toBe('/');
  });

  it('hostile STORED value: safeNext applies on CONSUME too (tampered storage)', () => {
    for (const next of ['//evil.example', 'https://evil.example', '/\\evil.example']) {
      const storage = memoryStorage({
        [SSO_PENDING_NEXT_KEY]: JSON.stringify({ next, exp: NOW + 60_000 })
      });
      expect(consumePendingNext(storage, NOW)).toBe('/');
    }
  });

  it('malformed stored JSON consumes as null (and is removed)', () => {
    const storage = memoryStorage({ [SSO_PENDING_NEXT_KEY]: '{nope' });
    expect(consumePendingNext(storage, NOW)).toBeNull();
    expect(storage.data.has(SSO_PENDING_NEXT_KEY)).toBe(false);
  });

  it("a root ('/') write never clobbers a fresh deeper destination (the signup-detour re-entry)", () => {
    const storage = memoryStorage();
    writePendingNext(storage, '/decks/abc', NOW);
    // The verified-CTA journey re-enters at the tool ROOT and dances again:
    writePendingNext(storage, null, NOW + 5_000);
    expect(consumePendingNext(storage, NOW + 10_000)).toBe('/decks/abc');
  });

  it('a deeper write DOES replace an older value', () => {
    const storage = memoryStorage();
    writePendingNext(storage, '/decks/old', NOW);
    writePendingNext(storage, '/decks/new', NOW + 1);
    expect(consumePendingNext(storage, NOW + 2)).toBe('/decks/new');
  });

  it("a root write lands when nothing (or only '/') is stored", () => {
    const storage = memoryStorage();
    writePendingNext(storage, '/', NOW);
    expect(consumePendingNext(storage, NOW + 1)).toBe('/');
  });
});
