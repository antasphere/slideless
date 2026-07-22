import { PlatformClient, PlatformApiError } from '@slideless/sdk';
import { t } from '$lib/i18n';

/** localStorage key for the persisted active-workspace choice (ADR 014). */
export const WORKSPACE_STORAGE_KEY = 'platform.workspaceId';

/**
 * The persisted active workspace, or null. Guarded like the i18n read:
 * localStorage can throw (privacy modes) and does not exist under vitest.
 */
export function storedWorkspaceId(): string | null {
  try {
    return globalThis.localStorage?.getItem(WORKSPACE_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

/**
 * Same-origin client — the HttpOnly session cookie rides every call, plus
 * the persisted X-Workspace-Id when the user chose a workspace (only ever
 * set on multi-workspace instances; absent = the server's default, which
 * IS the sole workspace on a self-host).
 */
export const api = new PlatformClient({ workspaceId: storedWorkspaceId() ?? undefined });

/**
 * Switch the active workspace: persist + full reload (the setLocale
 * pattern — every loader and paged store restarts against the new scope).
 */
export function switchWorkspace(workspaceId: string): void {
  try {
    globalThis.localStorage?.setItem(WORKSPACE_STORAGE_KEY, workspaceId);
  } catch {
    // Not persistable — the reload below still applies it for this visit
    // because the server default takes over (sole workspace) or the user
    // re-picks; never block the switch on storage.
  }
  window.location.reload();
}

/** Drop a stale selection (revoked membership, deleted workspace) — no reload. */
export function clearWorkspaceSelection(): void {
  try {
    globalThis.localStorage?.removeItem(WORKSPACE_STORAGE_KEY);
  } catch {
    // nothing to clear
  }
  api.setWorkspace(null);
}

export { PlatformApiError };

/**
 * Human-readable message for a thrown API error (toast copy). Only the
 * FALLBACKS are localized — a server-originated e.message passes through
 * untranslated (the API speaks English; see internal/i18n.md).
 */
export function errorMessage(e: unknown, fallback = t('common.genericError')): string {
  if (e instanceof PlatformApiError) {
    if (e.status === 429) return t('common.tooManyAttempts');
    // Hub-gate refusals (cloud edition): localized, they can hit any call
    // mid-session when the org gets suspended or removed on the hub.
    if (e.code === 'account_suspended') return t('common.accountSuspended');
    if (e.code === 'hub_unavailable') return t('common.hubUnavailable');
    if (e.code === 'membership_revoked') return t('common.membershipRevoked');
    // The user's own hub grant died (revoked/expired at Antasphere): the
    // fix is one browser re-login — steer there, never a generic error.
    if (e.code === 'hub_grant_expired') return t('common.hubGrantExpired');
    return e.message || fallback;
  }
  if (e instanceof Error) return e.message;
  return fallback;
}
