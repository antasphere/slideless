import { makeOauthBearer } from '@antasphere/chassis-server/testing';

/**
 * The Slideless binding of the shared SSO dances (`@antasphere/chassis-server/testing`):
 * the same helpers, with the OAuth dance requesting the deck read scope.
 */
export {
  json,
  nextIp,
  seedLocalWorkspace,
  ssoInitiate,
  ssoDance,
  ssoLogin,
  expectFailedLogin
} from '@antasphere/chassis-server/testing';

export const oauthBearer = makeOauthBearer('openid presentations:read');
