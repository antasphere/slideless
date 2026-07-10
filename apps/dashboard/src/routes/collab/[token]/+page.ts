import { api, PlatformApiError } from '$lib/api';
import type { CollaboratorLookup } from '@slideless/contract';
import type { PageLoad } from './$types';

export interface CollabClaimState {
  token: string;
  lookup: CollaboratorLookup | null;
  /** 'dead' = 404/410 — invalid, expired, revoked, or already used. */
  state: 'ok' | 'dead' | 'error';
}

/** Public page: anyone with the claim link can resolve it — no auth guard. */
export const load: PageLoad = async ({ params }): Promise<CollabClaimState> => {
  try {
    const lookup = await api.lookupCollaboratorInvite(params.token);
    return { token: params.token, lookup, state: 'ok' };
  } catch (e) {
    if (e instanceof PlatformApiError && (e.status === 404 || e.status === 410)) {
      return { token: params.token, lookup: null, state: 'dead' };
    }
    return { token: params.token, lookup: null, state: 'error' };
  }
};
