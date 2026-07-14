import { Counter } from 'prom-client';
import { and, eq, inArray, isNotNull, notInArray } from 'drizzle-orm';
import { account, workspaceMembers, workspaces, type Db } from '@slideless/db';
import type { AuditService } from '../audit/service.js';
import type { Logger } from '../logger.js';
import { HUB_SSO_PROVIDER_ID } from './hub-sso.js';
import { projectOrgMembership } from './hub-projection.js';
import { pruneOversized, type HubStatusClient } from './hub-status.js';

/**
 * H4 read-through org reconciliation (ADR 018, docs/federation.md): org and
 * membership truth live ONLY at the hub, and Slideless reflects it at page
 * RELOAD time — `/me` (every dashboard load) runs the cached `reconcile()`,
 * every SSO login runs the TTL-bypassing `forceReconcile()`. One pass
 * fetches the user's full hub org list and makes the local projections
 * match: project missing orgs, sync names/roles, deactivate `origin='hub'`
 * memberships the hub no longer asserts.
 *
 * This is a FRESHNESS feature, so its failure posture is the opposite of
 * the login assertion's: every hub error (timeout, 5xx, 403, malformed) is
 * fail-OPEN — local state keeps serving, nothing is ever deactivated on an
 * error, and the pass retries at the next throttle window. Security stays
 * where it already is: the fail-closed login assertion, the D5 org
 * suspension gate, and the H2 membership re-assertion (hub-gate.ts).
 *
 * Cost discipline: per-user TTL cache (~15 s) + single-flight, so N
 * concurrent dashboard loads cost one hub fetch; a pass on an expired
 * cache IS awaited (freshness at reload time is the whole point) but is
 * bounded by the tight `userOrgsTimeoutMs` (1.5 s); failures re-probe at
 * most once per `retryMs`. An oss boot never constructs this class.
 */

export interface HubOrgReconcilerDeps {
  db: Db;
  status: HubStatusClient;
  audit: AuditService;
  logger: Logger;
  /** Test seam. */
  now?: () => number;
}

interface CacheEntry {
  /** Timestamp of the last DEFINITIVE pass (the TTL anchors here). */
  fetchedAt: number;
  /** Timestamp of the last attempt, success or failure (outage throttle). */
  lastAttemptAt: number;
}

export class HubOrgReconciler {
  /** local userId → pass freshness. */
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly now: () => number;

  /** Registered into the Prometheus registry by boot (cloud only). */
  readonly promMetrics: Counter[];
  private readonly passes: Counter;

  constructor(private readonly deps: HubOrgReconcilerDeps) {
    this.now = deps.now ?? Date.now;
    // registers: [] — boot attaches this to the app registry on cloud; an
    // oss boot never constructs this class, so the metric never exists there.
    this.passes = new Counter({
      name: 'hub_reconcile_passes_total',
      help: 'Hub org-list reconciliation passes by outcome',
      labelNames: ['outcome'] as const,
      registers: []
    });
    this.promMetrics = [this.passes];
  }

  /**
   * The `/me` read-through: cached per user (~15 s), single-flight, retry
   * throttled after failures. Awaits one pass on expiry — a dashboard
   * reload observes the reconciled state — and NEVER throws: a hub outage
   * must never fail the request that triggered it.
   */
  async reconcile(localUserId: string): Promise<void> {
    const now = this.now();
    const entry = this.cache.get(localUserId);
    if (entry && now - entry.fetchedAt < this.deps.status.dials.userOrgsTtlMs) return;
    let flight = this.inFlight.get(localUserId);
    if (!flight) {
      // Outage throttle: after a FAILED pass (lastAttemptAt advanced past
      // the last success), at most one re-probe per retryMs — a down hub
      // costs each user one bounded timeout per window. A successful pass
      // is never throttled beyond its own TTL.
      if (
        entry &&
        entry.lastAttemptAt > entry.fetchedAt &&
        now - entry.lastAttemptAt < this.deps.status.dials.retryMs
      ) {
        return;
      }
      flight = this.runPass(localUserId, {}).finally(() => {
        if (this.inFlight.get(localUserId) === flight) this.inFlight.delete(localUserId);
      });
      this.inFlight.set(localUserId, flight);
    }
    await flight;
  }

  /**
   * The login-time pass (assertLogin step 4): TTL and throttle deliberately
   * bypassed — a login is the freshest signal there is, and it already
   * resolved the hub sub. `assertedOrgId` joins the keep-set so even a hub
   * list that (transiently) omits the org this very login asserted can
   * never undo the projection step 3 just wrote. Never throws — a list
   * outage must never fail a login.
   */
  async forceReconcile(localUserId: string, hubUserId: string, assertedOrgId?: string): Promise<void> {
    const flight = this.runPass(localUserId, {
      hubUserId,
      ...(assertedOrgId !== undefined ? { assertedOrgId } : {})
    }).finally(() => {
      if (this.inFlight.get(localUserId) === flight) this.inFlight.delete(localUserId);
    });
    // Concurrent cached reconciles join this pass instead of doubling it.
    this.inFlight.set(localUserId, flight);
    await flight;
  }

  /**
   * One pass. Outcomes (the `hub_reconcile_passes_total` label):
   * 'ok' definitive list applied; 'no_link' the user holds no hub identity
   * (nothing to reconcile — cached like a success); 'inconclusive' hub
   * error, fail open; 'error' unexpected local failure, fail open.
   */
  private async runPass(
    localUserId: string,
    opts: { hubUserId?: string; assertedOrgId?: string }
  ): Promise<void> {
    try {
      let hubUserId = opts.hubUserId;
      if (!hubUserId) {
        // The H4 key is the hub sub riding the user's antasphere account
        // link (the hub-gate idiom); guardSingleHubIdentity keeps it unique
        // per user. No link = a purely local user: the hub asserts nothing
        // about them, and that IS the definitive answer.
        const [link] = await this.deps.db
          .select({ sub: account.accountId })
          .from(account)
          .where(and(eq(account.userId, localUserId), eq(account.providerId, HUB_SSO_PROVIDER_ID)))
          .limit(1);
        if (!link) {
          this.remember(localUserId, true);
          this.passes.inc({ outcome: 'no_link' });
          return;
        }
        hubUserId = link.sub;
      }

      const result = await this.deps.status.userMemberships(hubUserId);
      if (result.kind === 'inconclusive') {
        // Loudly logged by the client already; retry at the next window.
        this.remember(localUserId, false);
        this.passes.inc({ outcome: 'inconclusive' });
        return;
      }

      // Definitive 200 list — the ONLY thing that may ever mutate state.
      // Every listed org is kept, suspended ones included (visible but
      // blocked: the D5 org gate refuses their requests); role-null entries
      // are kept but not synced; the login-asserted org is unioned in.
      const keep = new Set(result.memberships.map((m) => m.workspaceId));
      if (opts.assertedOrgId) keep.add(opts.assertedOrgId);

      // Deactivation sweep FIRST (removal must win over projection within
      // one pass): ONE conditional UPDATE covering exactly the rows the hub
      // no longer asserts — origin='hub' AND active AND the workspace IS a
      // projection whose hub org is off the keep-set. local/guest rows and
      // rows in non-projected workspaces are structurally out of scope.
      // `is_active = true` in the WHERE makes the flip observable: only the
      // pass that actually flipped a row audits it — one logical removal
      // writes ONE member.deactivate row (the hub-gate.ts idiom).
      const keepIds = [...keep];
      const sweptWorkspaces = this.deps.db
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(
          keepIds.length > 0
            ? and(isNotNull(workspaces.centralAccountId), notInArray(workspaces.centralAccountId, keepIds))
            : isNotNull(workspaces.centralAccountId)
        );
      const deactivated = await this.deps.db
        .update(workspaceMembers)
        .set({ isActive: false })
        .where(
          and(
            eq(workspaceMembers.userId, localUserId),
            eq(workspaceMembers.origin, 'hub'),
            eq(workspaceMembers.isActive, true),
            inArray(workspaceMembers.workspaceId, sweptWorkspaces)
          )
        )
        .returning({ workspaceId: workspaceMembers.workspaceId });
      for (const row of deactivated) {
        await this.deps.audit.write({
          workspaceId: row.workspaceId,
          principal: null,
          action: 'member.deactivate',
          resourceType: 'member',
          resourceId: localUserId,
          metadata: { reason: 'hub_reconcile' }
        });
        this.deps.logger.info(
          { userId: localUserId, workspaceId: row.workspaceId },
          'hub reconcile: membership no longer asserted by the hub — local membership deactivated'
        );
      }

      // Then project/upsert every well-formed entry (role upserts are
      // deliberately NOT audited — the login-projection precedent; the H2
      // gate remains the audited role-delta path). One failing entry logs
      // and moves on: a single bad org must never starve the others.
      for (const membership of result.memberships) {
        if (membership.role === null) continue; // keep-alive only (unknown role)
        try {
          await projectOrgMembership(this.deps.db, {
            localUserId,
            hubWorkspaceId: membership.workspaceId,
            hubWorkspaceName: membership.name,
            role: membership.role
          });
        } catch (err) {
          this.deps.logger.error(
            { err, userId: localUserId, hubOrgId: membership.workspaceId },
            'hub reconcile: projecting one org failed — continuing with the rest'
          );
        }
      }

      this.remember(localUserId, true);
      this.passes.inc({ outcome: 'ok' });
    } catch (err) {
      // Fail open, always: reconciliation is freshness, never availability.
      this.remember(localUserId, false);
      this.passes.inc({ outcome: 'error' });
      this.deps.logger.error(
        { err, userId: localUserId },
        'hub org reconcile pass failed — serving local state'
      );
    }
  }

  private remember(localUserId: string, success: boolean): void {
    const now = this.now();
    pruneOversized(this.cache, (entry) => now - entry.fetchedAt >= this.deps.status.dials.userOrgsTtlMs);
    const prev = this.cache.get(localUserId);
    this.cache.set(localUserId, {
      fetchedAt: success ? now : (prev?.fetchedAt ?? 0),
      lastAttemptAt: now
    });
  }
}
