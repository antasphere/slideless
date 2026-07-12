import type { Counter } from 'prom-client';
import type { Db } from '@slideless/db';
import type {
  EntitlementService,
  IdentityProvider,
  InstanceAuthDescriptor,
  Principal,
  RequestContext,
  UsageSink
} from '@slideless/contract';
import { HUB_SSO_PROVIDER_ID } from '../identity/hub-sso.js';
import { HubEntitlementService, HubPrincipalGate } from '../identity/hub-gate.js';
import { DEFAULT_HUB_DIALS, HubStatusClient, type HubStatusDials } from '../identity/hub-status.js';
import type { AuditService } from '../audit/service.js';
import type { PrincipalGate } from '../middleware/auth-context.js';
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
 * The hub SSO method name the cloud edition advertises in discovery — the
 * better-auth `genericOAuth` providerId registered by identity/hub-sso.ts
 * (its callback lands on /api/v1/auth/oauth2/callback/antasphere, the
 * redirect URI in the hub's TOOL_REGISTRY entry).
 */
export const HUB_SSO_METHOD = HUB_SSO_PROVIDER_ID;

/**
 * The cloud identity binding (Phase 3). Request RESOLUTION stays exactly the
 * local provider's — after the SSO callback mints an ordinary session, every
 * request is sessions + live membership re-check, hub out of the path.
 * What changes is the ADVERTISED entrance (D1, hub-only human login):
 *
 *  - `antasphere` replaces password/email-otp/google — the login page
 *    renders ONLY "Sign in with Antasphere". The local password machinery
 *    stays WIRED (hidden, not blocked): the break-glass CLI remains the
 *    operator door, and blocking /sign-in/email would dead-end it.
 *  - `passwordReset`/`emailChange` are off: credentials and email are the
 *    HUB's to manage (D10 re-syncs email at every login); a local reset
 *    surface would fight the sync.
 *  - `twoFactor` is off: the second factor guards local password/OTP
 *    sign-ins, which the cloud page no longer offers — MFA is the hub's
 *    concern at its own login.
 */
class HubSsoIdentityProvider implements IdentityProvider {
  constructor(private readonly local: IdentityProvider) {}

  resolve(ctx: RequestContext): Promise<Principal | null> {
    return this.local.resolve(ctx);
  }

  describe(): InstanceAuthDescriptor {
    return {
      // Machine entrances are edition-independent; the human entrance is
      // hub-only. 'oauth' stays: every instance is its own OAuth 2.1 AS for
      // /mcp — the hub never appears in the MCP dance.
      methods: [HUB_SSO_METHOD, 'api-key', 'oauth'],
      passwordReset: false,
      emailChange: false,
      twoFactor: false
    };
  }
}

/** The three registry seams the edition owns (events/workspaces are edition-independent). */
export interface EditionSeams {
  identity: IdentityProvider;
  entitlements: EntitlementService;
  usage: UsageSink;
}

/** What the cloud bindings need beyond the seams themselves. */
export interface EditionBindingDeps {
  db: Db;
  audit: AuditService;
  /** Test seam only: cache-dial overrides (D5/D3 values are fixed in production). */
  hubDials?: Partial<HubStatusDials> | undefined;
}

/**
 * The bound seams plus the cloud-only extras boot wires alongside them:
 * the post-resolution principal gate (authContext) and the hub-status
 * Prometheus counters (registered into the app registry). Both are absent
 * on oss by construction.
 */
export interface BoundEditionSeams extends EditionSeams {
  principalGate?: PrincipalGate;
  hubMetrics?: Counter[];
}

/**
 * Bind the registry seams for this instance's edition. `hub` is the single
 * switch: null (EDITION=oss) returns the local defaults UNTOUCHED — the
 * self-host edition carries zero hub surface at runtime; a HubConfig
 * (EDITION=cloud, validated at env parse) selects the cloud bindings.
 */
export function bindEditionSeams(
  hub: HubConfig | null,
  local: EditionSeams,
  logger: Logger,
  deps: EditionBindingDeps
): BoundEditionSeams {
  if (!hub) return local;

  logger.info(
    { hubIssuer: hub.issuerUrl },
    'EDITION=cloud: hub SSO is the human entrance (identity resolution stays local sessions); ' +
      'entitlements + membership re-assertion gate on the hub accounts:status surface ' +
      '(docs/federation.md).'
  );
  // P4: one cached status client feeds both gates. Org suspension: 60 s TTL,
  // stale-while-error 15 min, then fail closed (D5). Membership
  // re-assertion: ~5 min per-(user, org), origin='hub' rows only, and ONLY a
  // definitive hub `active:false` deactivates (D3/D11).
  const status = new HubStatusClient({
    issuerUrl: hub.issuerUrl,
    serviceKey: hub.serviceKey,
    logger,
    dials: { ...DEFAULT_HUB_DIALS, ...deps.hubDials }
  });
  const gate = new HubPrincipalGate({ db: deps.db, status, audit: deps.audit, logger });
  return {
    // P3: hub-only entrance advertised; the SSO machinery itself (relying
    // party, JIT projection, re-sync) lives in identity/hub-sso.ts and is
    // wired through createAuth — resolution stays local by design.
    identity: new HubSsoIdentityProvider(local.identity),
    // P4: the hub org gate wraps the local caps — metered actions in a
    // suspended org deny with a reason even if a caller reaches a handler.
    entitlements: new HubEntitlementService(local.entitlements, status),
    // D6: usage stays the local sink with a no-op downstream for v1; hub
    // ingest is a one-class downstream swap when it ships (plan §4.3).
    usage: local.usage,
    principalGate: gate.assert,
    hubMetrics: status.promMetrics
  };
}
