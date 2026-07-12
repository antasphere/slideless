import { workspaceMembers, workspaces, type DbConn } from '@slideless/db';

/**
 * Workspace lifecycle — the template's one creation path (ADR 014). Setup
 * creates the FIRST workspace through it; products that open their own
 * workspace-creation flow (a hub's sign-up, a cloud edition's lazy org
 * projection) call it via the platform registry instead of hand-rolling
 * the two inserts. The template deliberately exposes NO HTTP endpoint for
 * this: workspace creation is a product decision, and the fail-closed
 * posture (nothing new is reachable until consciously opened) applies to
 * workspaces like everything else.
 */
export class WorkspaceService {
  constructor(private readonly db: DbConn) {}

  /**
   * Create a workspace with `ownerUserId` as its ACTIVE OWNER — one unit:
   * pass a transaction handle (`conn`) to join an enclosing transaction
   * (setup does), or omit it to run the two inserts on this service's
   * connection inside their own transaction when it supports one.
   */
  async create(
    name: string,
    ownerUserId: string,
    conn: DbConn = this.db
  ): Promise<{ workspaceId: string }> {
    const run = async (tx: DbConn) => {
      const [workspace] = await tx.insert(workspaces).values({ name }).returning({ id: workspaces.id });
      if (!workspace) throw new Error('workspace insert returned no row');
      await tx.insert(workspaceMembers).values({
        workspaceId: workspace.id,
        userId: ownerUserId,
        role: 'owner'
      });
      return { workspaceId: workspace.id };
    };
    // A DbConn may already BE a transaction (no .transaction on the type);
    // when the caller hands us a plain Db, wrap the pair so a workspace can
    // never exist without its owner membership.
    if ('transaction' in conn && typeof conn.transaction === 'function') {
      return conn.transaction(async (tx) => run(tx));
    }
    return run(conn);
  }
}
