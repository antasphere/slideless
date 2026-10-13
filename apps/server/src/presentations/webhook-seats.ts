import { eq, sql } from 'drizzle-orm';
import { webhookEndpoints, type Db } from '@antasphere/chassis-db';
import type { EntitlementRequest } from '@antasphere/chassis-contract';

/**
 * The count hook of the webhooks limit (PRDCT-3482): the workspace's
 * endpoints plus the one being registered, judged only for a caller the
 * handler would let act, an owner or an admin of the workspace; anyone else
 * reads the handler's own refusal (a guest its 403, a member its 403, a
 * key without the scope the gate's), never a plan refusal that says more.
 */
export function webhookEndpointsAfterCreate(db: Db): (ctx: EntitlementRequest) => Promise<number | null> {
  return async (ctx) => {
    const principal = ctx.principal;
    if (!principal || principal.origin === 'guest') return null;
    if (principal.role !== 'owner' && principal.role !== 'admin') return null;
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.workspaceId, principal.workspaceId));
    return Number(row?.n ?? 0) + 1;
  };
}
