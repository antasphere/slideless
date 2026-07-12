import { Counter } from 'prom-client';
import { workspaceRoles, type WorkspaceRole } from '@slideless/db';
import type { Logger } from '../logger.js';

/**
 * The cloud edition's cached hub-status client (docs/federation.md, Phase 4):
 * the ONE component that talks to the hub's `accounts:status` machine surface
 * with HUB_SERVICE_KEY. Two endpoints, two consumers:
 *
 *  - `GET /accounts/{centralAccountId}/status` → `{ status, kind }` — the
 *    org suspension gate (HubEntitlementService + HubPrincipalGate), cached
 *    per org with the D5 dials;
 *  - `GET /accounts/{ws}/members/{hubUserId}/status` → `{ active, role? }`
 *    (hub delta H2) — the membership re-assertion (D3/D11), UNCACHED here:
 *    the per-(user, org) cache lives in HubPrincipalGate because its key is
 *    the local pair, and the DB lookup that maps it to hub ids is part of
 *    the cache-miss cost.
 *
 * Failure posture (D5): a DEFINITIVE hub answer (active / suspended / 404)
 * is cached and enforced; fetch errors (network, timeout, 5xx, and 401/403
 * from a broken service key) serve the last known value stale up to
 * ORG_STALE_MAX, then fail CLOSED ('unavailable'). The hot path never waits
 * on the hub once a value is cached: an expired entry is served stale while
 * one single-flight refresh runs, and during an outage re-probes are
 * throttled to RETRY_MS — a hub blip never puts the hub in every request
 * path, and a down hub costs at most one timeout per org per RETRY_MS.
 *
 * The service key is a bearer to the hub: it is never logged, and neither
 * are hub response bodies.
 */

/** D5/D3 dials. Fixed by decision — overridable only through test seams. */
export interface HubStatusDials {
  /** Org-status cache TTL (D5: 60 s). */
  orgTtlMs: number;
  /** Stale-while-error window measured from the last SUCCESSFUL fetch (D5: 15 min), then fail closed. */
  orgStaleMaxMs: number;
  /** Outage re-probe throttle: at most one fetch attempt per org per this interval. */
  retryMs: number;
  /** Membership re-assertion cache TTL (D3: ~5 min) — consumed by HubPrincipalGate. */
  memberTtlMs: number;
  /** Per-request hub fetch timeout. */
  timeoutMs: number;
}

export const DEFAULT_HUB_DIALS: HubStatusDials = {
  orgTtlMs: 60_000,
  orgStaleMaxMs: 15 * 60_000,
  retryMs: 15_000,
  memberTtlMs: 5 * 60_000,
  timeoutMs: 5_000
};

/**
 * The org gate's answer. 'active'/'suspended'/'not_found' are definitive hub
 * truth (possibly stale-served within the D5 window); 'unavailable' is the
 * fail-closed verdict once the hub has been unreachable beyond it.
 */
export type HubOrgStatus = 'active' | 'suspended' | 'not_found' | 'unavailable';

/**
 * One H2 answer. Per the pinned contract (hub routes/index.ts): ONLY a
 * definitive `200 { active: false }` may deactivate a projection — 401/403
 * (broken service key), 404 (a hub without H2), 5xx, timeouts, and
 * malformed bodies are all 'inconclusive' (fail open, keep the row).
 * `role` is null when H2 answered active without a parseable role — the
 * caller keeps the local role.
 */
export type HubMemberStatus =
  | { kind: 'active'; role: WorkspaceRole | null }
  | { kind: 'inactive' }
  | { kind: 'inconclusive' };

interface OrgEntry {
  /** Last successfully fetched value; null = no success yet (failures only). */
  value: 'active' | 'suspended' | 'not_found' | null;
  /** Timestamp of the last SUCCESS (the stale window anchors here). */
  fetchedAt: number;
  /** Timestamp of the last attempt, success or failure (outage throttle). */
  lastAttemptAt: number;
}

/** Bound both caches — a workspace-id flood must never balloon memory. */
const MAX_CACHE_ENTRIES = 10_000;

export interface HubStatusClientOptions {
  /** The hub origin (HUB_ISSUER_URL) — both status endpoints live under it. */
  issuerUrl: string;
  /** HUB_SERVICE_KEY (ant_…, accounts:status scope). Never logged. */
  serviceKey: string;
  logger: Logger;
  dials: HubStatusDials;
  /** Test seams. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class HubStatusClient {
  private readonly orgCache = new Map<string, OrgEntry>();
  private readonly inFlight = new Map<string, Promise<'active' | 'suspended' | 'not_found' | null>>();
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  readonly dials: HubStatusDials;

  /** Registered into the Prometheus registry by boot (cloud only). */
  readonly promMetrics: Counter[];
  private readonly fetches: Counter;
  private readonly degraded: Counter;

  constructor(private readonly opts: HubStatusClientOptions) {
    this.base = opts.issuerUrl.replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.dials = opts.dials;
    // registers: [] — boot attaches these to the app registry on cloud; an
    // oss boot never constructs this class, so the metrics never exist there.
    this.fetches = new Counter({
      name: 'hub_status_fetches_total',
      help: 'Hub accounts:status fetches by endpoint and outcome',
      labelNames: ['endpoint', 'outcome'] as const,
      registers: []
    });
    this.degraded = new Counter({
      name: 'hub_status_degraded_total',
      help: 'Org-status answers served degraded (stale) or fail-closed (unavailable)',
      labelNames: ['mode'] as const,
      registers: []
    });
    this.promMetrics = [this.fetches, this.degraded];
  }

  /**
   * The org suspension gate's read: cache-first with the D5 posture
   * (60 s TTL; stale-while-error 15 min from the last success; then
   * 'unavailable' = fail closed). Only a request that finds NO cached value
   * ever waits on the hub.
   */
  async orgStatus(centralAccountId: string): Promise<HubOrgStatus> {
    const now = this.now();
    const entry = this.orgCache.get(centralAccountId);
    if (entry?.value && now - entry.fetchedAt < this.dials.orgTtlMs) {
      return entry.value;
    }

    let flight = this.inFlight.get(centralAccountId);
    if (!flight && (!entry || now - entry.lastAttemptAt >= this.dials.retryMs)) {
      flight = this.fetchOrgStatus(centralAccountId).finally(() => this.inFlight.delete(centralAccountId));
      this.inFlight.set(centralAccountId, flight);
    }

    // Stale-while-revalidate/-error: an expired-but-within-window value is
    // served immediately; the refresh (when one is running) updates the
    // cache for the NEXT request. Enforcement bound = TTL + one round-trip.
    if (entry?.value && now - entry.fetchedAt < this.dials.orgStaleMaxMs) {
      if (now - entry.fetchedAt >= this.dials.orgTtlMs) this.degraded.inc({ mode: 'stale' });
      return entry.value;
    }

    if (flight) {
      const fetched = await flight;
      if (fetched) return fetched;
    }
    this.degraded.inc({ mode: 'unavailable' });
    return 'unavailable';
  }

  /** One H2 read (docs/federation.md): the caller owns the ~5-min cache. */
  async memberStatus(centralAccountId: string, hubUserId: string): Promise<HubMemberStatus> {
    let res: Response;
    try {
      res = await this.get(
        `/api/v1/accounts/${encodeURIComponent(centralAccountId)}/members/${encodeURIComponent(hubUserId)}/status`
      );
    } catch (err) {
      this.fetches.inc({ endpoint: 'member_status', outcome: 'error' });
      this.opts.logger.warn({ err, centralAccountId }, 'hub member-status fetch failed — keeping the local membership');
      return { kind: 'inconclusive' };
    }
    if (res.status === 401 || res.status === 403) {
      // A credential problem, NEVER a membership answer: deactivating here
      // would let a service-key rotation lock out every cloud user at once.
      this.fetches.inc({ endpoint: 'member_status', outcome: 'credential_error' });
      this.opts.logger.error(
        { status: res.status },
        'hub rejected HUB_SERVICE_KEY on member-status — re-assertion is failing open; fix the key'
      );
      return { kind: 'inconclusive' };
    }
    if (res.status === 404) {
      // H2 absent (an older hub): the real endpoint never 404s a machine
      // caller — a missing pair answers 200 {active:false}. Fail open.
      this.fetches.inc({ endpoint: 'member_status', outcome: 'absent' });
      this.opts.logger.warn(
        { centralAccountId },
        'hub member-status endpoint answered 404 (hub without H2?) — re-assertion is failing open'
      );
      return { kind: 'inconclusive' };
    }
    if (!res.ok) {
      this.fetches.inc({ endpoint: 'member_status', outcome: 'error' });
      this.opts.logger.warn(
        { status: res.status, centralAccountId },
        'hub member-status fetch failed — keeping the local membership'
      );
      return { kind: 'inconclusive' };
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      this.fetches.inc({ endpoint: 'member_status', outcome: 'error' });
      this.opts.logger.warn({ centralAccountId }, 'hub member-status body unparseable — keeping the local membership');
      return { kind: 'inconclusive' };
    }
    const active = (body as { active?: unknown } | null)?.active;
    if (active === false) {
      this.fetches.inc({ endpoint: 'member_status', outcome: 'inactive' });
      return { kind: 'inactive' };
    }
    if (active === true) {
      this.fetches.inc({ endpoint: 'member_status', outcome: 'active' });
      const rawRole = (body as { role?: unknown }).role;
      if (typeof rawRole === 'string' && (workspaceRoles as readonly string[]).includes(rawRole)) {
        return { kind: 'active', role: rawRole as WorkspaceRole };
      }
      // Active without a parseable role: trust the liveness, keep the local
      // role (D11 syncs only from a well-formed hub answer).
      if (rawRole !== undefined) {
        this.opts.logger.warn({ centralAccountId }, 'hub member-status carried an unknown role — keeping the local role');
      }
      return { kind: 'active', role: null };
    }
    this.fetches.inc({ endpoint: 'member_status', outcome: 'error' });
    this.opts.logger.warn({ centralAccountId }, 'hub member-status body malformed — keeping the local membership');
    return { kind: 'inconclusive' };
  }

  private async fetchOrgStatus(centralAccountId: string): Promise<'active' | 'suspended' | 'not_found' | null> {
    try {
      const res = await this.get(`/api/v1/accounts/${encodeURIComponent(centralAccountId)}/status`);
      if (res.status === 404) {
        // Definitive: the hub does not know this org (deleted, or a foreign
        // projection). Enforced like suspension.
        this.remember(centralAccountId, 'not_found');
        this.fetches.inc({ endpoint: 'org_status', outcome: 'not_found' });
        return 'not_found';
      }
      if (!res.ok) throw new Error(`hub org-status answered ${res.status}`);
      const body = (await res.json()) as { status?: unknown };
      if (body?.status !== 'active' && body?.status !== 'suspended') {
        throw new Error('hub org-status body malformed');
      }
      this.remember(centralAccountId, body.status);
      this.fetches.inc({ endpoint: 'org_status', outcome: body.status });
      return body.status;
    } catch (err) {
      const prev = this.orgCache.get(centralAccountId);
      this.orgCache.set(centralAccountId, {
        value: prev?.value ?? null,
        fetchedAt: prev?.fetchedAt ?? 0,
        lastAttemptAt: this.now()
      });
      this.fetches.inc({ endpoint: 'org_status', outcome: 'error' });
      this.opts.logger.warn({ err, centralAccountId }, 'hub org-status fetch failed');
      return null;
    }
  }

  private remember(centralAccountId: string, value: 'active' | 'suspended' | 'not_found'): void {
    pruneOversized(this.orgCache, (e) => this.now() - e.fetchedAt >= this.dials.orgStaleMaxMs);
    const now = this.now();
    this.orgCache.set(centralAccountId, { value, fetchedAt: now, lastAttemptAt: now });
  }

  private get(path: string): Promise<Response> {
    return this.fetchImpl(`${this.base}${path}`, {
      headers: { authorization: `Bearer ${this.opts.serviceKey}`, accept: 'application/json' },
      signal: AbortSignal.timeout(this.dials.timeoutMs)
    });
  }
}

/** Keep a cache under MAX_CACHE_ENTRIES: drop expired entries first, then oldest-inserted. */
export function pruneOversized<V>(cache: Map<string, V>, expired: (value: V) => boolean): void {
  if (cache.size < MAX_CACHE_ENTRIES) return;
  for (const [key, value] of cache) {
    if (expired(value)) cache.delete(key);
  }
  while (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}
