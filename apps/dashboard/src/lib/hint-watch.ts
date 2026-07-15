import type { MeResponse } from '@slideless/contract';
import { hasCookie, type SsoDiscovery } from '$lib/sso';

/**
 * SL-4 — the hint-watch: "logout anywhere = logout everywhere" convergence
 * for OPEN tabs. When the hub hint cookie disappears (a logout on the hub
 * or on any sibling tool cleared it), a signed-in tab whose user's ONLY way
 * in is hub SSO signs itself out instead of lingering on a session the user
 * believes ended.
 *
 * The predicate is deliberately narrow — every condition is a safety rail:
 *  - `sso` present: discovery-gated; on oss this NEVER fires (no auth.sso).
 *  - `via === 'session'`: machine credentials are never watch targets.
 *  - `ssoOnly === true` EXACTLY: a break-glass-capable operator holds a
 *    credential account and is therefore never ssoOnly (server-derived, /me)
 *    — the watch must NEVER sign an operator out, hint or no hint. An
 *    absent/undefined field (oss, machine, older server) means NO.
 *  - hint absent: the hint is a HINT — it triggers a local sign-out only,
 *    never anything security-bearing.
 */
export function shouldHintWatchSignOut(input: {
  sso: SsoDiscovery | null | undefined;
  me: Pick<MeResponse, 'via' | 'ssoOnly'> | null | undefined;
  cookies: string;
}): boolean {
  const { sso, me } = input;
  if (!sso) return false;
  if (!me || me.via !== 'session') return false;
  if (me.ssoOnly !== true) return false;
  return !hasCookie(input.cookies, sso.hintCookieName);
}

/** Minimum spacing between visibility-driven checks. */
export const HINT_WATCH_THROTTLE_MS = 30_000;

export interface HintWatchDeps {
  getSso(): SsoDiscovery | null | undefined;
  getMe(): Pick<MeResponse, 'via' | 'ssoOnly'> | null | undefined;
  getCookies(): string;
  signOut(): void | Promise<void>;
  now?(): number;
}

/**
 * A throttled checker the root layout wires to bootstrap +
 * visibilitychange→visible. Fires `signOut` at most once for the page's
 * lifetime (the sign-out navigates away anyway — the latch just keeps the
 * async window race-free).
 */
export function createHintWatch(deps: HintWatchDeps): { check(): boolean } {
  const now = deps.now ?? Date.now;
  let lastCheck: number | null = null;
  let fired = false;
  return {
    check(): boolean {
      if (fired) return false;
      const t = now();
      if (lastCheck !== null && t - lastCheck < HINT_WATCH_THROTTLE_MS) return false;
      lastCheck = t;
      const signOut = shouldHintWatchSignOut({
        sso: deps.getSso(),
        me: deps.getMe(),
        cookies: deps.getCookies()
      });
      if (!signOut) return false;
      fired = true;
      void deps.signOut();
      return true;
    }
  };
}
