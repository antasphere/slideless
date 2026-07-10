import type { OpenAPIHono } from '@hono/zod-openapi';
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  invitationAcceptRoute,
  invitationCreateRoute,
  invitationLookupRoute,
  invitationRevokeRoute,
  invitationsListRoute
} from '@slideless/contract/routes';
import { invitations, workspaces, user as userTable, type Db, type Invitation } from '@slideless/db';
import type { Env } from '../env.js';
import type { Logger } from '../logger.js';
import type { Auth } from '../identity/better-auth.js';
import type { EmailDriver } from '../email/driver.js';
import type { PlatformRegistry } from '../platform/registry.js';
import type { AuditService } from '../audit/service.js';
import { buildInviteEmail } from '../email/templates.js';
import { InvitationError, InvitationService } from '../invitations/service.js';
import { cursorRowId, keysetBefore, pageOf } from '../pagination.js';
import { requireRole } from '../middleware/auth-context.js';

const err = (code: string, message: string) => ({ error: { code, message } });

const toWire = (i: Invitation) => ({
  id: i.id,
  email: i.email,
  role: i.role,
  invitedBy: i.invitedBy,
  expiresAt: i.expiresAt.toISOString(),
  acceptedAt: i.acceptedAt?.toISOString() ?? null,
  revokedAt: i.revokedAt?.toISOString() ?? null,
  createdAt: i.createdAt.toISOString()
});

export interface InvitationRouteDeps {
  db: Db;
  env: Pick<Env, 'PUBLIC_BASE_URL'>;
  auth: Auth;
  email: EmailDriver;
  audit: AuditService;
  registry: PlatformRegistry;
  logger: Logger;
}

export function registerInvitationRoutes(api: OpenAPIHono, deps: InvitationRouteDeps): void {
  const { db, env, auth, email, audit, registry, logger } = deps;
  const service = new InvitationService(db);

  api.use('/invitations', requireRole('admin'));
  // /invitations/lookup and /invitations/accept are public by design (the
  // invitee has no account yet): rate-limited in api/index.ts and gated by
  // the unguessable 256-bit token. The :id pattern would swallow them, so the
  // admin gate skips exactly those two segments.
  const adminGate = requireRole('admin');
  api.use('/invitations/:id', async (c, next) => {
    const seg = c.req.path.split('/').pop();
    // Method-exact skip: GET lookup and POST accept are the only public
    // shapes; a DELETE /invitations/lookup must still hit the admin gate.
    if ((seg === 'lookup' && c.req.method === 'GET') || (seg === 'accept' && c.req.method === 'POST')) {
      return next();
    }
    return adminGate(c, next);
  });

  api.openapi(invitationsListRoute, async (c) => {
    const principal = c.get('principal')!;
    const { cursor, limit } = c.req.valid('query');
    const cursorId = cursorRowId(cursor);
    const rows = await db
      .select()
      .from(invitations)
      .where(
        and(
          eq(invitations.workspaceId, principal.workspaceId),
          ...(cursorId
            ? [
                keysetBefore({
                  table: invitations,
                  id: invitations.id,
                  createdAt: invitations.createdAt,
                  workspaceId: invitations.workspaceId,
                  cursorId,
                  workspace: principal.workspaceId
                })
              ]
            : [])
        )
      )
      .orderBy(desc(invitations.createdAt), desc(invitations.id))
      .limit(limit + 1);
    const { page, nextCursor } = pageOf(rows, limit);
    return c.json({ invitations: page.map(toWire), nextCursor }, 200);
  });

  api.openapi(invitationCreateRoute, async (c) => {
    const principal = c.get('principal')!;
    const body = c.req.valid('json');
    // Only owners can invite owners.
    if (body.role === 'owner' && principal.role !== 'owner') {
      return c.json(err('forbidden', 'Only an owner can invite an owner'), 403);
    }
    let created: Awaited<ReturnType<InvitationService['create']>>;
    try {
      created = await service.create({
        workspaceId: principal.workspaceId,
        email: body.email,
        role: body.role,
        invitedBy: principal.userId
      });
    } catch (e) {
      if (e instanceof InvitationError) return c.json(err(e.code, e.message), 409);
      throw e;
    }

    // The copyable link is the product; email is best-effort on top. The
    // mail carries the invitation's SECOND token — one the inviter never
    // sees — so an accept with it proves control of the invited mailbox
    // (that accept path may honestly set emailVerified; ADR 009).
    const acceptUrl = `${env.PUBLIC_BASE_URL}/invite/${created.token}`;
    let emailSent = false;
    if (email.delivers) {
      const [ws] = await db
        .select({ name: workspaces.name })
        .from(workspaces)
        .where(eq(workspaces.id, principal.workspaceId))
        .limit(1);
      try {
        const msg = buildInviteEmail({
          inviteeEmail: created.invitation.email,
          inviterName: principal.name,
          workspaceName: ws?.name ?? 'the workspace',
          acceptUrl: `${env.PUBLIC_BASE_URL}/invite/${created.emailToken}`,
          expiresAt: created.invitation.expiresAt
        });
        await email.send({ to: created.invitation.email, ...msg });
        emailSent = true;
      } catch (e) {
        logger.error({ err: e }, 'invitation email failed (link still valid)');
      }
    }

    registry.events.emit('invitation.created', {
      workspaceId: principal.workspaceId,
      invitationId: created.invitation.id
    });
    c.set('audit', {
      action: 'invitation.create',
      resourceType: 'invitation',
      resourceId: created.invitation.id,
      metadata: { email: created.invitation.email, role: created.invitation.role }
    });
    return c.json({ invitation: toWire(created.invitation), acceptUrl, emailSent }, 201);
  });

  api.openapi(invitationRevokeRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id } = c.req.valid('param');
    const [invitation] = await db
      .select()
      .from(invitations)
      .where(and(eq(invitations.id, id), eq(invitations.workspaceId, principal.workspaceId)))
      .limit(1);
    if (!invitation) return c.json(err('not_found', 'Invitation not found'), 404);
    if (!invitation.revokedAt && !invitation.acceptedAt) {
      await db
        .update(invitations)
        .set({ revokedAt: sql`now()` })
        .where(eq(invitations.id, id));
    }
    const [updated] = await db.select().from(invitations).where(eq(invitations.id, id)).limit(1);
    c.set('audit', { action: 'invitation.revoke', resourceType: 'invitation', resourceId: id });
    return c.json(toWire(updated!), 200);
  });

  api.openapi(invitationLookupRoute, async (c) => {
    const { token } = c.req.valid('query');
    const match = await service.findLiveByToken(token);
    if (!match) return c.json(err('not_found', 'Invitation not found or no longer valid'), 404);
    const { invitation } = match;
    const [ws] = await db
      .select({ name: workspaces.name })
      .from(workspaces)
      .where(eq(workspaces.id, invitation.workspaceId))
      .limit(1);
    const [account] = await db
      .select({ id: userTable.id })
      .from(userTable)
      .where(eq(userTable.email, invitation.email))
      .limit(1);
    return c.json(
      {
        email: invitation.email,
        role: invitation.role,
        workspaceName: ws?.name ?? '',
        expiresAt: invitation.expiresAt.toISOString(),
        accountExists: Boolean(account)
      },
      200
    );
  });

  api.openapi(invitationAcceptRoute, async (c) => {
    const body = c.req.valid('json');
    const match = await service.findLiveByToken(body.token);
    if (!match) return c.json(err('not_found', 'Invitation not found or no longer valid'), 404);
    const { invitation, viaEmailToken } = match;

    const [account] = await db
      .select({ id: userTable.id, emailVerified: userTable.emailVerified })
      .from(userTable)
      .where(eq(userTable.email, invitation.email))
      .limit(1);

    let userId: string;
    let alreadyVerified = false;
    if (account) {
      // Existing account: the caller must BE that account (signed in).
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      if (!session?.user || session.user.email !== invitation.email) {
        return c.json(
          err('account_exists', 'An account with this email exists — sign in with it, then accept again'),
          409
        );
      }
      userId = session.user.id;
      alreadyVerified = account.emailVerified;
    } else {
      if (!body.name || !body.password) {
        return c.json(err('credentials_required', 'Provide name and password to create your account'), 400);
      }
      const created = await auth.api.signUpEmail({
        body: { email: invitation.email, password: body.password, name: body.name }
      });
      userId = created.user.id;
      registry.events.emit('user.created', { userId, email: invitation.email });
    }

    const accepted = await service.accept(invitation, userId);
    if (!accepted) return c.json(err('already_accepted', 'This invitation was already used'), 410);

    // Email-verification honesty (ADR 009): the emailed token was delivered
    // ONLY to the invited address, so presenting it proves mailbox control —
    // mark the account verified. The admin-visible copyable link proves
    // nothing: never flip the flag for it; instead, when an email driver
    // delivers, fire Better Auth's verification mail (M6 plumbing) so the
    // address can still be proven — best-effort, acceptance already stands.
    let emailVerified = alreadyVerified;
    if (viaEmailToken && !alreadyVerified) {
      await db.update(userTable).set({ emailVerified: true }).where(eq(userTable.id, userId));
      emailVerified = true;
    } else if (!viaEmailToken && !alreadyVerified && email.delivers) {
      try {
        await auth.api.sendVerificationEmail({ body: { email: invitation.email, callbackURL: '/' } });
      } catch (e) {
        logger.error({ err: e }, 'post-accept verification email failed (membership unaffected)');
      }
    }

    registry.events.emit('invitation.accepted', {
      workspaceId: invitation.workspaceId,
      invitationId: invitation.id,
      userId
    });
    // Public endpoint: no principal in context, write the audit row directly.
    await audit.write({
      workspaceId: invitation.workspaceId,
      principal: null,
      action: 'invitation.accept',
      resourceType: 'invitation',
      resourceId: invitation.id,
      requestId: c.get('requestId'),
      metadata: { email: invitation.email, userId, viaEmailToken, emailVerified }
    });

    return c.json({ workspaceId: invitation.workspaceId, userId, role: invitation.role }, 200);
  });
}
