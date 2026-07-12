import { api, clearWorkspaceSelection, storedWorkspaceId } from '$lib/api';
import { initLocale } from '$lib/i18n';
import type { MeResponse } from '@slideless/contract';
import type { LayoutLoad } from './$types';

// Pure SPA: no SSR, no prerender — one index.html fallback boots the app.
export const ssr = false;
export const prerender = false;

/**
 * Bootstrap (decision 11): resolve instance discovery + session behind the
 * neutral splash before anything renders. Route guards read the result:
 * setupRequired → /setup, session → app, no session → /login.
 */
export const load: LayoutLoad = async () => {
  // Fix the UI locale for this page load (and mirror it onto <html lang>)
  // before any component renders — t() stays synchronous everywhere.
  initLocale();

  const instance = await api.instance();

  let me: MeResponse | null = null;
  if (!instance.setupRequired) {
    const session = await api.session().catch(() => null);
    if (session?.user) {
      // A session without a live membership (deactivated member) counts as
      // signed out — /me is the source of truth for role + workspace.
      me = await api.me().catch(() => null);
      if (!me && storedWorkspaceId()) {
        // Stale persisted workspace (membership revoked, workspace gone):
        // X-Workspace-Id fails closed server-side. Self-heal — drop the
        // selection and retry once against the server default.
        clearWorkspaceSelection();
        me = await api.me().catch(() => null);
      }
    }
  }

  return { instance, me };
};
