import {
  api,
  clearWorkspaceSelection,
  rememberWorkspace,
  storedWorkspaceId,
  PlatformApiError
} from '$lib/api';
import { initLocale } from '$lib/i18n';
import { readOrgLanding } from '$lib/org-landing';
import { clearAttemptMarker, setSsoDiscovery } from '$lib/sso';
import type { MeResponse } from '@slideless/contract';
import type { LayoutLoad } from './$types';

/**
 * The ONE hub-gate refusal the shell must surface instead of treating as
 * "signed out": the hub has been unreachable beyond the fail-closed window
 * (cloud edition). Suspension no longer strands the shell — GET /me is
 * exempt (visible-but-blocked), so a suspended org renders as a badged,
 * disabled entry instead of an error page; and a dead hub grant
 * (hub_grant_expired) deliberately falls through to the login bounce,
 * where "Sign in with Antasphere" is exactly the re-auth that heals it.
 */
export type HubGateError = 'hub_unavailable';

function hubGateError(e: unknown): HubGateError | null {
  if (e instanceof PlatformApiError && e.code === 'hub_unavailable') {
    return e.code;
  }
  return null;
}

// Pure SPA: no SSR, no prerender — one index.html fallback boots the app.
export const ssr = false;
export const prerender = false;

/**
 * Bootstrap (decision 11): resolve instance discovery + session behind the
 * neutral splash before anything renders. Route guards read the result:
 * setupRequired → /setup, session → app, no session → /login.
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

  const instance = await api.instance();
  // Record the SSO discovery for the edition-adaptive modules (logout,
  // hint-watch, hint clears). null on oss → they all no-op by construction.
  setSsoDiscovery(instance.auth.sso ?? null);

  let me: MeResponse | null = null;
  let meError: HubGateError | null = null;
  if (!instance.setupRequired) {
    const session = await api.session().catch(() => null);
    if (session?.user) {
      // A session without a live membership (deactivated member) counts as
      // signed out — /me is the source of truth for role + workspace. A
      // hub-gate refusal (suspended org / hub down, cloud edition) is NOT
      // "signed out": remember it so the shell can say why (/suspended).
      const fetchMe = () =>
        api.me().catch((e: unknown) => {
          meError = hubGateError(e) ?? meError;
          return null;
        });
      if (landing) {
        // Select the named organization for this read: the server resolves
        // a hub organization id against the caller's own active memberships
        // and fails closed on any other. Resolved, it is remembered by its
        // LOCAL id like a switch in the sidebar; refused (not a member, a
        // tool this organization does not open), the landing is dropped
        // and the bootstrap goes on with the stored selection.
        api.setWorkspace(landing);
        me = await fetchMe();
        if (me?.activeWorkspaceId) rememberWorkspace(me.activeWorkspaceId);
        else {
          me = null;
          meError = null;
          api.setWorkspace(storedWorkspaceId());
        }
      }
      if (!me) me = await fetchMe();
      if (!me && storedWorkspaceId()) {
        // Stale persisted workspace (membership revoked, workspace gone):
        // X-Workspace-Id fails closed server-side. Self-heal — drop the
        // selection and retry once against the server default.
        clearWorkspaceSelection();
        me = await fetchMe();
      }
    }
  }

  // A successful signed-in bootstrap retires the per-tab silent-attempt
  // marker (SL-3 gate D): the attempt worked, so the next signed-out visit
  // in this tab may attempt again.
  if (me) clearAttemptMarker();

  return { instance, me, meError: me ? null : meError };
};
