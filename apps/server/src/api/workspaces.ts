import type { OpenAPIHono } from '@hono/zod-openapi';
import { and, eq, sql } from 'drizzle-orm';
import { ACTIVE_WORKSPACE_HEADER } from '@slideless/contract';
import { workspaceCreateRoute } from '@slideless/contract/routes';
import { workspaceMembers, workspaces, type Db, type DbConn } from '@slideless/db';
import type { AuditService } from '../audit/service.js';
import type { Auth } from '../identity/better-auth.js';
import { projectOrgMembership } from '../identity/hub-projection.js';
import type { ReconcilePassOutcome } from '../identity/hub-reconcile.js';
import type { HubOrgCreator } from '../identity/hub-user-client.js';
import type { Logger } from '../logger.js';
import type { ClientIpFn } from '../middleware/rate-limit.js';
import type { PlatformRegistry } from '../platform/registry.js';

const err = (code: string, message: string) => ({ error: { code, message } });

/**
 * POST /workspaces — a signed-in person creates ANOTHER workspace from inside
 * the product (PRDCT-2444 self-hosted, PRDCT-2443 cloud). ADR 014 kept this
 * door shut in the template ("workspace creation is a product decision");
 * this module is that decision, taken.
 *
 * One route, two editions:
 *  - oss: `WorkspaceService.create` (the setup path) under a per-user
 *    advisory lock + the operator's `MAX_WORKSPACES_PER_USER` cap — the
 *    hub's `POST /orgs` model, mirrored.
 *  - cloud: the organization is created AT THE HUB as the caller (their own
 *    stored grant, ADR 019 — no service key, no target-user parameter), then
 *    the caller's reconcile is forced so the local projection and the
 *    `origin='hub'` owner membership exist before the answer. The answer
 *    carries the LOCAL workspace id.
 *
 * SESSIONS ONLY, twice: the path is deliberately UNLISTED in the fail-closed
 * machine scope allowlist (middleware/scopes.ts — never list it), and the
 * handler re-checks `via === 'session'` itself. /mcp carries no tool for it.
 *
 * A WORKSPACE NEVER LEARNS WHAT ITS MEMBERS DO ELSEWHERE: the route is
 * exempt from the generic audit middleware (which would attribute the event
 * to the workspace the person happened to be in) and writes its one genesis
 * row, `workspace.create`, into the NEW workspace's own trail — the setup
 * pattern. The idempotency claim is the only trace left in the caller's
 * current scope, and it is a sealed replay cache, never a readable surface.
 */

/**
 * Per-user creation lock, two-int advisory form `(classid, hashtext(userId))`.
 * 7432006 is free in this repository (7432001 migrations, 7432002/3 the
 * last-owner guards, 7432004 the grant refresh + pg-boss, 7432005 deck
 * uploads) and is, on purpose, the same number the hub uses for the same
 * job in ITS database.
 */
const WORKSPACE_CREATE_LOCK_NAMESPACE = 7432006;

/** Why this caller may not create a workspace right now — also the wire error code. */
export type WorkspaceCreationRefusal =
  | 'session_required'
  | 'workspace_creation_disabled'
  | 'guest_forbidden'
  | 'workspace_limit_reached'
  | 'hub_link_required';

export interface WorkspaceCreationPolicy {
  /** `MAX_WORKSPACES_PER_USER`. 0 closes creation for everyone, on both editions. */
  maxPerUser: number;
  /**
   * Cloud only: whether the user holds a LIVE hub link (a stored grant) —
   * the organization is created at the hub AS THEM, so without one there is
   * nothing to create it with. undefined on oss.
   */
  hasHubLink?: ((userId: string) => Promise<boolean>) | undefined;
}

/**
 * THE ONE eligibility rule, shared by the route (inside its locked
 * transaction) and by `/me.canCreateWorkspace` — so the flag can never
 * promise what the route refuses. Order = the order the refusals are
 * reported in.
 *
 *  - sessions only;
 *  - the operator's dial at 0 closes the door on both editions;
 *  - a GUEST-ONLY user (every active membership is `origin='guest'`) is an
 *    outsider invited to single decks (D2): refused like every other
 *    workspace-level act. One non-guest active membership anywhere lifts it
 *    — it is a fact about the PERSON, not about the workspace they are in;
 *  - oss: fewer ACTIVE OWNER memberships than the cap (setup's counts);
 *  - cloud: a live hub link. The count is the hub's own cap, asked there.
 */
export async function workspaceCreationRefusal(
  conn: DbConn,
  policy: WorkspaceCreationPolicy,
  caller: { userId: string; via: 'session' | 'api_key' | 'oauth' }
): Promise<WorkspaceCreationRefusal | null> {
  if (caller.via !== 'session') return 'session_required';
  if (policy.maxPerUser === 0) return 'workspace_creation_disabled';
  const rows = await conn
    .select({ origin: workspaceMembers.origin, role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.userId, caller.userId), eq(workspaceMembers.isActive, true)));
  if (rows.length > 0 && rows.every((r) => r.origin === 'guest')) return 'guest_forbidden';
  if (policy.hasHubLink) {
    return (await policy.hasHubLink(caller.userId)) ? null : 'hub_link_required';
  }
  const owned = rows.filter((r) => r.role === 'owner').length;
  return owned >= policy.maxPerUser ? 'workspace_limit_reached' : null;
}

const REFUSAL_MESSAGES: Record<WorkspaceCreationRefusal, string> = {
  session_required: 'Creating a workspace requires a browser session',
  workspace_creation_disabled: 'Workspace creation is closed on this instance',
  guest_forbidden: 'Guest access is limited to the decks you were invited to',
  workspace_limit_reached: 'This account already owns the maximum number of workspaces',
  hub_link_required: 'Sign in with Antasphere to create an organization'
};

/** Control-flow marker: a refusal decided inside the locked transaction. */
class CreationRefused extends Error {
  constructor(readonly refusal: WorkspaceCreationRefusal) {
    super(refusal);
  }
}

/** Cloud-only collaborators. Absent on oss: the route carries zero hub surface there. */
export interface WorkspaceCloudDeps {
  /** The ONE hub call, isolated (identity/hub-user-client.ts `createOrg`). */
  createOrg: HubOrgCreator;
  /** The login-grade, TTL-bypassing reconcile pass (identity/hub-reconcile.ts). */
  forceReconcile: (userId: string) => Promise<ReconcilePassOutcome>;
  hasHubLink: (userId: string) => Promise<boolean>;
}

export interface WorkspaceRouteDeps {
  db: Db;
  auth: Auth;
  audit: AuditService;
  registry: PlatformRegistry;
  logger: Logger;
  clientIp: ClientIpFn;
  maxPerUser: number;
  cloud?: WorkspaceCloudDeps | undefined;
}

export function workspaceCreationPolicy(
  deps: Pick<WorkspaceRouteDeps, 'maxPerUser' | 'cloud'>
): WorkspaceCreationPolicy {
  return { maxPerUser: deps.maxPerUser, hasHubLink: deps.cloud?.hasHubLink };
}

export function registerWorkspaceRoutes(api: OpenAPIHono, deps: WorkspaceRouteDeps): void {
  const { db, auth, audit, registry, logger, cloud } = deps;
  const policy = workspaceCreationPolicy(deps);

  api.openapi(workspaceCreateRoute, async (c) => {
    const principal = c.get('principal');
    // Defense in depth: the scope allowlist already 403s every machine
    // principal (POST /workspaces is unlisted, fail-closed); this explicit
    // check stays so a future allowlist edit cannot silently hand workspace
    // creation to an API key or an OAuth bearer.
    if (principal && principal.via !== 'session') {
      return c.json(err('session_required', REFUSAL_MESSAGES.session_required), 403);
    }

    // The caller. A resolved principal is a session by now. WITHOUT one, the
    // cloud edition still serves the ZERO-MEMBERSHIP session (the /me zero
    // state: a hub user whose last organization was removed creates their
    // next one here) — resolved route-locally, the /me pattern, and ONLY
    // for the selector-less request. On oss no principal means no active
    // membership of this instance: not someone who may create here.
    let userId: string;
    if (principal) {
      userId = principal.userId;
    } else {
      // A request that NAMED a workspace and failed its membership check keeps
      // the fail-closed 401 (no oracle about that workspace) — /me's rule.
      if (c.req.header(ACTIVE_WORKSPACE_HEADER)?.trim()) {
        return c.json(err('unauthenticated', 'Authentication required'), 401);
      }
      const session = cloud ? await auth.api.getSession({ headers: c.req.raw.headers }) : null;
      if (!session?.user) return c.json(err('unauthenticated', 'Authentication required'), 401);
      userId = session.user.id;
    }
    const actor = { userId, via: 'session' as const };

    const name = c.req.valid('json').name.trim();
    if (!name) return c.json(err('validation_error', 'The workspace needs a name'), 400);

    let workspaceId: string;
    let workspaceName = name;
    if (!cloud) {
      // ── oss: local creation under the per-user lock ─────────────────────
      try {
        workspaceId = await db.transaction(async (tx) => {
          // Serializes THIS user's creations: two concurrent requests can
          // never both count "one under the cap". Transaction-scoped — it
          // cannot leak.
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(${WORKSPACE_CREATE_LOCK_NAMESPACE}, hashtext(${userId}))`
          );
          const refusal = await workspaceCreationRefusal(tx, policy, actor);
          if (refusal) throw new CreationRefused(refusal);
          // The registry's WorkspaceService (ADR 014), joined to this
          // transaction exactly as setup does: workspace + ACTIVE OWNER
          // membership (origin defaults to 'local') or nothing.
          return (await registry.workspaces.create(name, userId, tx)).workspaceId;
        });
      } catch (cause) {
        if (cause instanceof CreationRefused) {
          return c.json(err(cause.refusal, REFUSAL_MESSAGES[cause.refusal]), 403);
        }
        throw cause;
      }
    } else {
      // ── cloud: create at the hub as the caller, then project ────────────
      const refusal = await workspaceCreationRefusal(db, policy, actor);
      if (refusal) return c.json(err(refusal, REFUSAL_MESSAGES[refusal]), 403);

      const created = await cloud.createOrg(userId, name);
      switch (created.kind) {
        case 'created':
          break;
        case 'limit_reached':
          return c.json(
            err('workspace_limit_reached', 'This account already owns the maximum number of organizations'),
            403
          );
        case 'invalid':
          return c.json(err('validation_error', 'Antasphere refused this organization name'), 400);
        case 'no_link':
          return c.json(err('hub_link_required', REFUSAL_MESSAGES.hub_link_required), 403);
        case 'grant_dead':
          // The existing live-gate verdict, verbatim: a browser SSO re-login heals it.
          return c.json(
            err(
              'hub_grant_expired',
              'Your Antasphere grant on this instance has expired — sign in with Antasphere again to renew it'
            ),
            401
          );
        case 'refused':
          return c.json(
            err('hub_refused', 'Antasphere did not accept the creation of this organization'),
            403
          );
        case 'inconclusive':
          // The existing live-gate verdict's code. Never retried here: the
          // hub commits before it answers, so the organization may exist —
          // if it does, the caller's next reconcile pass projects it.
          return c.json(
            err('hub_unavailable', 'Antasphere could not be reached — the organization was not confirmed'),
            403
          );
      }

      // The reconcile IS the projection (the login path's rule): force the
      // caller's pass so the workspace row and the origin='hub' membership
      // are written by the same code every other hub org goes through.
      const pass = await cloud.forceReconcile(userId);
      const find = () =>
        db
          .select({ id: workspaces.id, name: workspaces.name })
          .from(workspaces)
          .innerJoin(
            workspaceMembers,
            and(
              eq(workspaceMembers.workspaceId, workspaces.id),
              eq(workspaceMembers.userId, userId),
              eq(workspaceMembers.isActive, true)
            )
          )
          .where(eq(workspaces.centralAccountId, created.org.id))
          .limit(1);
      let [local] = await find();
      if (!local && created.org.role !== null) {
        // The pass right after the 201 was inconclusive (a hub blip). The
        // 201 itself is hub truth read AS THE USER about THIS org — the same
        // standing as one entry of their GET /orgs list — so project that
        // one entry through the same primitive rather than answer an error
        // for an organization that exists (a retry would create a second).
        // Never from a token, never for anyone but the caller.
        logger.warn(
          { userId, pass },
          'workspace create: forced reconcile did not project the new org — projecting from the hub 201'
        );
        await projectOrgMembership(db, {
          localUserId: userId,
          hubWorkspaceId: created.org.id,
          hubWorkspaceName: created.org.name,
          role: created.org.role
        });
        [local] = await find();
      }
      if (!local) {
        logger.error({ userId, pass }, 'workspace create: hub org created but no local projection');
        return c.json(
          err('hub_unavailable', 'The organization was created at Antasphere and will appear shortly'),
          403
        );
      }
      workspaceId = local.id;
      workspaceName = local.name;
    }

    // Genesis row in the NEW workspace's own trail — and nowhere else.
    await audit.write({
      workspaceId,
      principal: actor,
      action: 'workspace.create',
      resourceType: 'workspace',
      resourceId: workspaceId,
      requestId: c.get('requestId'),
      ip: deps.clientIp(c),
      metadata: { name: workspaceName }
    });
    registry.events.emit('workspace.created', { workspaceId, ownerUserId: userId });

    return c.json({ workspace: { id: workspaceId, name: workspaceName } }, 201);
  });
}
