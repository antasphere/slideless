import { workspaceRoles, type WorkspaceRole } from '@slideless/db';
import type { Logger } from '../logger.js';
import type { GrantAccess, HubGrantService } from './hub-grant.js';

/**
 * The as-the-user hub reader (docs/federation.md, live user-scoped
 * federation): every org/membership read between logins is `GET
 * <hub>/api/v1/orgs` presented with the USER's OWN grant token
 * (identity/hub-grant.ts) — the hub only ever returns what that user may
 * see, so a cross-tenant read is structurally impossible on this path.
 * There is deliberately NO target-user parameter anywhere.
 *
 * Failure posture mirrors the retired H4 client: only a definitive 200
 * list may drive reconciliation; network/timeout/5xx/malformed answers are
 * one loud, fail-open 'inconclusive'. A 401/403 gets exactly ONE
 * forced-refresh retry (the presented token may be stale or wrong-audience
 * from a pre-flip row) — a second refusal is inconclusive, never a grant
 * kill (only the token endpoint's `invalid_grant` kills a grant, inside
 * HubGrantService).
 */

/** The hub API resource identifier (RFC 8707 `aud`) — `<hub issuer>/mcp`. */
export function hubApiResource(issuerUrl: string): string {
  return issuerUrl.replace(/\/+$/, '') + '/mcp';
}

/**
 * One validated entry of the caller-scoped org list. Forward-compatible by
 * construction: an absent `status` reads as 'active', an absent `isDefault`
 * as false, an unknown `role` as null (keep-alive only — an unknown role
 * must never read as absence).
 */
export interface HubOrg {
  /** The hub org id (uuid) — what `workspaces.centralAccountId` projects. */
  id: string;
  /** Org display name; null when absent/blank. */
  name: string | null;
  role: WorkspaceRole | null;
  status: 'active' | 'suspended';
  /** The caller's hub-level default org (at most one entry carries it). */
  isDefault: boolean;
}

export type HubOrgsResult =
  { kind: 'ok'; orgs: HubOrg[] } | { kind: 'no_link' } | { kind: 'grant_dead' } | { kind: 'inconclusive' };

/** Strict UUID shape — a malformed hub entry must never reach Postgres' uuid cast. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The SSO callback's access token, handed through by the login path. */
export interface LoginAccessToken {
  accessToken: string;
  expiresAt: Date | null;
}

export interface HubUserClientOptions {
  grant: HubGrantService;
  /** The hub origin (HUB_ISSUER_URL) — /api/v1/orgs lives under it. */
  issuerUrl: string;
  logger: Logger;
  /** Per-fetch timeout — tight, because reconcile passes are awaited in the identity path. */
  timeoutMs: number;
  /** Test seam. */
  fetchImpl?: typeof fetch;
}

export class HubUserClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: HubUserClientOptions) {
    this.base = opts.issuerUrl.replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /**
   * The user's own org list, as the hub sees it RIGHT NOW. `login` carries
   * the SSO callback's access token (already hub-audienced — the code
   * exchange sends the same `resource`): the login path needs no refresh,
   * and the token is primed into the grant cache for the requests that
   * follow.
   */
  async orgs(localUserId: string, login?: LoginAccessToken): Promise<HubOrgsResult> {
    let token: string;
    if (login) {
      this.opts.grant.prime(localUserId, login.accessToken, login.expiresAt);
      token = login.accessToken;
    } else {
      const access = await this.opts.grant.accessToken(localUserId);
      if (access.kind !== 'ok') return { kind: access.kind };
      token = access.accessToken;
    }

    let res = await this.get(token);
    if (res.kind === 'error') return { kind: 'inconclusive' };
    if (res.response.status === 401 || res.response.status === 403) {
      // The hub refused the token (expired mid-window, or a pre-flip row's
      // wrong-audience stored token): ONE forced refresh, ONE retry. The
      // refresh itself classifies the grant (invalid_grant → dead).
      this.opts.grant.invalidateAccess(localUserId);
      const refreshed: GrantAccess = await this.opts.grant.refresh(localUserId);
      if (refreshed.kind !== 'ok') return { kind: refreshed.kind };
      res = await this.get(refreshed.accessToken);
      if (res.kind === 'error') return { kind: 'inconclusive' };
      if (res.response.status === 401 || res.response.status === 403) {
        this.opts.logger.error(
          { status: res.response.status },
          'hub /orgs refused a FRESHLY refreshed token — the hub is rejecting this tool’s grants; failing open'
        );
        return { kind: 'inconclusive' };
      }
    }
    const { response } = res;
    if (!response.ok) {
      this.opts.logger.warn({ status: response.status }, 'hub /orgs answered non-2xx — failing open');
      return { kind: 'inconclusive' };
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      this.opts.logger.warn('hub /orgs body unparseable — failing open');
      return { kind: 'inconclusive' };
    }
    const rawList = (body as { orgs?: unknown } | null)?.orgs;
    if (!Array.isArray(rawList)) {
      this.opts.logger.warn('hub /orgs body malformed — failing open');
      return { kind: 'inconclusive' };
    }
    const orgs: HubOrg[] = [];
    for (const raw of rawList) {
      const entry = (raw ?? {}) as {
        id?: unknown;
        name?: unknown;
        role?: unknown;
        status?: unknown;
        isDefault?: unknown;
      };
      if (typeof entry.id !== 'string' || !UUID_RE.test(entry.id)) {
        // One bad entry never poisons the list — but its org can neither be
        // projected NOR protected by the keep-set, so say so loudly.
        this.opts.logger.error('hub /orgs carried an entry without a valid id — entry dropped');
        continue;
      }
      const role =
        typeof entry.role === 'string' && (workspaceRoles as readonly string[]).includes(entry.role)
          ? (entry.role as WorkspaceRole)
          : null;
      if (role === null) {
        this.opts.logger.warn(
          { hubOrgId: entry.id },
          'hub /orgs carried an unknown role — keeping the membership alive, skipping its sync'
        );
      }
      orgs.push({
        id: entry.id,
        name: typeof entry.name === 'string' && entry.name.trim() ? entry.name : null,
        role,
        // Unknown/absent status reads as 'active' (forward-compat: status
        // only ever narrows access; enforcement reads the synced column).
        status: entry.status === 'suspended' ? 'suspended' : 'active',
        isDefault: entry.isDefault === true
      });
    }
    return { kind: 'ok', orgs };
  }

  private async get(token: string): Promise<{ kind: 'ok'; response: Response } | { kind: 'error' }> {
    try {
      const response = await this.fetchImpl(`${this.base}/api/v1/orgs`, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(this.opts.timeoutMs)
      });
      return { kind: 'ok', response };
    } catch (err) {
      this.opts.logger.warn({ err }, 'hub /orgs fetch failed — failing open');
      return { kind: 'error' };
    }
  }
}
