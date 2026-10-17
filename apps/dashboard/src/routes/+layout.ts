import { api, clearWorkspaceSelection, rememberWorkspace, storedWorkspaceId } from '$lib/api';
import { bootstrap, type HubGateError } from '$lib/bootstrap';
import { initLocale } from '$lib/i18n';
import { readOrgLanding } from '$lib/org-landing';
import { clearAttemptMarker, setSsoDiscovery } from '$lib/sso';
import type { LayoutLoad } from './$types';

export type { HubGateError };

// Pure SPA: no SSR, no prerender — one index.html fallback boots the app.
export const ssr = false;
export const prerender = false;

/**
 * Bootstrap (decision 11): resolve instance discovery + session behind the
 * neutral splash before anything renders, in one round trip ($lib/bootstrap).
 * Route guards read the result: setupRequired → /setup, session → app, no
 * session → /login.
 */
export const load: LayoutLoad = async ({ url, untrack }) => {
  // Fix the UI locale for this page load (and mirror it onto <html lang>)
  // before any component renders — t() stays synchronous everywhere.
  initLocale();

  // The organization a hub tool card named on the way in (`?org=<hub
  // organization id>`, PRDCT-3321), read once: untracked, so this bootstrap
  // never re-runs on a later navigation's query. The root layout strips the
  // parameter from the address once the landing is applied.
  const landing = untrack(() => readOrgLanding(url.searchParams));

  const { instance, me, meError } = await bootstrap(
    api,
    { stored: storedWorkspaceId, remember: rememberWorkspace, clear: clearWorkspaceSelection },
    landing
  );
  // Record the SSO discovery for the edition-adaptive modules (logout,
  // hint-watch, hint clears). null on oss → they all no-op by construction.
  setSsoDiscovery(instance.auth.sso ?? null);

  // A successful signed-in bootstrap retires the per-tab silent-attempt
  // marker (SL-3 gate D): the attempt worked, so the next signed-out visit
  // in this tab may attempt again.
  if (me) clearAttemptMarker();

  return { instance, me, meError };
};
