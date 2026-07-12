/**
 * The central-rail seam: three small interfaces wired through the boot-time
 * module registry. The central account/credits service is NOT part of the
 * template — these interfaces are the socket it plugs into later with zero
 * refactor. Template defaults: LocalIdentityProvider, AllowAllEntitlements,
 * a no-op UsageSink.
 */

/** Structural Headers so the contract stays lib-agnostic (works in DOM and Node). */
export interface HeaderReader {
  get(name: string): string | null;
}

export interface RequestContext {
  /** Raw request headers (credential material lives here). */
  headers: HeaderReader;
  path: string;
  method: string;
  requestId: string;
}

/**
 * Active-workspace selection header for SESSION principals (ADR 014). A
 * session client MAY send it to name which of the user's workspaces this
 * request targets; the identity layer verifies an ACTIVE membership of that
 * workspace and resolves to null otherwise (fail closed — no oracle about
 * the workspace's existence). Absent, the user's sole active membership is
 * used, or the deterministic default (oldest active membership) when they
 * hold several. Machine credentials (API keys, OAuth tokens) IGNORE this
 * selection semantically — they bind one workspace at mint time — and a
 * mismatching header on a machine request is rejected outright.
 */
export const ACTIVE_WORKSPACE_HEADER = 'x-workspace-id';

/**
 * The resolved caller of ONE request. A Principal is scoped to exactly ONE
 * workspace per request (ADR 014): `workspaceId` is the workspace named by
 * the presented credential — machine credentials bind it at mint/consent
 * time, human sessions choose it via {@link ACTIVE_WORKSPACE_HEADER}. A
 * user's OTHER memberships are deliberately not represented here; a request
 * never spans workspaces.
 */
export interface Principal {
  userId: string;
  email: string;
  name: string;
  workspaceId: string;
  role: 'owner' | 'admin' | 'member';
  via: 'session' | 'api_key' | 'oauth';
  /** Scope allowlist for machine principals; null = full role-based (session). */
  scopes: ReadonlySet<string> | null;
  apiKeyId?: string;
  /** Expiry of the presented API key (ISO 8601) — absent for non-expiring keys. */
  apiKeyExpiresAt?: string;
  /** Central account id — undefined in local mode. */
  accountRef?: string;
}

export interface InstanceAuthDescriptor {
  methods: Array<'password' | 'email-otp' | 'google' | 'api-key' | 'oauth'>;
  /** Self-serve password reset is available (requires a configured email driver). */
  passwordReset: boolean;
  /** Self-serve email change is available (requires a configured email driver). */
  emailChange: boolean;
  /** Opt-in per-user 2FA (TOTP + backup codes) is available on this instance. */
  twoFactor: boolean;
}

export interface IdentityProvider {
  /** Resolve a request to a live principal (fresh membership check) or null. */
  resolve(ctx: RequestContext): Promise<Principal | null>;
  /** Feeds the instance discovery endpoint. */
  describe(): InstanceAuthDescriptor;
}

export interface MeteredAction {
  /** Meter key, e.g. 'files.upload'. */
  key: string;
  quantity: number;
  unit: string;
}

export type EntitlementDecision = { allowed: true } | { allowed: false; reason: string };

/** Per-principal general-API request quota, enforced by the server's quota middleware. */
export interface RequestQuota {
  /** Sustained allowance per principal per minute. 0 = unlimited (the limiter is skipped). */
  perMinute: number;
  /** Spike cap per principal per second inside the minute window. 0 = no burst smoothing. */
  burstPerSecond: number;
}

export interface EntitlementService {
  check(
    principal: Principal,
    action: MeteredAction,
    ctx?: Record<string, unknown>
  ): Promise<EntitlementDecision>;
  /**
   * Request-rate quota for this principal. The template default returns the
   * instance-level env caps for everyone; a plan-aware edition varies it per
   * account/plan. The quota is enforced per authenticated principal identity
   * (API key id / OAuth subject / session user id), never per client header.
   */
  getRequestQuota(principal: Principal): Promise<RequestQuota>;
}

export interface UsageEvent {
  /** ULID — the idempotency key; receivers dedupe on it (at-least-once emission). */
  id: string;
  meter: string;
  quantity: number;
  unit: string;
  occurredAt: string; // ISO 8601
  workspaceId: string;
  accountRef?: string;
  source: {
    instanceId: string;
    edition: string;
    version: string;
  };
}

export interface UsageSink {
  emit(event: UsageEvent): Promise<void>;
}
