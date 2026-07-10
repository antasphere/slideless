import { api, PlatformApiError } from '$lib/api';
import type { InvitationLookup } from '@platform/contract';
import type { PageLoad } from './$types';

export interface InviteState {
  token: string;
  lookup: InvitationLookup | null;
  /** 'dead' = 404/410 — invalid, expired, revoked, or already used. */
  state: 'ok' | 'dead' | 'error';
}

/** Public page: anyone with the link can resolve it — no auth guard. */
export const load: PageLoad = async ({ params }): Promise<InviteState> => {
  try {
    const lookup = await api.lookupInvitation(params.token);
    return { token: params.token, lookup, state: 'ok' };
  } catch (e) {
    if (e instanceof PlatformApiError && (e.status === 404 || e.status === 410)) {
      return { token: params.token, lookup: null, state: 'dead' };
    }
    return { token: params.token, lookup: null, state: 'error' };
  }
};
