import type { OpenAPIHono } from '@hono/zod-openapi';
import { randomBytes } from 'node:crypto';
import { and, desc, eq, ne } from 'drizzle-orm';
import { createEmailVerificationToken } from 'better-auth/api';
import {
  memberChangeEmailLinkRoute,
  memberDeleteRoute,
  memberResetLinkRoute,
  memberUpdateRoute,
  membersListRoute
} from '@slideless/contract/routes';
import { workspaceMembers, user as userTable, type Db } from '@slideless/db';
import type { Auth } from '../identity/better-auth.js';
import { isLastOwnerDbError, LastOwnerError, type AccountDeletionService } from '../accounts/deletion.js';
import { cursorRowId, keysetBefore, pageOf } from '../pagination.js';
import { requireAuth, requireRole } from '../middleware/auth-context.js';

export interface MemberRouteDeps {
  db: Db;
  auth: Auth;
  publicBaseUrl: string;
  accountDeletion: AccountDeletionService;
}

const err = (code: string, message: string) => ({ error: { code, message } });

const toWire = (m: {
  id: string;
  userId: string;
  email: string;
  name: string;
  role: 'owner' | 'admin' | 'member';
  isActive: boolean;
  createdAt: Date;
  lastSeenAt: Date | null;
}) => ({
  id: m.id,
  userId: m.userId,
  email: m.email,
  name: m.name,
  role: m.role,
  isActive: m.isActive,
  createdAt: m.createdAt.toISOString(),
  lastSeenAt: m.lastSeenAt?.toISOString() ?? null
});

export function registerMemberRoutes(api: OpenAPIHono, deps: MemberRouteDeps): void {
  const { db, auth, publicBaseUrl, accountDeletion } = deps;
  api.use('/members', requireAuth());
  api.openapi(membersListRoute, async (c) => {
    const principal = c.get('principal')!;
    const { cursor, limit } = c.req.valid('query');
    const cursorId = cursorRowId(cursor);
    const rows = await db
      .select({
        id: workspaceMembers.id,
        userId: workspaceMembers.userId,
        email: userTable.email,
        name: userTable.name,
        role: workspaceMembers.role,
        isActive: workspaceMembers.isActive,
        createdAt: workspaceMembers.createdAt,
        lastSeenAt: workspaceMembers.lastSeenAt
      })
      .from(workspaceMembers)
      .innerJoin(userTable, eq(workspaceMembers.userId, userTable.id))
      .where(
        and(
          eq(workspaceMembers.workspaceId, principal.workspaceId),
          ...(cursorId
            ? [
                keysetBefore({
                  table: workspaceMembers,
                  id: workspaceMembers.id,
                  createdAt: workspaceMembers.createdAt,
                  workspaceId: workspaceMembers.workspaceId,
                  cursorId,
                  workspace: principal.workspaceId
                })
              ]
            : [])
        )
      )
      .orderBy(desc(workspaceMembers.createdAt), desc(workspaceMembers.id))
      .limit(limit + 1);
    const { page, nextCursor } = pageOf(rows, limit);
    return c.json({ members: page.map(toWire), nextCursor }, 200);
  });

  api.use('/members/:id', requireRole('admin'));
  api.openapi(memberUpdateRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id } = c.req.valid('param');
    const patch = c.req.valid('json');

    const [target] = await db
      .select({
        id: workspaceMembers.id,
        userId: workspaceMembers.userId,
        role: workspaceMembers.role,
        isActive: workspaceMembers.isActive
      })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.id, id), eq(workspaceMembers.workspaceId, principal.workspaceId)))
      .limit(1);
    if (!target) return c.json(err('not_found', 'Member not found'), 404);

    if (target.userId === principal.userId && patch.isActive === false) {
      return c.json(err('cannot_deactivate_self', 'You cannot deactivate yourself'), 400);
    }
    // Only owners touch owners (grant or revoke).
    if ((target.role === 'owner' || patch.role === 'owner') && principal.role !== 'owner') {
      return c.json(err('forbidden', 'Only an owner can change owner roles'), 403);
    }
    // Never leave the workspace without an active owner (shared with the
    // account-deletion guards in accounts/deletion.ts). Demotions run under
    // the race-free guard: workspace advisory lock + re-check, with the
    // migration-0009 trigger as the DB-level backstop — a concurrent-race
    // loser gets this clean 400, never a 500.
    const losesOwner =
      target.role === 'owner' && ((patch.role && patch.role !== 'owner') || patch.isActive === false);
    const applyPatch = async () => {
      await db
        .update(workspaceMembers)
        .set({
          ...(patch.role ? { role: patch.role } : {}),
          ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {})
        })
        .where(eq(workspaceMembers.id, target.id));
    };
    try {
      if (losesOwner) {
        await accountDeletion.withLastOwnerGuard(principal.workspaceId, target.userId, applyPatch);
      } else {
        await applyPatch();
      }
    } catch (cause) {
      // The guarded loser throws LastOwnerError; the unguarded branch (or a
      // demotion racing invitation re-acceptance) can still trip the 0009
      // trigger with P0409 — both mean the last active owner would be lost.
      if (cause instanceof LastOwnerError || isLastOwnerDbError(cause)) {
        const message =
          cause instanceof LastOwnerError
            ? cause.message
            : 'The workspace must keep at least one active owner';
        return c.json(err('last_owner', message), 400);
      }
      throw cause;
    }

    const [updated] = await db
      .select({
        id: workspaceMembers.id,
        userId: workspaceMembers.userId,
        email: userTable.email,
        name: userTable.name,
        role: workspaceMembers.role,
        isActive: workspaceMembers.isActive,
        createdAt: workspaceMembers.createdAt,
        lastSeenAt: workspaceMembers.lastSeenAt
      })
      .from(workspaceMembers)
      .innerJoin(userTable, eq(workspaceMembers.userId, userTable.id))
      .where(eq(workspaceMembers.id, target.id))
      .limit(1);

    c.set('audit', {
      action: 'member.update',
      resourceType: 'member',
      resourceId: target.id,
      metadata: { ...patch, targetUserId: target.userId }
    });
    return c.json(toWire(updated!), 200);
  });

  // Admin account deletion (GDPR erasure, the second delete surface).
  // Covered by the 2-segment `/members/:id` requireRole gate above; machines
  // are excluded automatically because DELETE /members/{id} is deliberately
  // unlisted in the fail-closed scope allowlist. Files the target uploaded
  // stay with the workspace (created_by → NULL via FK); NO blob cleanup.
  api.openapi(memberDeleteRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id } = c.req.valid('param');

    const [target] = await db
      .select({
        id: workspaceMembers.id,
        userId: workspaceMembers.userId,
        role: workspaceMembers.role,
        isActive: workspaceMembers.isActive
      })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.id, id), eq(workspaceMembers.workspaceId, principal.workspaceId)))
      .limit(1);
    if (!target) return c.json(err('not_found', 'Member not found'), 404);
    if (target.userId === principal.userId) {
      return c.json(err('cannot_delete_self', 'Delete your own account from the account page'), 400);
    }
    if (target.role === 'owner' && principal.role !== 'owner') {
      return c.json(err('forbidden', 'Only an owner can delete an owner'), 403);
    }
    // ADR 014: deleting the ACCOUNT erases the user from EVERY workspace, and
    // an admin's authority ends at their own — refuse when the target belongs
    // to any other workspace (deactivate the membership instead; the account
    // holder can erase themselves). Single-workspace instances never hit this.
    const [foreign] = await db
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.userId, target.userId),
          ne(workspaceMembers.workspaceId, principal.workspaceId)
        )
      )
      .limit(1);
    if (foreign) {
      return c.json(
        err(
          'member_of_other_workspaces',
          'This account belongs to other workspaces — deactivate the membership instead of deleting the account'
        ),
        409
      );
    }

    // Snapshot the wire member BEFORE the cascade removes the joined user row.
    const [snapshot] = await db
      .select({
        id: workspaceMembers.id,
        userId: workspaceMembers.userId,
        email: userTable.email,
        name: userTable.name,
        role: workspaceMembers.role,
        isActive: workspaceMembers.isActive,
        createdAt: workspaceMembers.createdAt,
        lastSeenAt: workspaceMembers.lastSeenAt
      })
      .from(workspaceMembers)
      .innerJoin(userTable, eq(workspaceMembers.userId, userTable.id))
      .where(eq(workspaceMembers.id, target.id))
      .limit(1);

    // Better Auth's own deletion path (adapter hooks included) — NOT raw
    // drizzle. Membership, api keys, invitations they issued, and sessions
    // cascade; audit rows and file uploader anonymize via SET NULL.
    // Deleting an ACTIVE OWNER runs under the race-free last-owner guard
    // (workspace advisory lock + re-check; the migration-0009 trigger
    // backstops) so a concurrent-race loser gets a clean 400 last_owner.
    const cascade = async () => {
      const authCtx = await auth.$context;
      await authCtx.internalAdapter.deleteUser(target.userId);
      await authCtx.internalAdapter.deleteUserSessions(target.userId);
    };
    try {
      if (target.role === 'owner' && target.isActive) {
        await accountDeletion.withLastOwnerGuard(principal.workspaceId, target.userId, cascade);
      } else {
        await cascade();
      }
    } catch (cause) {
      // isLastOwnerDbError: the unguarded branch can still trip the trigger
      // when the target is promoted to last owner mid-flight.
      if (cause instanceof LastOwnerError || isLastOwnerDbError(cause)) {
        return c.json(err('last_owner', 'The workspace must keep at least one active owner'), 400);
      }
      throw cause;
    }

    c.set('audit', {
      action: 'member.delete',
      resourceType: 'member',
      resourceId: target.id,
      metadata: { targetUserId: target.userId, email: snapshot!.email }
    });
    return c.json(toWire(snapshot!), 200);
  });

  // Admin-generated password reset link — the recovery path that works with
  // no email driver (invitations' copyable-link pattern). The 2-segment gate
  // above does NOT cover this 3-segment path, so gate it explicitly.
  api.use('/members/:id/reset-link', requireRole('admin'));
  api.openapi(memberResetLinkRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id } = c.req.valid('param');

    const [target] = await db
      .select({ id: workspaceMembers.id, userId: workspaceMembers.userId, role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.id, id), eq(workspaceMembers.workspaceId, principal.workspaceId)))
      .limit(1);
    if (!target) return c.json(err('not_found', 'Member not found'), 404);
    if (target.role === 'owner' && principal.role !== 'owner') {
      return c.json(err('forbidden', 'Only an owner can reset an owner'), 403);
    }

    // Mint a single-use token in Better Auth's own verification table, in the
    // exact shape POST /reset-password consumes (`reset-password:<token>`).
    const token = randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1h
    const authCtx = await auth.$context;
    await authCtx.internalAdapter.createVerificationValue({
      identifier: `reset-password:${token}`,
      value: target.userId,
      expiresAt
    });

    c.set('audit', {
      action: 'member.reset_link',
      resourceType: 'member',
      resourceId: target.id,
      metadata: { targetUserId: target.userId }
    });
    return c.json(
      {
        resetUrl: `${publicBaseUrl.replace(/\/+$/, '')}/reset-password?token=${token}`,
        expiresAt: expiresAt.toISOString()
      },
      200
    );
  });

  // Admin-generated email change link — the email-change path that works
  // with no email driver (same copyable-link pattern as the reset link).
  // The 2-segment gate above does NOT cover this 3-segment path either, so
  // gate it explicitly.
  api.use('/members/:id/change-email-link', requireRole('admin'));
  api.openapi(memberChangeEmailLinkRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');

    const [target] = await db
      .select({
        id: workspaceMembers.id,
        userId: workspaceMembers.userId,
        role: workspaceMembers.role,
        email: userTable.email
      })
      .from(workspaceMembers)
      .innerJoin(userTable, eq(workspaceMembers.userId, userTable.id))
      .where(and(eq(workspaceMembers.id, id), eq(workspaceMembers.workspaceId, principal.workspaceId)))
      .limit(1);
    if (!target) return c.json(err('not_found', 'Member not found'), 404);
    if (target.role === 'owner' && principal.role !== 'owner') {
      return c.json(err('forbidden', "Only an owner can change an owner's email"), 403);
    }

    // Better Auth stores emails lowercased — compare and mint in that form.
    const newEmail = body.newEmail.toLowerCase();
    const [existing] = await db
      .select({ id: userTable.id })
      .from(userTable)
      .where(eq(userTable.email, newEmail))
      .limit(1);
    if (existing) {
      return c.json(err('email_taken', 'That email is already in use'), 409);
    }

    // Mint the exact stateless JWT GET /verify-email consumes for an email
    // change ({email: current, updateTo: new, requestType}), signed with the
    // auth secret — Better Auth's own helper, never hand-rolled jose.
    // ⚠️ Consuming this link updates the email AND signs the target in (a
    // session is created when none exists) — it is sign-in-equivalent. Hand
    // it to the target member only, never to anyone else.
    const expiresIn = 3600; // 1h
    const expiresAt = new Date(Date.now() + expiresIn * 1000);
    const authCtx = await auth.$context;
    const token = await createEmailVerificationToken(authCtx.secret, target.email, newEmail, expiresIn, {
      requestType: 'change-email-verification'
    });
    const verifyUrl = `${publicBaseUrl.replace(/\/+$/, '')}/api/v1/auth/verify-email?token=${token}&callbackURL=%2Faccount`;

    c.set('audit', {
      action: 'member.change_email_link',
      resourceType: 'member',
      resourceId: target.id,
      metadata: { targetUserId: target.userId, newEmail }
    });
    return c.json({ verifyUrl, newEmail, expiresAt: expiresAt.toISOString() }, 200);
  });
}
