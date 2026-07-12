import { and, eq } from 'drizzle-orm';
import { account, workspaceMembers, type Db } from '@slideless/db';
import type {
  EntitlementDecision,
  EntitlementService,
  MeteredAction,
  Principal,
  RequestQuota
} from '@slideless/contract';
import type { AuditService } from '../audit/service.js';
import type { Logger } from '../logger.js';
import type { PrincipalGate, PrincipalGateResult } from '../middleware/auth-context.js';
import { HUB_SSO_PROVIDER_ID } from './hub-sso.js';
import { pruneOversized, type HubStatusClient } from './hub-status.js';

/**
 * Phase 4 of the cloud binding (docs/federation.md, ADR 016): the two
 * continuous hub gates that hold BETWEEN logins.
 *
 *  - `HubEntitlementService` wraps the local caps and denies metered
 *    actions for suspended/unknown hub orgs (defense in depth — the
 *    principal gate below already refuses such requests at the door);
 *  - `HubPrincipalGate` is the post-resolution veto authContext runs on
 *    EVERY authenticated /api/v1 request: the org suspension gate (D5
 *    dials) plus the H2 membership re-assertion (D3/D11) that propagates
 *    hub org removals and role changes into the projection without waiting
 *    for the next SSO login.
 *
 * Both key STRICTLY off `principal.accountRef` (= the workspace's
 * `centralAccountId`): a workspace with no hub projection — the operator's
 * setup workspace, any local/guest-origin one — is skipped entirely, and
 * the re-assertion additionally touches ONLY `origin='hub'` membership
 * rows. Local and guest rows are never hub truth and are never written.
 */

const SUSPENDED_MESSAGE = 'This organization is suspended or no longer exists on Antasphere';
const UNAVAILABLE_MESSAGE =
  'The Antasphere account service has been unreachable for too long; requests are refused until it recovers';

export class HubEntitlementService implements EntitlementService {
  constructor(
    private readonly inner: EntitlementService,
    private readonly status: HubStatusClient
  ) {}

  async check(
    principal: Principal,
    action: MeteredAction,
    ctx?: Record<string, unknown>
  ): Promise<EntitlementDecision> {
    if (principal.accountRef) {
      const org = await this.status.orgStatus(principal.accountRef);
      if (org === 'suspended' || org === 'not_found') {
        return { allowed: false, reason: SUSPENDED_MESSAGE };
      }
      if (org === 'unavailable') {
        return { allowed: false, reason: UNAVAILABLE_MESSAGE };
      }
    }
    return this.inner.check(principal, action, ctx);
  }

  getRequestQuota(principal: Principal): Promise<RequestQuota> {
    return this.inner.getRequestQuota(principal);
  }
}

export interface HubPrincipalGateDeps {
  db: Db;
  status: HubStatusClient;
  audit: AuditService;
  logger: Logger;
  /** Test seam. */
  now?: () => number;
}

export class HubPrincipalGate {
  /** (local userId:workspaceId) → last re-assertion timestamp (D3 ~5 min TTL). */
  private readonly memberCache = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly deps: HubPrincipalGateDeps) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * The authContext hook. Ordering inside: org status first (cheapest, one
   * shared per-org cache), then the per-(user, org) membership
   * re-assertion. A `{ ok: true, role }` result carries a freshly synced
   * role that differs from the resolved principal's — the caller applies
   * it so a demotion/promotion takes effect on THIS request, not the next.
   */
  readonly assert: PrincipalGate = async (principal) => {
    if (!principal.accountRef) return { ok: true };

    const org = await this.deps.status.orgStatus(principal.accountRef);
    if (org === 'suspended' || org === 'not_found') {
      return { ok: false, status: 403, code: 'account_suspended', message: SUSPENDED_MESSAGE };
    }
    if (org === 'unavailable') {
      return { ok: false, status: 403, code: 'hub_unavailable', message: UNAVAILABLE_MESSAGE };
    }

    return this.reassertMembership(principal);
  };

  private async reassertMembership(principal: Principal): Promise<PrincipalGateResult> {
    const key = `${principal.userId}:${principal.workspaceId}`;
    const checkedAt = this.memberCache.get(key);
    const now = this.now();
    if (checkedAt !== undefined && now - checkedAt < this.deps.status.dials.memberTtlMs) {
      return { ok: true };
    }

    const db = this.deps.db;
    const [row] = await db
      .select({ origin: workspaceMembers.origin, role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.userId, principal.userId),
          eq(workspaceMembers.workspaceId, principal.workspaceId),
          eq(workspaceMembers.isActive, true)
        )
      )
      .limit(1);
    // Row vanished between resolution and this gate: resolution truth wins
    // on the next request; nothing to assert against the hub.
    if (!row) return { ok: true };
    // ONLY hub-origin rows are hub truth. A guest grant or a local row in a
    // projected workspace is the tool's own business — never re-asserted,
    // never deactivated from here (D3).
    if (row.origin !== 'hub') {
      this.remember(key, now);
      return { ok: true };
    }

    // The H2 pair is (centralAccountId, hub sub) — the sub rides the
    // antasphere account link P3 wrote; guardSingleHubIdentity keeps it
    // unique per user. A hub-origin row without a link is residue we cannot
    // re-assert: fail open, say so.
    const [link] = await db
      .select({ sub: account.accountId })
      .from(account)
      .where(and(eq(account.userId, principal.userId), eq(account.providerId, HUB_SSO_PROVIDER_ID)))
      .limit(1);
    if (!link) {
      this.deps.logger.warn(
        { userId: principal.userId, workspaceId: principal.workspaceId },
        'hub-origin membership without a hub identity link — cannot re-assert (failing open)'
      );
      this.remember(key, now);
      return { ok: true };
    }

    const status = await this.deps.status.memberStatus(principal.accountRef!, link.sub);

    if (status.kind === 'inconclusive') {
      // Errors/absent-H2 NEVER deactivate (the only deactivation signal is
      // a definitive 200 {active:false}); retry at the next cache expiry.
      this.remember(key, now);
      return { ok: true };
    }

    if (status.kind === 'inactive') {
      // Definitive: removed hub-side. Deactivate the local row — keyed to
      // origin='hub' so a racing origin change can never strand a
      // local/guest row — and the existing live-membership re-check locks
      // this user out of sessions, API keys, and OAuth bearers everywhere.
      // Reactivation happens ONLY at the next successful SSO login (the
      // projection upsert), which the hub grants only to live members.
      await db
        .update(workspaceMembers)
        .set({ isActive: false })
        .where(
          and(
            eq(workspaceMembers.userId, principal.userId),
            eq(workspaceMembers.workspaceId, principal.workspaceId),
            eq(workspaceMembers.origin, 'hub')
          )
        );
      this.memberCache.delete(key);
      await this.deps.audit.write({
        workspaceId: principal.workspaceId,
        principal: null,
        action: 'member.deactivate',
        resourceType: 'member',
        resourceId: principal.userId,
        metadata: { reason: 'hub_reassertion' }
      });
      this.deps.logger.info(
        { userId: principal.userId, workspaceId: principal.workspaceId },
        'hub re-assertion: membership removed hub-side — local membership deactivated'
      );
      return {
        ok: false,
        status: 401,
        code: 'membership_revoked',
        message: 'Your membership of this organization was removed on Antasphere'
      };
    }

    // Live member. Sync a role delta (D11) — hub-origin rows only, and the
    // fresh role is returned so THIS request already runs under it.
    if (status.role && status.role !== row.role) {
      await db
        .update(workspaceMembers)
        .set({ role: status.role })
        .where(
          and(
            eq(workspaceMembers.userId, principal.userId),
            eq(workspaceMembers.workspaceId, principal.workspaceId),
            eq(workspaceMembers.origin, 'hub')
          )
        );
      await this.deps.audit.write({
        workspaceId: principal.workspaceId,
        principal: null,
        action: 'member.update',
        resourceType: 'member',
        resourceId: principal.userId,
        metadata: { reason: 'hub_reassertion', role: status.role, previousRole: row.role }
      });
      this.deps.logger.info(
        { userId: principal.userId, workspaceId: principal.workspaceId, role: status.role },
        'hub re-assertion: role synced from the hub'
      );
      this.remember(key, now);
      return { ok: true, role: status.role };
    }

    this.remember(key, now);
    return { ok: true };
  }

  private remember(key: string, now: number): void {
    pruneOversized(this.memberCache, (checkedAt) => now - checkedAt >= this.deps.status.dials.memberTtlMs);
    this.memberCache.set(key, now);
  }
}
