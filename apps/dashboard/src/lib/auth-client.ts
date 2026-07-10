import { createAuthClient } from 'better-auth/svelte';
import { emailOTPClient, twoFactorClient } from 'better-auth/client/plugins';

// Better Auth is mounted at /api/v1/auth on the same origin that serves the
// SPA. The origin is resolved at runtime (ssr=false — this module only runs
// in the browser) so one build works on every domain an instance is hosted on.
const baseURL =
  typeof window !== 'undefined'
    ? `${window.location.origin}/api/v1/auth`
    : 'http://localhost:3000/api/v1/auth';

export const authClient = createAuthClient({
  baseURL,
  // No onTwoFactorRedirect/twoFactorPage: the login page inspects the
  // sign-in response itself and swaps to its inline second-factor step.
  plugins: [emailOTPClient(), twoFactorClient()]
});

/** A sign-in response body that may be the 2FA interstitial instead of a session. */
export function isTwoFactorRedirect(data: unknown): boolean {
  return Boolean(data && typeof data === 'object' && 'twoFactorRedirect' in data);
}
