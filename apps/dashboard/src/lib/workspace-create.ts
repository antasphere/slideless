import { PlatformApiError } from '@slideless/sdk';
import { t, type MessageKey } from '$lib/i18n';

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
  rate_limited: 'workspace.createErrorRateLimited',
  // The two 409 of the Idempotency-Key claim: the first click is still being
  // served, or this opening's key already answered for another name.
  idempotency_in_flight: 'workspace.createErrorInFlight',
  idempotency_key_reuse: 'workspace.createErrorInFlight'
};

/** The codes the person heals by signing in again (the dialog offers the way there). */
const SIGN_IN_AGAIN = new Set(['hub_grant_expired', 'session_required', 'unauthenticated']);

export interface WorkspaceCreateFailure {
  message: string;
  /** True when signing in again is the fix: a reload lands on the login page with the way back. */
  signInAgain: boolean;
}

export function workspaceCreateFailure(e: unknown): WorkspaceCreateFailure {
  if (e instanceof PlatformApiError) {
    const key = SENTENCES[e.code] ?? (e.status === 429 ? 'workspace.createErrorRateLimited' : undefined);
    if (key) return { message: t(key), signInAgain: SIGN_IN_AGAIN.has(e.code) };
  }
  // Anything else (a network failure, a 5xx, a code this page does not know):
  // never the server's English message, which may name what the wording keeps out.
  return { message: t('workspace.createErrorGeneric'), signInAgain: false };
}

/** One Idempotency-Key per dialog opening: a double click cannot create two workspaces. */
export function newIdempotencyKey(): string {
  // randomUUID exists in secure contexts only, and a self-hosted instance may
  // be served over plain http on a private network: getRandomValues is everywhere.
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return `ws-create-${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}
