import type { InstanceInfo } from '@slideless/contract';
import { safeNext } from '$lib/utils';

/**
 * SL-3 — the silent auto-connect lattice (docs/federation.md "The seamless
 * session layer"). Pure decision logic + the small storage/cookie helpers
 * the login page and root layout wire up. Everything here keys off
 * DISCOVERY (`instance.auth.sso` presence + the `antasphere` method), never
 * off edition sniffing — on oss `auth.sso` is absent, so every function
 * degrades to "do nothing" by construction.
 *
 * The hint cookie is a HINT, never a security input: it only decides
 * whether a silent `prompt=none` attempt is worth the bounce. The hub's
 * session check is the real gate on the other side.
 */

/** The discovery shape (`instance.auth.sso`) — present on cloud only. */
export type SsoDiscovery = NonNullable<InstanceInfo['auth']['sso']>;

/**
 * Per-tab silent-attempt marker (gate D): written BEFORE navigating to the
 * hub, cleared by the root layout after a successful bootstrap. Its TTL is
 * the loop bound — whatever unforeseen path lands back on /login without an
 * error param gets at most one silent attempt per tab per TTL window.
 */
export const SSO_ATTEMPT_KEY = 'sso.attempt';
export const SSO_ATTEMPT_TTL_MS = 2 * 60_000;

/**
 * Return-to-origin memory (decision 7): the deep link the user started
 * from, written on EVERY tool→hub redirect (silent and interactive),
 * consumed exactly once by the root layout after a successful bootstrap.
 * It exists for journeys that OUTLIVE the ~10-minute OAuth state row
 * (signup → email verification → hub /verified CTA → tool root); ordinary
 * logins land on the exact deep link via `callbackURL` and consume this
 * as a no-op.
 */
export const SSO_PENDING_NEXT_KEY = 'sso.pendingNext';
export const SSO_PENDING_NEXT_TTL_MS = 60 * 60_000;

/**
 * The RFC 8252 / OIDC "no session, no error" family a silent prompt=none
 * authorize answers when the hub holds no (sufficient) session. Expected
 * outcomes, not failures: no error banner, and the hint cookie that
 * promised a session was stale — clear it.
 */
const LOGIN_REQUIRED_ERRORS = new Set([
  'login_required',
  'interaction_required',
  'account_selection_required',
  'consent_required'
]);

export function isLoginRequiredError(code: string | null | undefined): boolean {
  return typeof code === 'string' && LOGIN_REQUIRED_ERRORS.has(code);
}

/** Minimal storage surface so the pure helpers are trivially testable. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Guarded browser storage — null under vitest/privacy modes (never throws). */
function safeStorage(kind: 'session' | 'local'): StorageLike | null {
  try {
    const storage = kind === 'session' ? globalThis.sessionStorage : globalThis.localStorage;
    return storage ?? null;
  } catch {
    return null;
  }
}

/** The browser home of the pendingNext value (localStorage — spans tabs). */
export function pendingNextStorage(): StorageLike | null {
  return safeStorage('local');
}

/** The browser home of the attempt marker (sessionStorage — per tab). */
export function attemptMarkerStorage(): StorageLike | null {
  return safeStorage('session');
}

// ── Cookie helpers ──────────────────────────────────────────────────────────

/** Whether a NON-EMPTY cookie of that exact name is present. */
export function hasCookie(cookies: string, name: string): boolean {
  return cookies.split(';').some((pair) => {
    const eq = pair.indexOf('=');
    if (eq === -1) return false;
    return pair.slice(0, eq).trim() === name && pair.slice(eq + 1).trim() !== '';
  });
}

/**
 * Belt-and-braces CLIENT-side hint clear (the server clears it on
 * /sso/logout too; a login_required bounce has no server leg at all, so
 * this is the only clear there). Mirrors the hub-set attributes (Domain on
 * the shared parent, Path=/) and also clears a host-only shadow. The hint
 * is deliberately not HttpOnly exactly so tools can do this.
 */
export function clearHintCookieClientSide(sso: SsoDiscovery): void {
  if (typeof document === 'undefined') return;
  const base = `${sso.hintCookieName}=; Max-Age=0; Path=/; SameSite=Lax`;
  document.cookie = `${base}; Domain=${sso.hintCookieDomain}`;
  document.cookie = base;
}

// ── Attempt marker (gate D) ─────────────────────────────────────────────────

/** Whether a marker value denotes an attempt within the TTL window. */
export function isAttemptMarkerFresh(marker: string | null, now: number): boolean {
  if (!marker) return false;
  const ts = Number(marker);
  if (!Number.isFinite(ts)) return false;
  return now - ts < SSO_ATTEMPT_TTL_MS;
}

export function readAttemptMarker(storage: StorageLike | null = attemptMarkerStorage()): string | null {
  try {
    return storage?.getItem(SSO_ATTEMPT_KEY) ?? null;
  } catch {
    return null;
  }
}

/** Written BEFORE navigating to the hub — the order is the loop safety. */
export function writeAttemptMarker(now: number, storage: StorageLike | null = attemptMarkerStorage()): void {
  try {
    storage?.setItem(SSO_ATTEMPT_KEY, String(now));
  } catch {
    // Not persistable: the other gates (?error / ?signed_out / the hint
    // clear on login_required) still bound every known cycle.
  }
}

export function clearAttemptMarker(storage: StorageLike | null = attemptMarkerStorage()): void {
  try {
    storage?.removeItem(SSO_ATTEMPT_KEY);
  } catch {
    // nothing to clear
  }
}

// ── pendingNext (decision 7) ────────────────────────────────────────────────

interface PendingNextRecord {
  next: string;
  exp: number;
}

function parsePendingNext(raw: string | null, now: number): string | null {
  if (!raw) return null;
  try {
    const record = JSON.parse(raw) as Partial<PendingNextRecord> | null;
    if (!record || typeof record.next !== 'string' || typeof record.exp !== 'number') return null;
    if (now >= record.exp) return null;
    // safeNext on CONSUME too (defense in depth): a hand-tampered storage
    // value must never become a cross-origin navigation target.
    return safeNext(record.next);
  } catch {
    return null;
  }
}

/**
 * Record the deep link a tool→hub redirect starts from. `safeNext` on
 * write AND on consume. A root ('/') write never clobbers a still-fresh
 * deeper destination: the signup detour re-enters via the tool ROOT
 * (registry launchUrl), and that second dance must not erase the deep link
 * the journey started from.
 */
export function writePendingNext(
  storage: StorageLike | null,
  next: string | null | undefined,
  now: number
): void {
  if (!storage) return;
  const value = safeNext(next);
  try {
    if (value === '/') {
      const existing = parsePendingNext(storage.getItem(SSO_PENDING_NEXT_KEY), now);
      if (existing && existing !== '/') return;
    }
    storage.setItem(
      SSO_PENDING_NEXT_KEY,
      JSON.stringify({ next: value, exp: now + SSO_PENDING_NEXT_TTL_MS } satisfies PendingNextRecord)
    );
  } catch {
    // Not persistable — ordinary logins still land right via callbackURL.
  }
}

/**
 * Read-and-REMOVE (consume-once): the value is deleted whether it is
 * returned, expired, or malformed — a second consume always answers null.
 */
export function consumePendingNext(storage: StorageLike | null, now: number): string | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(SSO_PENDING_NEXT_KEY);
    storage.removeItem(SSO_PENDING_NEXT_KEY);
    return parsePendingNext(raw, now);
  } catch {
    return null;
  }
}

export function clearPendingNext(storage: StorageLike | null = pendingNextStorage()): void {
  try {
    storage?.removeItem(SSO_PENDING_NEXT_KEY);
  } catch {
    // nothing to clear
  }
}

// ── The lattice ─────────────────────────────────────────────────────────────

export interface AutoConnectContext {
  /** `instance.auth.sso` — presence IS the cloud posture (gate A half 1). */
  sso: SsoDiscovery | null | undefined;
  /** `instance.auth.methods` (open enum — gate A half 2). */
  methods: readonly string[];
  /** `document.cookie` at decision time (gate B). */
  cookies: string;
  /** The login page URL's search params (gate C). */
  params: Pick<URLSearchParams, 'get' | 'has'>;
  /** Raw `sso.attempt` sessionStorage value (gate D). */
  attemptMarker: string | null;
  now: number;
  /** Whether the bootstrap resolved a live signed-in user (gate E). */
  signedIn: boolean;
}

export type AutoConnectBlock =
  | 'posture' // A: not a hub-federated instance (oss, or method absent)
  | 'no_hint' // B: no hub-session hint — an anonymous visitor stays anonymous
  | 'error_param' // C: an AS/after-hook error just landed here — never re-bounce
  | 'signed_out' // C: explicit logout landing — quiet notice, never re-connect
  | 'recent_attempt' // D: one attempt per tab per TTL
  | 'live_session'; // E: already signed in

export interface AutoConnectDecision {
  attempt: boolean;
  /** The FIRST failing gate (evaluation order A→B→C→D→E); absent on attempt. */
  blockedBy?: AutoConnectBlock;
  /**
   * The AS answered a silent attempt with the login_required family: the
   * hint promised a hub session that does not exist — clear it so the next
   * visit is a quiet anonymous login page, not another bounce.
   */
  clearStaleHint: boolean;
  /** ?signed_out=1 landing — render the quiet notice. */
  signedOut: boolean;
}

/**
 * The five-gate lattice. All four known cycle entries are bounded:
 * AS silent-failure (?error=login_required…) → gate C + the hint clear;
 * the after-hook's fail-closed landing (?error=sso_projection_failed) →
 * gate C; a logout landing (?signed_out=1) → gate C, with no hint left
 * anyway (gate B); anything unforeseen → gate D's one-attempt-per-tab-TTL.
 */
export function evaluateAutoConnect(ctx: AutoConnectContext): AutoConnectDecision {
  const signedOut = ctx.params.has('signed_out');
  const errorCode = ctx.params.get('error');
  const clearStaleHint = Boolean(ctx.sso) && isLoginRequiredError(errorCode);

  const blocked = (blockedBy: AutoConnectBlock): AutoConnectDecision => ({
    attempt: false,
    blockedBy,
    clearStaleHint,
    signedOut
  });

  if (!ctx.sso || !ctx.methods.includes('antasphere')) return blocked('posture');
  if (!hasCookie(ctx.cookies, ctx.sso.hintCookieName)) return blocked('no_hint');
  if (errorCode !== null) return blocked('error_param');
  if (signedOut) return blocked('signed_out');
  if (isAttemptMarkerFresh(ctx.attemptMarker, ctx.now)) return blocked('recent_attempt');
  if (ctx.signedIn) return blocked('live_session');
  return { attempt: true, clearStaleHint, signedOut };
}

// ── Bootstrap-scoped discovery cache ────────────────────────────────────────

/**
 * The instance's SSO discovery, recorded by the root layout load on every
 * bootstrap so plain modules (session.ts's logout, the hint-watch) can act
 * edition-adaptively without threading the instance through every call
 * site. null = oss / not yet bootstrapped → every consumer no-ops.
 */
let currentSsoDiscovery: SsoDiscovery | null = null;

export function setSsoDiscovery(sso: SsoDiscovery | null | undefined): void {
  currentSsoDiscovery = sso ?? null;
}

export function ssoDiscovery(): SsoDiscovery | null {
  return currentSsoDiscovery;
}
