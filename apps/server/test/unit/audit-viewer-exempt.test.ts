import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { auditMiddleware, type AuditService, type AuditWrite } from '../../src/audit/service.js';
import type { Principal } from '@antasphere/chassis-contract';

/**
 * PRIV-1, the audit-table corner: the share-token viewer API carries the
 * LIVE SECRET in the path (`/api/v1/viewer/:secret/…`), and the audit
 * middleware's fallback action is `method + c.req.path`. The surface is
 * documented as unaudited ("token recipients are not principals",
 * viewer/annotations-api.ts) — but the middleware only skipped when NO
 * principal resolved, so a share-link recipient who also holds a session
 * cookie landed an audit row embedding the working share capability (and,
 * on a failed audit insert, the same string in the error log line). The
 * exemption in isAuditExempt is what this pins.
 */

const SECRET = 'Zq7-LIVE-SHARE-SECRET-abc123';

function appWithAudit(principal: Partial<Principal>) {
  const writes: AuditWrite[] = [];
  const audit = {
    write: async (entry: AuditWrite) => {
      writes.push(entry);
    }
  } as unknown as AuditService;

  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('principal', principal as Principal);
    await next();
  });
  app.use(
    '*',
    auditMiddleware(audit, () => '127.0.0.1')
  );
  app.post('/api/v1/viewer/:secret/annotations', (c) => c.json({ ok: true }, 201));
  app.put('/api/v1/viewer/:secret/badge', (c) => c.json({ ok: true }));
  app.post('/api/v1/viewer/:secret/forms/:form/responses', (c) => c.json({ ok: true }, 201));
  app.post('/api/v1/presentations/:id/publish', (c) => c.json({ ok: true }));
  return { app, writes };
}

const sessionPrincipal: Partial<Principal> = {
  userId: 'user-1',
  workspaceId: 'ws-1',
  via: 'session'
};

describe('audit middleware and the share-token viewer surface', () => {
  it('writes no audit row for a viewer mutation, even with a session principal', async () => {
    const { app, writes } = appWithAudit(sessionPrincipal);
    await app.request(`/api/v1/viewer/${SECRET}/annotations`, { method: 'POST' });
    await app.request(`/api/v1/viewer/${SECRET}/badge`, { method: 'PUT' });
    await app.request(`/api/v1/viewer/${SECRET}/forms/nps/responses`, { method: 'POST' });
    expect(writes).toHaveLength(0);
  });

  it('never lets the share secret reach an audit entry', async () => {
    const { app, writes } = appWithAudit(sessionPrincipal);
    await app.request(`/api/v1/viewer/${SECRET}/annotations`, { method: 'POST' });
    expect(JSON.stringify(writes)).not.toContain(SECRET);
  });

  it('still audits non-viewer mutations through the fallback action', async () => {
    const { app, writes } = appWithAudit(sessionPrincipal);
    await app.request('/api/v1/presentations/deck-1/publish', { method: 'POST' });
    expect(writes).toHaveLength(1);
    expect(writes[0]?.action).toBe('post /api/v1/presentations/deck-1/publish');
  });
});
