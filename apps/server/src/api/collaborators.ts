import type { OpenAPIHono } from '@hono/zod-openapi';
import { and, eq } from 'drizzle-orm';
import {
  collaboratorClaimRoute,
  collaboratorInviteRoute,
  collaboratorLookupRoute,
  collaboratorRemoveRoute,
  collaboratorsListRoute
} from '@slideless/contract/routes';
import { user as userTable, workspaceMembers, type Db } from '@slideless/db';
import type { Env } from '../env.js';
import type { Logger } from '../logger.js';
import type { Auth } from '../identity/better-auth.js';
import type { EmailDriver } from '../email/driver.js';
import type { PlatformRegistry } from '../platform/registry.js';
import type { AuditService } from '../audit/service.js';
import { buildCollaboratorInviteEmail } from '../email/templates.js';
import type { HubSsoService } from '../identity/hub-sso.js';
import { canAdministerDeck, type PresentationService } from '../presentations/service.js';
import {
  CollaboratorError,
  collaboratorToWire,
  type CollaboratorClaimMatch,
  type CollaboratorService
} from '../collaborators/service.js';

/**
 * Per-deck collaborators (Phase 5): the deck-scoped management routes
 * (owner-level control only — dev collaborators cannot see or change the
 * grant list that empowers them) and the PUBLIC claim surface (the
 * invitations lookup/accept pattern applied to decks).
 *
 * CLAIM SEMANTICS (the template invitation semantics, deliberately):
 *  - Inviting an email NEVER auto-activates, even when an account with that
 *    email already exists — the invitee must claim (open the link signed in,
 *    or POST the token from a session of that exact email). Silently
 *    empowering an account someone merely typed an address for is not a
 *    thing this codebase does (same reasoning as workspace invitations).
 *  - A brand-new invitee claims AT SIGN-UP: the claim endpoint creates the
 *    account (closed sign-up's third sanctioned entrance, next to setup and
 *    invitation accept), makes it a workspace MEMBER (the platform requires
 *    a membership to authenticate at all — the per-deck grant rides on top
 *    of the ordinary lowest role), and activates the grant. **oss only**:
 *    on EDITION=cloud identity is hub-only (D1), so the account-creation
 *    branch answers 409 sso_required instead — the claim page routes the
 *    invitee through "Sign in with Antasphere" (the P3 entrance: JIT +
 *    the deliberate fourth signup switch) and claims signed-in. The JIT
 *    login's grant sweep usually flips the grant BEFORE the claim POST
 *    arrives; the G1 cross-request fallback below is what makes that
 *    sequence land. No hub org membership is created anywhere here — the
 *    guest gets only the origin='guest' row in the DECK's workspace.
 *  - A user created through a WORKSPACE invitation auto-claims any pending
 *    grants for their email via the `user.created` event hook (boot.ts) —
 *    the same moment the template redeems its own invitations.
 *  - Claiming with the EMAIL-ONLY token proves mailbox control and may set
 *    `emailVerified` (ADR 009); the copyable link never does — it fires the
 *    verification mail instead when a driver delivers.
 */

const err = (code: string, message: string) => ({ error: { code, message } });

/**
 * True when a failed signUpEmail means "this email already has an account":
 * either Better Auth's own pre-check (APIError USER_ALREADY_EXISTS / 422) or,
 * in the tight concurrent-claim race where two claims pass the account lookup
 * together, the losing INSERT's Postgres unique_violation (23505) on the
 * user email — found anywhere down the wrapped error's `cause` chain.
 */
function isDuplicateAccountError(e: unknown): boolean {
  for (let cur: unknown = e, depth = 0; cur instanceof Error && depth < 10; cur = cur.cause, depth++) {
    const anyErr = cur as { code?: unknown; status?: unknown; body?: { code?: unknown } };
    if (anyErr.code === '23505') return true;
    if (anyErr.body?.code === 'USER_ALREADY_EXISTS') return true;
    if (anyErr.status === 'UNPROCESSABLE_ENTITY' || anyErr.status === 422) return true;
  }
  return false;
}

export interface CollaboratorRouteDeps {
  db: Db;
  env: Pick<Env, 'PUBLIC_BASE_URL'>;
  auth: Auth;
  email: EmailDriver;
  audit: AuditService;
  registry: PlatformRegistry;
  logger: Logger;
  presentations: PresentationService;
  collaborators: CollaboratorService;
  /**
   * Cloud edition only (docs/federation.md P6) — the same presence switch
   * every cloud seam keys on (boot constructs it iff EDITION=cloud, so oss
   * provably carries zero hub surface here). Present, the claim endpoint's
   * account-creation branch is CLOSED (409 sso_required): cloud identity is
   * hub-only (D1), and the invitee arrives through the P3 SSO entrance
   * instead. Only the boolean presence is consulted — the service itself is
   * never called from this module.
   */
  hubSso?: HubSsoService | undefined;
}

export function registerCollaboratorRoutes(api: OpenAPIHono, deps: CollaboratorRouteDeps): void {
  const { db, env, auth, email, audit, registry, logger, presentations, collaborators, hubSso } = deps;

  const claimUrlOf = (token: string): string => `${env.PUBLIC_BASE_URL}/collab/${token}`;

  // ── Deck-scoped management (authenticated; /presentations/* is requireAuth-gated) ──

  api.openapi(collaboratorsListRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id } = c.req.valid('param');
    const { cursor, limit } = c.req.valid('query');
    const deck = await presentations.get(principal.workspaceId, id);
    if (!deck) return c.json(err('not_found', 'Presentation not found'), 404);
    // Owner-level control OR active dev may see the roster; a plain member
    // gets 404 (the contract declares no 403 here — hide the roster).
    if (!(await presentations.canWrite(principal, deck))) {
      return c.json(err('not_found', 'Presentation not found'), 404);
    }
    const { collaborators: rows, nextCursor } = await collaborators.list(principal.workspaceId, id, {
      ...(cursor !== undefined ? { cursor } : {}),
      limit
    });
    // collaboratorToWire never exposes claim token hashes.
    return c.json({ collaborators: rows.map(collaboratorToWire), nextCursor }, 200);
  });

  api.openapi(collaboratorInviteRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const deck = await presentations.get(principal.workspaceId, id);
    if (!deck) return c.json(err('not_found', 'Presentation not found'), 404);
    if (!canAdministerDeck(principal, deck)) {
      return c.json(
        err('forbidden', 'Only the deck owner or a workspace admin can invite collaborators'),
        403
      );
    }

    const invitee = body.email.toLowerCase().trim();
    if (deck.ownerUserId) {
      const [owner] = await db
        .select({ email: userTable.email })
        .from(userTable)
        .where(eq(userTable.id, deck.ownerUserId))
        .limit(1);
      if (owner && owner.email.toLowerCase() === invitee) {
        return c.json(err('already_owner', 'The deck owner does not need a collaborator grant'), 409);
      }
    }

    let created: Awaited<ReturnType<CollaboratorService['invite']>>;
    try {
      created = await collaborators.invite({
        workspaceId: principal.workspaceId,
        presentationId: id,
        email: invitee,
        invitedBy: principal.userId
      });
    } catch (e) {
      if (e instanceof CollaboratorError) return c.json(err(e.code, e.message), 409);
      throw e;
    }

    // The copyable link is the product; email is best-effort on top and
    // carries the SECOND token the inviter never sees (ADR 009).
    let emailSent = false;
    if (email.delivers) {
      try {
        const msg = buildCollaboratorInviteEmail({
          inviteeEmail: created.grant.email,
          inviterName: principal.name,
          presentationTitle: deck.title,
          claimUrl: claimUrlOf(created.emailClaimToken),
          expiresAt: created.grant.claimExpiresAt!
        });
        await email.send({ to: created.grant.email, ...msg });
        emailSent = true;
      } catch (e) {
        logger.error({ err: e }, 'collaborator invite email failed (claim link still valid)');
      }
    }

    c.set('audit', {
      action: 'presentation.collaborator_invite',
      resourceType: 'collaborator',
      resourceId: created.grant.id,
      metadata: { presentationId: id, email: created.grant.email }
    });
    return c.json(
      {
        collaborator: collaboratorToWire(created.grant),
        claimUrl: claimUrlOf(created.claimToken),
        emailSent
      },
      201
    );
  });

  api.openapi(collaboratorRemoveRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id, collaboratorId } = c.req.valid('param');
    const deck = await presentations.get(principal.workspaceId, id);
    if (!deck) return c.json(err('not_found', 'Presentation not found'), 404);
    if (!canAdministerDeck(principal, deck)) {
      return c.json(
        err('forbidden', 'Only the deck owner or a workspace admin can revoke collaborators'),
        403
      );
    }
    const grant = await collaborators.get(principal.workspaceId, id, collaboratorId);
    if (!grant) return c.json(err('not_found', 'Collaborator not found'), 404);
    const revoked = (await collaborators.revoke(grant.id)) ?? grant;
    c.set('audit', {
      action: 'presentation.collaborator_revoke',
      resourceType: 'collaborator',
      resourceId: grant.id,
      metadata: { presentationId: id, email: grant.email, wasStatus: grant.status }
    });
    return c.json(collaboratorToWire(revoked), 200);
  });

  // ── Public claim surface (rate-limited in api/index.ts; token = the credential) ──

  api.openapi(collaboratorLookupRoute, async (c) => {
    const { token } = c.req.valid('query');
    const match = await collaborators.findLiveByClaimToken(token);
    if (!match) return c.json(err('not_found', 'Invite not found or no longer valid'), 404);
    const { grant } = match;
    const deck = await presentations.get(grant.workspaceId, grant.presentationId);
    if (!deck) return c.json(err('not_found', 'Invite not found or no longer valid'), 404);
    const [account] = await db
      .select({ id: userTable.id })
      .from(userTable)
      .where(eq(userTable.email, grant.email))
      .limit(1);
    return c.json(
      {
        email: grant.email,
        presentationTitle: deck.title,
        role: grant.role,
        expiresAt: grant.claimExpiresAt!.toISOString(),
        accountExists: Boolean(account)
      },
      200
    );
  });

  api.openapi(collaboratorClaimRoute, async (c) => {
    const body = c.req.valid('json');

    // Resolve the grant. Primary: the live PENDING lookup (what the public
    // lookup answers too). Fallback — the G1 cross-request residual (Phase
    // 6): a grant the user.created sweep flipped to ACTIVE in an EARLIER
    // request (signup through a workspace invitation with a sibling grant
    // elsewhere; the cloud SSO-first claim flow, where JIT login sweeps
    // before this POST arrives) is invisible to the pending-only lookup.
    // It resolves here ONLY for a session of the very user the sweep
    // claimed it for — everyone else keeps the exact 404 an invalid token
    // gets, so used tokens leak nothing. The fallback must run the SAME
    // membership block below: the sweep flips grants but never mints
    // memberships, and without one the deck is unreachable (the reason
    // this claim reads as success, not replay).
    let grant: CollaboratorClaimMatch['grant'];
    let viaEmailToken: boolean;
    /** Set iff the fallback resolved: the session user who owns the grant. */
    let sweptOwnerId: string | null = null;
    const match = await collaborators.findLiveByClaimToken(body.token);
    if (match) {
      ({ grant, viaEmailToken } = match);
    } else {
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      const owned = session?.user
        ? await collaborators.findActiveByClaimTokenFor(body.token, session.user.id)
        : null;
      if (!owned) return c.json(err('not_found', 'Invite not found or no longer valid'), 404);
      ({ grant, viaEmailToken } = owned);
      sweptOwnerId = session!.user.id;
    }

    // A grant to a deleted deck is dead: never mint accounts/memberships for it.
    const deck = await presentations.get(grant.workspaceId, grant.presentationId);
    if (!deck) return c.json(err('not_found', 'Invite not found or no longer valid'), 404);

    let userId: string;
    let alreadyVerified = false;
    if (sweptOwnerId) {
      // Cross-request G1 path: the account provably exists (it owns the
      // grant) and the caller IS it — no account creation, no email gate.
      userId = sweptOwnerId;
      const [self] = await db
        .select({ emailVerified: userTable.emailVerified })
        .from(userTable)
        .where(eq(userTable.id, userId))
        .limit(1);
      alreadyVerified = self?.emailVerified ?? false;
    } else {
      const [account] = await db
        .select({ id: userTable.id, emailVerified: userTable.emailVerified })
        .from(userTable)
        .where(eq(userTable.email, grant.email))
        .limit(1);

      if (account) {
        // Existing account: the caller must BE that account (signed in).
        const session = await auth.api.getSession({ headers: c.req.raw.headers });
        if (!session?.user || session.user.email !== grant.email) {
          return c.json(
            err('account_exists', 'An account with this email exists — sign in with it, then claim again'),
            409
          );
        }
        userId = session.user.id;
        alreadyVerified = account.emailVerified;
      } else {
        if (hubSso) {
          // Cloud (D1): identity is hub-only — a local-password account
          // minted here would be one no cloud login surface accepts, and a
          // second signup entrance beside the sanctioned SSO one. The claim
          // page routes the invitee through "Sign in with Antasphere" (the
          // P3 entrance — JIT, the deliberate fourth signup switch), whose
          // grant sweep + the G1 cross-request fallback above complete the
          // claim on the re-POST. Checked BEFORE the credentials check so
          // the answer never depends on the body shape.
          return c.json(
            err(
              'sso_required',
              'This instance signs in with Antasphere — sign in first, then open the invite link again'
            ),
            409
          );
        }
        if (!body.name || !body.password) {
          return c.json(
            err('credentials_required', 'Provide name and password to create your account'),
            400
          );
        }
        try {
          // `user.created` is emitted by the identity layer's database hook
          // (identity/better-auth.ts) — never from call sites like this one.
          // That hook's boot sweep may activate THIS grant before our own
          // claim() below runs; claim() is idempotent for the same user.
          const created = await auth.api.signUpEmail({
            body: { email: grant.email, password: body.password, name: body.name }
          });
          userId = created.user.id;
        } catch (e) {
          // Two concurrent claims of one invite can both pass the account
          // lookup above and race signUpEmail; the DB's unique email makes
          // exactly ONE account — map the loser to the same clean 409 the
          // account-exists branch answers instead of an uncaught 500.
          if (isDuplicateAccountError(e)) {
            return c.json(
              err('account_exists', 'An account with this email exists — sign in with it, then claim again'),
              409
            );
          }
          throw e;
        }
      }
    }

    const claimed = await collaborators.claim(grant.id, userId);
    if (!claimed) return c.json(err('already_claimed', 'This invite was already used'), 410);

    // The platform authenticates through workspace membership (live re-check
    // on every request), so a claimed collaborator becomes an ordinary
    // MEMBER of the deck's workspace when they are not one yet — stamped
    // origin='guest' (G2): an external party invited to ONE deck, not team.
    // Pure data in Phase 1 (no capability change); the discriminator is what
    // lets the cloud edition's hub re-assertion leave these rows alone and
    // Phase 6 scope guest powers. Rejoining after deactivation reactivates
    // and PRESERVES the row's origin — the invitation-accept semantics.
    const [membership] = await db
      .select({ id: workspaceMembers.id, isActive: workspaceMembers.isActive })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, grant.workspaceId), eq(workspaceMembers.userId, userId)))
      .limit(1);
    if (!membership) {
      await db.insert(workspaceMembers).values({
        workspaceId: grant.workspaceId,
        userId,
        role: 'member',
        origin: 'guest',
        invitedBy: grant.invitedBy
      });
      registry.events.emit('member.joined', { workspaceId: grant.workspaceId, userId, role: 'member' });
    } else if (!membership.isActive) {
      await db.update(workspaceMembers).set({ isActive: true }).where(eq(workspaceMembers.id, membership.id));
    }

    // Sweep sibling pending grants for the same email (idempotent against
    // the user.created hook's own sweep, which races this endpoint).
    await collaborators.claimAllPendingForEmail(grant.email, userId);

    // Email-verification honesty (ADR 009): only the emailed token proves
    // mailbox control; the copyable link fires the verification mail instead.
    if (viaEmailToken && !alreadyVerified) {
      await db.update(userTable).set({ emailVerified: true }).where(eq(userTable.id, userId));
    } else if (!viaEmailToken && !alreadyVerified && email.delivers) {
      try {
        await auth.api.sendVerificationEmail({ body: { email: grant.email, callbackURL: '/' } });
      } catch (e) {
        logger.error({ err: e }, 'post-claim verification email failed (grant unaffected)');
      }
    }

    // Public endpoint: no principal in context, write the audit row directly.
    await audit.write({
      workspaceId: grant.workspaceId,
      principal: null,
      action: 'collaborator.claim',
      resourceType: 'collaborator',
      resourceId: grant.id,
      requestId: c.get('requestId'),
      metadata: { presentationId: grant.presentationId, email: grant.email, userId, viaEmailToken }
    });

    return c.json({ collaborator: collaboratorToWire(claimed), workspaceId: grant.workspaceId, userId }, 200);
  });
}
