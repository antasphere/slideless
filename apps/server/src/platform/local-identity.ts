import { eq, and } from 'drizzle-orm';
import { workspaceMembers, workspaces, type Db } from '@slideless/db';
import type { IdentityProvider, InstanceAuthDescriptor, Principal, RequestContext } from '@slideless/contract';
import type { Auth } from '../identity/better-auth.js';

/**
 * The template's default IdentityProvider: Better Auth sessions + a LIVE
 * workspace_members re-check on every request. The membership row — not the
 * cookie — is the authorization decision, so deactivating a member locks
 * them out instantly regardless of cookie age.
 *
 * API-key and OAuth-bearer resolution live in the auth-context middleware
 * (they are credential formats, not identity sources); this provider is the
 * seam the central account service replaces later.
 */
export class LocalIdentityProvider implements IdentityProvider {
  constructor(
    private readonly auth: Auth,
    private readonly db: Db,
    private readonly hasGoogle: boolean,
    private readonly hasOtp: boolean = false,
    private readonly hasPasswordReset: boolean = false,
    private readonly hasEmailChange: boolean = false
  ) {}

  async resolve(ctx: RequestContext): Promise<Principal | null> {
    const session = await this.auth.api.getSession({
      headers: ctx.headers as Headers
    });
    if (!session?.user) return null;

    const [row] = await this.db
      .select({
        memberRole: workspaceMembers.role,
        workspaceId: workspaceMembers.workspaceId,
        workspaceName: workspaces.name,
        accountRef: workspaces.centralAccountId
      })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
      .where(and(eq(workspaceMembers.userId, session.user.id), eq(workspaceMembers.isActive, true)))
      .limit(1);
    if (!row) return null;

    return {
      userId: session.user.id,
      email: session.user.email,
      name: session.user.name,
      workspaceId: row.workspaceId,
      role: row.memberRole,
      via: 'session',
      scopes: null,
      ...(row.accountRef ? { accountRef: row.accountRef } : {})
    };
  }

  describe(): InstanceAuthDescriptor {
    // 'oauth' is always on: every instance is an OAuth 2.1 AS for its /mcp (M6).
    const methods: InstanceAuthDescriptor['methods'] = ['password', 'api-key', 'oauth'];
    if (this.hasOtp) methods.push('email-otp');
    if (this.hasGoogle) methods.push('google');
    return {
      methods,
      passwordReset: this.hasPasswordReset,
      emailChange: this.hasEmailChange,
      // Opt-in TOTP needs no email driver — always available on the template.
      twoFactor: true
    };
  }
}
