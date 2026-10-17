import type { MeResponse } from '@slideless/contract';
import { PlatformApiError } from '$lib/api';

/**
 * The dashboard's bootstrap: what the root layout resolves before anything
 * renders (decision 11), as ONE round trip (PRDCT-3584).
 *
 * Before: instance, then the session, then me, each awaited before the next
 * (and the whole chain again after the redirect to the login page): three
 * round trips the person watched as the splash. The three answers do not
 * depend on each other, so they go out together, and only the two rare
 * repairs below cost a second trip:
 *
 *  - the organization a hub tool card named (`?org=…`, PRDCT-3321) was
 *    refused: the stored selection is read instead;
 *  - a stale stored selection (membership revoked, workspace gone) failed
 *    closed: it is dropped and the server default is read.
 *
 * The session read is kept, and kept parallel, because it is what tells a
 * signed-out visitor from a signed-in person whose read failed: `/me`
 * answers the same 401 to both, and the self-heal above must never drop a
 * signed-out visitor's remembered organization.
 */

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

export function hubGateError(e: unknown): HubGateError | null {
  if (e instanceof PlatformApiError && e.code === 'hub_unavailable') {
    return e.code;
  }
  return null;
}

/** The slice of the API client the bootstrap drives (the real one, or a test's). */
export interface BootstrapApi<
  TInstance extends { setupRequired: boolean },
  TMe extends { activeWorkspaceId: string | null }
> {
  instance(): Promise<TInstance>;
  session(): Promise<{ user: unknown } | null>;
  me(): Promise<TMe>;
  setWorkspace(workspaceId: string | null): void;
}

/** The workspace memory the bootstrap reads and repairs (localStorage, or a test's). */
export interface BootstrapSelection {
  stored(): string | null;
  remember(workspaceId: string): void;
  clear(): void;
}

export interface BootstrapResult<TInstance, TMe> {
  instance: TInstance;
  me: TMe | null;
  meError: HubGateError | null;
}

export async function bootstrap<
  TInstance extends { setupRequired: boolean },
  TMe extends MeResponse | { activeWorkspaceId: string | null }
>(
  api: BootstrapApi<TInstance, TMe>,
  selection: BootstrapSelection,
  landing: string | null
): Promise<BootstrapResult<TInstance, TMe>> {
  let meError: HubGateError | null = null;
  const readMe = () =>
    api.me().catch((e: unknown) => {
      meError = hubGateError(e) ?? meError;
      return null;
    });

  // Select the named organization for the first read: the server resolves a
  // hub organization id against the caller's own active memberships and
  // fails closed on any other.
  if (landing) api.setWorkspace(landing);

  // One round trip. A signed-out visitor's `me` answers 401 and is dropped
  // below without a second thought; the session read is what says so.
  const [instance, session, firstMe] = await Promise.all([
    api.instance(),
    api.session().catch(() => null),
    readMe()
  ]);

  let me: TMe | null = null;
  if (!instance.setupRequired && session?.user) {
    // A session without a live membership (deactivated member) counts as
    // signed out — /me is the source of truth for role + workspace. A
    // hub-gate refusal (suspended org / hub down, cloud edition) is NOT
    // "signed out": remembered so the shell can say why (/suspended).
    me = firstMe;
    if (landing) {
      // Resolved, the landing is remembered by its LOCAL id like a switch in
      // the sidebar; refused (not a member, a tool this organization does not
      // open), it is dropped and the bootstrap goes on with the stored
      // selection.
      if (me?.activeWorkspaceId) selection.remember(me.activeWorkspaceId);
      else {
        me = null;
        meError = null;
        api.setWorkspace(selection.stored());
        me = await readMe();
      }
    }
    if (!me && selection.stored()) {
      // Stale persisted workspace (membership revoked, workspace gone):
      // X-Workspace-Id fails closed server-side. Self-heal — drop the
      // selection and retry once against the server default.
      selection.clear();
      me = await readMe();
    }
  }

  return { instance, me, meError: me ? null : meError };
}
