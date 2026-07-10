import type { OpenAPIHono } from '@hono/zod-openapi';
import { and, desc, eq } from 'drizzle-orm';
import { apiKeyCreateRoute, apiKeyRevokeRoute, apiKeysListRoute } from '@slideless/contract/routes';
import { apiKeys, type ApiKey, type Db } from '@slideless/db';
import { sql } from 'drizzle-orm';
import type { ApiKeyService } from '../apikeys/service.js';
import { cursorRowId, keysetBefore, pageOf } from '../pagination.js';
import { requireAuth } from '../middleware/auth-context.js';

const err = (code: string, message: string) => ({ error: { code, message } });

const toWire = (k: ApiKey) => ({
  id: k.id,
  name: k.name,
  keyId: k.keyId,
  scopes: k.scopes as Array<'presentations:read' | 'presentations:write' | 'data:export'>,
  createdBy: k.createdBy,
  createdAt: k.createdAt.toISOString(),
  lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
  revokedAt: k.revokedAt?.toISOString() ?? null,
  expiresAt: k.expiresAt?.toISOString() ?? null
});

export function registerApiKeyRoutes(api: OpenAPIHono, db: Db, service: ApiKeyService): void {
  api.use('/api-keys', requireAuth());
  api.use('/api-keys/*', requireAuth());

  api.openapi(apiKeysListRoute, async (c) => {
    const principal = c.get('principal')!;
    const { cursor, limit } = c.req.valid('query');
    const mine = principal.role === 'member';
    const cursorId = cursorRowId(cursor);
    // The member sees-own-keys filter lives inside the same and(...) as the
    // keyset predicate so the scoping holds on every page, not just the first.
    const rows = await db
      .select()
      .from(apiKeys)
      .where(
        and(
          eq(apiKeys.workspaceId, principal.workspaceId),
          ...(mine ? [eq(apiKeys.createdBy, principal.userId)] : []),
          ...(cursorId
            ? [
                keysetBefore({
                  table: apiKeys,
                  id: apiKeys.id,
                  createdAt: apiKeys.createdAt,
                  workspaceId: apiKeys.workspaceId,
                  cursorId,
                  workspace: principal.workspaceId
                })
              ]
            : [])
        )
      )
      .orderBy(desc(apiKeys.createdAt), desc(apiKeys.id))
      .limit(limit + 1);
    const { page, nextCursor } = pageOf(rows, limit);
    return c.json({ apiKeys: page.map(toWire), nextCursor }, 200);
  });

  api.openapi(apiKeyCreateRoute, async (c) => {
    const principal = c.get('principal')!;
    // Locked rule: a key never mints a key. Sessions only.
    if (principal.via !== 'session') {
      return c.json(err('sessions_only', 'API keys can only be created from a browser session'), 403);
    }
    const body = c.req.valid('json');
    // The client sends a TTL in days; the server owns the absolute expiry.
    const expiresAt = body.expiresInDays ? new Date(Date.now() + body.expiresInDays * 86_400_000) : null;
    const minted = await service.mint({
      workspaceId: principal.workspaceId,
      createdBy: principal.userId,
      name: body.name,
      scopes: body.scopes,
      expiresAt
    });
    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, minted.id)).limit(1);
    c.set('audit', {
      action: 'apikey.create',
      resourceType: 'api_key',
      resourceId: minted.id,
      metadata: { name: body.name, scopes: body.scopes, expiresAt: expiresAt?.toISOString() ?? null }
    });
    return c.json({ apiKey: toWire(row!), key: minted.key }, 201);
  });

  api.openapi(apiKeyRevokeRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id } = c.req.valid('param');
    const [key] = await db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.id, id), eq(apiKeys.workspaceId, principal.workspaceId)))
      .limit(1);
    if (!key) return c.json(err('not_found', 'API key not found'), 404);
    const isOwn = key.createdBy === principal.userId;
    if (!isOwn && principal.role === 'member') {
      return c.json(err('forbidden', 'Only the key creator or an admin can revoke it'), 403);
    }
    if (!key.revokedAt) {
      await db
        .update(apiKeys)
        .set({ revokedAt: sql`now()` })
        .where(eq(apiKeys.id, key.id));
    }
    const [updated] = await db.select().from(apiKeys).where(eq(apiKeys.id, key.id)).limit(1);
    c.set('audit', { action: 'apikey.revoke', resourceType: 'api_key', resourceId: key.id });
    return c.json(toWire(updated!), 200);
  });
}
