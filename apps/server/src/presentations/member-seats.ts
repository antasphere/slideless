import { and, eq, gt, isNull } from 'drizzle-orm';
import type { ActorRef, EntitlementRequest } from '@antasphere/chassis-contract';
import {
  invitations,
  user as userTable,
  workspaceMembers,
  workspaces,
  type Db
} from '@antasphere/chassis-db';
import { InvitationService } from '@antasphere/chassis-server/invitations';
import { collaborators } from '@slideless/db';
import type { DeckDomain } from '../tool.js';

/**
 * The member cap's one seat pool (PRDCT-2702, the wave's ruling 2 of 24
 * September 2026): a workspace's seats are its ACTIVE members of every
 * origin (guests included) plus the addresses that hold an open invitation
 * of either kind, a live pending collaborator grant or an open workspace
 * invitation, and are not members yet. The four doors that add a member
 * (the collaborator invite and claim, the workspace invitation create and
 * accept) each report the seats AFTER their act, and the gate refuses when
 * that exceeds `workspace.members` for the plan: a fourth seat on free is
 * refused at the invite, and a workspace downgraded above the cap takes
 * nobody in until it is under it again.
 *
 * Every hook resolves through the late-bound domain at request time and
 * answers null on anything it cannot resolve (no principal, no body, a token
 * the instance does not know, a lookup that throws): the gate then leaves the
 * route to its own handling (its 404, 409 or 410), never a plan refusal on a
 * lookup error.
 */

interface SeatPool {
  /** The active members, every origin. */
  members: number;
  /** The lowercased emails of the active members. */
  memberEmails: Set<string>;
  /** The lowercased emails holding an open invitation of either kind that are not members. */
  reserved: Set<string>;
}

async function seatPool(db: Db, workspaceId: string): Promise<SeatPool> {
  const now = new Date();
  const [memberRows, grantRows, invitationRows] = await Promise.all([
    db
      .select({ email: userTable.email })
      .from(workspaceMembers)
      .innerJoin(userTable, eq(workspaceMembers.userId, userTable.id))
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.isActive, true))),
    db
      .select({ email: collaborators.email })
      .from(collaborators)
      .where(
        and(
          eq(collaborators.workspaceId, workspaceId),
          eq(collaborators.status, 'pending'),
          isNull(collaborators.revokedAt),
          gt(collaborators.claimExpiresAt, now)
        )
      ),
    db
      .select({ email: invitations.email })
      .from(invitations)
      .where(
        and(
          eq(invitations.workspaceId, workspaceId),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
          gt(invitations.expiresAt, now)
        )
      )
  ]);
  const memberEmails = new Set(memberRows.map((r) => r.email.toLowerCase()));
  const reserved = new Set<string>();
  for (const row of [...grantRows, ...invitationRows]) {
    const email = row.email.toLowerCase();
    if (!memberEmails.has(email)) reserved.add(email);
  }
  return { members: memberRows.length, memberEmails, reserved };
}

/** The seats after inviting `email` into the pool: one more unless the address already holds a seat. */
function seatsAfterInvite(pool: SeatPool, email: string): number {
  const counted = pool.memberEmails.has(email) || pool.reserved.has(email);
  return pool.members + pool.reserved.size + (counted ? 0 : 1);
}

/** The seats after `email` joins on its own invitation: its reservation becomes a membership. */
function seatsAfterJoin(pool: SeatPool, email: string): number {
  const reservedOthers = pool.reserved.size - (pool.reserved.has(email) ? 1 : 0);
  return pool.members + reservedOthers + (pool.memberEmails.has(email) ? 0 : 1);
}

async function emailOf(ctx: EntitlementRequest): Promise<string | null> {
  const body = (await ctx.body()) as { email?: unknown } | undefined;
  return typeof body?.email === 'string' && body.email.trim() ? body.email.toLowerCase().trim() : null;
}

async function tokenOf(ctx: EntitlementRequest): Promise<string | null> {
  const body = (await ctx.body()) as { token?: unknown } | undefined;
  return typeof body?.token === 'string' && body.token ? body.token : null;
}

async function accountOf(db: Db, workspaceId: string): Promise<string | null> {
  const [ws] = await db
    .select({ centralAccountId: workspaces.centralAccountId })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return ws?.centralAccountId ?? null;
}

/** The live pending grant behind a claim token, or, for its signed-in owner, the active grant the JIT sweep already flipped (the G1 path). */
async function grantOf(
  domain: DeckDomain,
  ctx: EntitlementRequest
): Promise<{ workspaceId: string; email: string } | null> {
  const token = await tokenOf(ctx);
  if (!token) return null;
  const live = await domain.collaborators.findLiveByClaimToken(token);
  if (live) return { workspaceId: live.grant.workspaceId, email: live.grant.email };
  if (!ctx.principal) return null;
  const swept = await domain.collaborators.findActiveByClaimTokenFor(token, ctx.principal.userId);
  return swept ? { workspaceId: swept.grant.workspaceId, email: swept.grant.email } : null;
}

export function memberSeatHooks(db: Db, getTool: () => DeckDomain | null) {
  const guarded =
    <T>(hook: (ctx: EntitlementRequest) => Promise<T | null>) =>
    async (ctx: EntitlementRequest): Promise<T | null> => {
      try {
        return await hook(ctx);
      } catch {
        return null;
      }
    };

  return {
    /** The collaborator invite: the caller's workspace, the body's email. */
    collaboratorInviteSeats: guarded(async (ctx) => {
      const email = await emailOf(ctx);
      if (!ctx.principal || !email) return null;
      return seatsAfterInvite(await seatPool(db, ctx.principal.workspaceId), email);
    }),

    /** The collaborator claim: the workspace the grant opens; its account is what the gate judges. */
    collaboratorClaimActor: guarded(async (ctx): Promise<ActorRef | null> => {
      const domain = getTool();
      if (!domain) return null;
      const grant = await grantOf(domain, ctx);
      if (!grant) return null;
      const accountRef = await accountOf(db, grant.workspaceId);
      return { userId: null, workspaceId: grant.workspaceId, ...(accountRef ? { accountRef } : {}) };
    }),

    collaboratorClaimSeats: guarded(async (ctx) => {
      const domain = getTool();
      if (!domain) return null;
      const grant = await grantOf(domain, ctx);
      if (!grant) return null;
      return seatsAfterJoin(await seatPool(db, grant.workspaceId), grant.email.toLowerCase());
    }),

    /**
     * The workspace invitation: the caller's workspace, the body's email. On
     * a hub-projected workspace (the principal carries an account) the door
     * is the hub's: `hub_managed` answers, and this hook says nothing so the
     * plan gate never speaks before that pointer. The declaration therefore
     * bites only where a cloud-local workspace carries a plan, which none
     * does today; it is kept for that shape (the ruling names it).
     */
    invitationCreateSeats: guarded(async (ctx) => {
      const email = await emailOf(ctx);
      if (!ctx.principal || !email || ctx.principal.accountRef) return null;
      return seatsAfterInvite(await seatPool(db, ctx.principal.workspaceId), email);
    }),

    /** The invitation accept: the workspace the invitation opens; a hub-projected one answers `hub_managed` itself. */
    invitationAcceptActor: guarded(async (ctx): Promise<ActorRef | null> => {
      const token = await tokenOf(ctx);
      if (!token) return null;
      const match = await new InvitationService(db).findLiveByToken(token);
      if (!match) return null;
      const accountRef = await accountOf(db, match.invitation.workspaceId);
      if (accountRef) return null;
      return { userId: null, workspaceId: match.invitation.workspaceId };
    }),

    invitationAcceptSeats: guarded(async (ctx) => {
      const token = await tokenOf(ctx);
      if (!token) return null;
      const match = await new InvitationService(db).findLiveByToken(token);
      if (!match) return null;
      return seatsAfterJoin(
        await seatPool(db, match.invitation.workspaceId),
        match.invitation.email.toLowerCase()
      );
    })
  };
}
