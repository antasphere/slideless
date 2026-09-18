import { PlatformApiError } from '@slideless/sdk';
import { t, type MessageKey } from '$lib/i18n';
import { safeNext } from '$lib/utils';

/**
 * The pure half of the "New workspace" dialog (PRDCT-2443 cloud, PRDCT-2444
 * self-hosted): every refusal `POST /api/v1/workspaces` can answer, as one
 * plain sentence. ONE dialog for both editions, so the sentences never name
 * where the workspace is created behind the scenes: the person is creating a
 * Slideless workspace, nothing else.
 */
const SENTENCES: Record<string, MessageKey> = {
  validation_error: 'workspace.createErrorName',
  workspace_limit_reached: 'workspace.createErrorLimit',
  workspace_creation_disabled: 'workspace.createErrorDisabled',
  guest_forbidden: 'workspace.createErrorGuest',
  session_required: 'workspace.createErrorSignInAgain',
  unauthenticated: 'workspace.createErrorSignInAgain',
  // The creation may have gone through without the confirmation reaching us:
  // the sentence says so, because a blind second attempt is a second workspace.
  hub_unavailable: 'workspace.createErrorUnconfirmed',
  hub_refused: 'workspace.createErrorRefused',
  hub_link_required: 'workspace.createErrorLinkRequired',
  hub_grant_expired: 'workspace.createErrorSignInAgain',
  // The sign-in is ALIVE but predates workspace creation: nothing expired,
  // so the sentence asks for a new sign-in instead of announcing a loss.
  hub_reauth_required: 'workspace.createErrorFreshSignIn',
  rate_limited: 'workspace.createErrorRateLimited',
  // The two 409 of the Idempotency-Key claim: the first click is still being
  // served, or this opening's key already answered for another name.
  idempotency_in_flight: 'workspace.createErrorInFlight',
  idempotency_key_reuse: 'workspace.createErrorInFlight'
};

/** The codes the person heals by signing in again (the dialog offers the way there). */
const SIGN_IN_AGAIN = new Set([
  'hub_grant_expired',
  'hub_reauth_required',
  'session_required',
  'unauthenticated'
]);
/**
 * Of those, the ones whose session is still GOOD: a reload would come
 * straight back to the app without meeting the login page, and the retry
 * would fail the same way, for ever. The control has to START a sign-in.
 */
const FRESH_SIGN_IN = new Set(['hub_reauth_required']);

export interface WorkspaceCreateFailure {
  message: string;
  /** True when signing in again is the fix: the dialog shows the "Sign in again" control. */
  signInAgain: boolean;
  /**
   * How that control gets the person there. false: a reload meets the login
   * page (the session or the grant is gone). true: the session is alive, so
   * the control starts a sign-in itself (`startFreshSignIn`).
   */
  freshSignIn: boolean;
}

export function workspaceCreateFailure(e: unknown): WorkspaceCreateFailure {
  if (e instanceof PlatformApiError) {
    const key = SENTENCES[e.code] ?? (e.status === 429 ? 'workspace.createErrorRateLimited' : undefined);
    if (key) {
      return {
        message: t(key),
        signInAgain: SIGN_IN_AGAIN.has(e.code),
        freshSignIn: FRESH_SIGN_IN.has(e.code)
      };
    }
  }
  // Anything else (a network failure, a 5xx, a code this page does not know):
  // never the server's English message, which may name what the wording keeps out.
  return { message: t('workspace.createErrorGeneric'), signInAgain: false, freshSignIn: false };
}

/** One Idempotency-Key per dialog opening: a double click cannot create two workspaces. */
export function newIdempotencyKey(): string {
  // randomUUID exists in secure contexts only, and a self-hosted instance may
  // be served over plain http on a private network: getRandomValues is everywhere.
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return `ws-create-${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** The one call the control needs from the auth client (injected: the tests run under node). */
export type StartOauth2 = (options: {
  providerId: string;
  callbackURL: string;
  errorCallbackURL: string;
}) => Promise<{ error?: unknown } | undefined>;

/**
 * Start a real sign-in from a LIVE session and come back to `returnTo`. The
 * return target goes through `safeNext` like every other callbackURL of the
 * dashboard: `window.location.pathname` can begin with `//` (the SPA fallback
 * serves any path), which a browser reads as another host. On success the
 * browser leaves for the sign-in page and this never matters again; false
 * means the sign-in could not be started and the caller falls back to a
 * reload.
 */
export async function startFreshSignIn(oauth2: StartOauth2, returnTo: string): Promise<boolean> {
  try {
    const result = await oauth2({
      providerId: 'antasphere',
      callbackURL: safeNext(returnTo),
      // A refused sign-in lands on the login page with its ?error=<code>.
      errorCallbackURL: '/login'
    });
    return !result?.error;
  } catch {
    return false;
  }
}

/**
 * What the "Sign in again" control does, as one decision the tests can pin:
 * a live session whose grant predates workspace creation (`freshSignIn`)
 * starts the sign-in itself, because a reload would come straight back and
 * fail the same way; anything else, and a sign-in that could not start,
 * reloads, which meets the login page with the way back.
 */
export async function signInAgain(options: {
  freshSignIn: boolean;
  oauth2: StartOauth2;
  returnTo: string;
  reload: () => void;
}): Promise<'sign-in' | 'reload'> {
  if (options.freshSignIn && (await startFreshSignIn(options.oauth2, options.returnTo))) {
    return 'sign-in';
  }
  options.reload();
  return 'reload';
}
