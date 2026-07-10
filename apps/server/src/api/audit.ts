import type { OpenAPIHono } from '@hono/zod-openapi';
import { and, eq, lt, desc } from 'drizzle-orm';
import { auditListRoute } from '@platform/contract/routes';
import { auditLog, user as userTable, type Db } from '@platform/db';
import { requireRole } from '../middleware/auth-context.js';

export function registerAuditRoutes(api: OpenAPIHono, db: Db): void {
  api.use('/audit', requireRole('admin'));
  api.openapi(auditListRoute, async (c) => {
    const principal = c.get('principal')!;
    const { cursor, limit } = c.req.valid('query');

    // Malformed cursors are ignored (page 1), and so are out-of-range ones:
    // Number('99999999999999999999') is finite but past bigint precision, and
    // sending it to the `lt(id, …)` comparison overflows in Postgres → 500.
    // Safe-integer is the honest bound for a JS-roundtripped bigserial id.
    const parsed = cursor ? Number(cursor) : null;
    const cursorId = parsed !== null && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
    const rows = await db
      .select({
        id: auditLog.id,
        actorUserId: auditLog.actorUserId,
        actorEmail: userTable.email,
        actorVia: auditLog.actorVia,
        apiKeyId: auditLog.apiKeyId,
        action: auditLog.action,
        resourceType: auditLog.resourceType,
        resourceId: auditLog.resourceId,
        requestId: auditLog.requestId,
        ip: auditLog.ip,
        metadata: auditLog.metadata,
        createdAt: auditLog.createdAt
      })
      .from(auditLog)
      .leftJoin(userTable, eq(auditLog.actorUserId, userTable.id))
      .where(
        cursorId !== null
          ? and(eq(auditLog.workspaceId, principal.workspaceId), lt(auditLog.id, cursorId))
          : eq(auditLog.workspaceId, principal.workspaceId)
      )
      .orderBy(desc(auditLog.id))
      .limit(limit + 1);

    const page = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? String(page[page.length - 1]?.id ?? '') : null;
    return c.json(
      {
        entries: page.map((r) => ({
          id: r.id,
          actorUserId: r.actorUserId,
          actorEmail: r.actorEmail,
          actorVia: r.actorVia,
          apiKeyId: r.apiKeyId,
          action: r.action,
          resourceType: r.resourceType,
          resourceId: r.resourceId,
          requestId: r.requestId,
          ip: r.ip,
          metadata: r.metadata,
          createdAt: r.createdAt.toISOString()
        })),
        nextCursor
      },
      200
    );
  });
}
