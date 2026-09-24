import { eq, sql } from 'drizzle-orm';
import type { ActorRef, EntitlementRequest } from '@antasphere/chassis-contract';
import { workspaces, type Db } from '@antasphere/chassis-db';
import { canAdministerDeck } from './service.js';
import type { DeckDomain } from '../tool.js';

/**
 * The member cap's one seat pool (PRDCT-2702, the wave's ruling 2 of 24
 * September 2026): a workspace's seats are its ACTIVE members of every
 * origin (guests included) plus the addresses that hold a seat without a
 * membership yet: a live pending collaborator grant, an ACTIVE grant whose
 * holder has not claimed a membership (the cloud's swept state between the
 * JIT login and the claim: the person invited first must not lose the seat
 * to the one invited after), and an open workspace invitation. Slideless's
 * two doors that add a member, the collaborator invite and the collaborator
 * claim, each report the seats AFTER their act, and the gate refuses when
 * that exceeds `workspace.members` for the plan: a fourth seat on free is
 * refused at the invite, and a workspace downgraded above the cap takes
 * nobody in until it is under it again. The workspace invitation doors
 * carry no declaration: on every workspace that has a plan they answer
 * `hub_managed`, and the hub enforces the same cap at its own doors.
 *
 * The hooks resolve through the late-bound domain at request time and
 * answer null for what they cannot or must not judge (no principal, no
 * body, a token the instance does not know, a caller who may not act on the
 * deck): the gate then leaves the route to its own handling (its 404, 403,
 * 409 or 410), so a plan refusal never tells a caller more than the handler
 * would. A hook that throws is caught and logged by the gate, which judges
 * nothing on that request.
 *
 * The count is read before the handler acts, outside any lock: two
 * concurrent acts at the cap may both pass and overshoot it by the
 * concurrency, which the next act sees (accepted at the code review: the
 * gate has no transaction seam, and the collaborator service's own per-deck
 * cap keeps its lock).
 */

interface SeatPool {
  /** The active members, every origin. */
  members: number;
  /** The lowercased emails of the active members. */
  memberEmails: Set<string>;
  /** The lowercased emails holding a seat without a membership. */
  reserved: Set<string>;
}

/**
 * The pool, read in ONE statement (one snapshot): three statements let a
 * claim commit between them, so an invite's count saw the person neither as
 * a grant nor as a member and let one seat too many in.
 */
async function seatPool(db: Db, workspaceId: string): Promise<SeatPool> {
  const now = new Date();
  const result = await db.execute(sql`
    SELECT u.email AS email, 'member' AS kind
      FROM workspace_members wm
      JOIN "user" u ON u.id = wm.user_id
     WHERE wm.workspace_id = ${workspaceId} AND wm.is_active
    UNION ALL
    SELECT c.email AS email, 'grant' AS kind
      FROM collaborators c
     WHERE c.workspace_id = ${workspaceId} AND c.revoked_at IS NULL
       AND ((c.status = 'pending' AND c.claim_expires_at > ${now}) OR c.status = 'active')
    UNION ALL
    SELECT i.email AS email, 'invitation' AS kind
      FROM invitations i
     WHERE i.workspace_id = ${workspaceId}
       AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ${now}
  `);
  const rows = result.rows as Array<{ email: string; kind: 'member' | 'grant' | 'invitation' }>;
  const memberEmails = new Set(rows.filter((r) => r.kind === 'member').map((r) => r.email.toLowerCase()));
  const reserved = new Set<string>();
  for (const row of rows) {
    if (row.kind === 'member') continue;
    const email = row.email.toLowerCase();
    if (!memberEmails.has(email)) reserved.add(email);
  }
  return { members: memberEmails.size, memberEmails, reserved };
}

/** The seats after inviting `email` into the pool: one more unless the address already holds a seat. */
function seatsAfterInvite(pool: SeatPool, email: string): number {
  const held = pool.memberEmails.has(email) || pool.reserved.has(email);
  return pool.members + pool.reserved.size + (held ? 0 : 1);
}

/**
 * The seats after `email` joins on its own grant: the MEMBERS alone, plus
 * this one unless already a member. A join adds no seat (a reservation
 * becomes a membership), so the other reservations are not counted against
 * it: counting them refused every claim of a workspace whose grants
 * exceeded a lowered cap while its members were under it, with nobody told
 * why (the hub diff's review). First come, first seated; the invite keeps
 * counting reservations.
 */
function seatsAfterJoin(pool: SeatPool, email: string): number {
  return pool.members + (pool.memberEmails.has(email) ? 0 : 1);
}

async function emailOf(ctx: EntitlementRequest): Promise<string | null> {
  const body = (await ctx.body()) as { email?: unknown } | undefined;
  return typeof body?.email === 'string' && body.email.trim() ? body.email.toLowerCase().trim() : null;
}

async function tokenOf(ctx: EntitlementRequest): Promise<string | null> {
  const body = (await ctx.body()) as { token?: unknown } | undefined;
  return typeof body?.token === 'string' && body.token ? body.token : null;
}

interface ClaimGrant {
  workspaceId: string;
  email: string;
}

export function memberSeatHooks(db: Db, getTool: () => DeckDomain | null) {
  // The claim's grant, resolved once per request: the actor hook and the
  // limit hook of the same request read the same resolution (the public
  // door is rate-limited per address only; every lookup there is paid).
  const grants = new WeakMap<EntitlementRequest, Promise<ClaimGrant | null>>();
  const grantOf = (ctx: EntitlementRequest): Promise<ClaimGrant | null> => {
    let resolved = grants.get(ctx);
    if (!resolved) {
      resolved = (async () => {
        const domain = getTool();
        const token = await tokenOf(ctx);
        if (!domain || !token) return null;
        // The live pending grant, or, for its holder signed in with a
        // SESSION (the handler reads the session, never a key), the active
        // grant the JIT sweep already flipped (the G1 path of the claim).
        const live = await domain.collaborators.findLiveByClaimToken(token);
        if (live) return { workspaceId: live.grant.workspaceId, email: live.grant.email };
        if (!ctx.principal || ctx.principal.via !== 'session') return null;
        const swept = await domain.collaborators.findActiveByClaimTokenFor(token, ctx.principal.userId);
        return swept ? { workspaceId: swept.grant.workspaceId, email: swept.grant.email } : null;
      })();
      grants.set(ctx, resolved);
    }
    return resolved;
  };

  return {
    /**
     * The collaborator invite: the caller's workspace, the body's email. Only
     * a caller the handler would let invite is judged: one who can read AND
     * administer the deck (its owner, a workspace admin or owner), and, for a
     * plain member, only a colleague's address (the handler refuses an
     * outsider's as `external_invite_forbidden`). Anyone else gets the
     * handler's own answer, never a plan refusal on a deck they may not see.
     */
    collaboratorInviteSeats: async (ctx: EntitlementRequest): Promise<number | null> => {
      const domain = getTool();
      const email = await emailOf(ctx);
      const deckId = ctx.params.id;
      if (!domain || !ctx.principal || !email || !deckId) return null;
      const deck = await domain.presentations.get(ctx.principal.workspaceId, deckId);
      if (!deck || !(await domain.presentations.canRead(ctx.principal, deck))) return null;
      if (!canAdministerDeck(ctx.principal, deck)) return null;
      const pool = await seatPool(db, ctx.principal.workspaceId);
      if (ctx.principal.role === 'member' && !pool.memberEmails.has(email)) return null;
      return seatsAfterInvite(pool, email);
    },

    /** The collaborator claim: the workspace the grant opens; its account is what the gate judges. */
    collaboratorClaimActor: async (ctx: EntitlementRequest): Promise<ActorRef | null> => {
      const grant = await grantOf(ctx);
      if (!grant) return null;
      const [ws] = await db
        .select({ centralAccountId: workspaces.centralAccountId })
        .from(workspaces)
        .where(eq(workspaces.id, grant.workspaceId))
        .limit(1);
      return {
        userId: null,
        workspaceId: grant.workspaceId,
        ...(ws?.centralAccountId ? { accountRef: ws.centralAccountId } : {})
      };
    },

    collaboratorClaimSeats: async (ctx: EntitlementRequest): Promise<number | null> => {
      const grant = await grantOf(ctx);
      if (!grant) return null;
      return seatsAfterJoin(await seatPool(db, grant.workspaceId), grant.email.toLowerCase());
    }
  };
}
