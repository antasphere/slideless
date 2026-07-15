import { goto, invalidateAll } from '$app/navigation';
import { api } from '$lib/api';
import { authClient } from '$lib/auth-client';
import { clearHintCookieClientSide, clearPendingNext, pendingNextStorage, ssoDiscovery } from '$lib/sso';

/**
 * Signs out and lands on /login — edition-adaptive off the bootstrap's
 * discovery (`instance.auth.sso` presence), never edition-sniffing.
 *
 * oss: byte-identical to the pre-SSO behavior (local sign-out → /login).
 *
 * cloud (SL-4, single logout): POST /sso/logout — the RESPONSE already
 * revoked the local session and cleared the hint cookie server-side; we
 * belt-and-braces the hint clear client-side, then hard-navigate to the
 * hub end-session URL (which ends the ANCHOR session and bounces back to
 * /login?signed_out=1) or straight to the signed-out landing when no hub
 * leg exists. Any failure degrades to local sign-out + client hint clear +
 * the signed-out landing — the local sign-out and the hint clear can never
 * fail together, so an insta-relogin is impossible on every path: the
 * landing's ?signed_out=1 (lattice gate C) and the cleared hint (gate B)
 * each block the silent auto-connect on their own.
 */
export async function signOutToLogin(): Promise<void> {
  const sso = ssoDiscovery();
  if (!sso) {
    try {
      await authClient.signOut();
    } catch {
      // Even if the call fails the session may be gone — fall through to login.
    }
    await invalidateAll();
    await goto('/login');
    return;
  }

  // A logout also abandons any in-flight return-to-origin journey.
  clearPendingNext(pendingNextStorage());
  try {
    const { url } = await api.ssoLogout();
    clearHintCookieClientSide(sso);
    window.location.assign(url ?? '/login?signed_out=1');
  } catch {
    try {
      await authClient.signOut();
    } catch {
      // The hint clear below still cuts the silent auto-connect; a
      // lingering server-side session (if any) dies at its fixed expiry.
    }
    clearHintCookieClientSide(sso);
    window.location.assign('/login?signed_out=1');
  }
}

/** Re-runs the root bootstrap (instance + session + me) after auth changes. */
export async function refreshSession(): Promise<void> {
  await invalidateAll();
}
