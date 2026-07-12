import type {
  EntitlementService,
  IdentityProvider,
  InstanceAuthDescriptor,
  Principal,
  RequestContext,
  UsageSink
} from '@slideless/contract';
import type { HubConfig } from '../env.js';
import type { Logger } from '../logger.js';

/**
 * The edition split (docs/federation.md): one codebase, one Docker image,
 * two seam bindings selected purely by instance config. This module is the
 * ONLY place edition decides which implementations the boot-time registry
 * gets — `oss` binds the local defaults byte-identically; `cloud` rebinds
 * the hub-federating variants here as they land phase by phase.
 */

/**
 * The hub SSO method name the cloud edition advertises in discovery — and
 * the better-auth `genericOAuth` providerId Phase 3 registers (its callback
 * lands on /api/v1/auth/oauth2/callback/antasphere, the redirect URI in the
 * hub's TOOL_REGISTRY entry).
 */
export const HUB_SSO_METHOD = 'antasphere';

/**
 * Phase 2 stub for the cloud identity binding: request resolution stays
 * exactly the local provider's (sessions + live membership re-check) —
 * discovery additionally advertises the hub SSO method so SPAs/CLIs can
 * start rendering the entrance the moment it exists.
 *
 * TODO(P3): replace with the real SSO binding — genericOAuth relying party
 * against HUB_ISSUER_URL, HubJwtVerifier (remote JWKS, iss/aud pinned), JIT
 * provisioning + lazy org projection (workspaces.centralAccountId), role
 * from the verified hub assertion re-synced at every login (D11), and the
 * D1 hub-only posture (hide password/OTP from `methods`; break-glass CLI
 * stays the operator door). Until then the local methods stay advertised
 * because they ARE still the working entrance.
 */
class CloudIdentityStub implements IdentityProvider {
  constructor(private readonly local: IdentityProvider) {}

  resolve(ctx: RequestContext): Promise<Principal | null> {
    return this.local.resolve(ctx);
  }

  describe(): InstanceAuthDescriptor {
    const local = this.local.describe();
    return { ...local, methods: [...local.methods, HUB_SSO_METHOD] };
  }
}

/** The three registry seams the edition owns (events/workspaces are edition-independent). */
export interface EditionSeams {
  identity: IdentityProvider;
  entitlements: EntitlementService;
  usage: UsageSink;
}

/**
 * Bind the registry seams for this instance's edition. `hub` is the single
 * switch: null (EDITION=oss) returns the local defaults UNTOUCHED — the
 * self-host edition carries zero hub surface at runtime; a HubConfig
 * (EDITION=cloud, validated at env parse) selects the cloud bindings.
 */
export function bindEditionSeams(hub: HubConfig | null, local: EditionSeams, logger: Logger): EditionSeams {
  if (!hub) return local;

  logger.warn(
    { hubIssuer: hub.issuerUrl },
    'EDITION=cloud: hub seams are Phase 2 stubs — identity resolution and entitlements still ' +
      'run locally. SSO login lands in Phase 3, hub entitlements in Phase 4 (docs/federation.md).'
  );
  return {
    // TODO(P3): HubSsoIdentityProvider — SSO entrance + JIT + lazy projection
    // (slideless-cloud-binding-plan §4.1); resolution itself stays local.
    identity: new CloudIdentityStub(local.identity),
    // TODO(P4): HubEntitlementService — hub account-status gate keyed on
    // workspaces.centralAccountId, cached 60s / stale-while-error 15min,
    // suspended => deny with reason (plan §4.2, D5).
    entitlements: local.entitlements,
    // D6: usage stays the local sink with a no-op downstream for v1; hub
    // ingest is a one-class downstream swap when it ships (plan §4.3).
    usage: local.usage
  };
}
