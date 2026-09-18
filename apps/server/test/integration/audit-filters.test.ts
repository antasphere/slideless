import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  createDatabase,
  createTestApp,
  extractCookie,
  readJson,
  startPostgres,
  type TestApp
} from './helpers.js';

/**
 * The audit list's filters, end to end: each query parameter narrows the
 * admin's own workspace, the total counts the filtered set on the first
 * page only, the cursor keeps the filters across pages, and a malformed
 * filter is a 400, never a 500.
 */

const OWNER = { email: 'owner@auditfilters.test', name: 'Audit Owner', password: 'audit-owner-pass-123' };

let container: StartedPostgreSqlContainer;
let app: TestApp;
let ownerCookie: string;
let ownerUserId: string;
let apiKey: string;

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body)
});

async function audit(query: Record<string, string> = {}) {
  const qs = new URLSearchParams(query).toString();
  const res = await app.app.request(`/api/v1/audit${qs ? `?${qs}` : ''}`, {
    headers: { cookie: ownerCookie }
  });
  return { status: res.status, body: await readJson(res) };
}

beforeAll(async () => {
  container = await startPostgres();
  app = await createTestApp(await createDatabase(container, 'auditfilters'));
  const setup = await app.app.request(
    '/api/v1/setup',
    json({ setupToken: 'integration-test-setup-token', instanceName: 'Audit filters', owner: OWNER })
  );
  expect(setup.status).toBe(201);
  const signIn = await app.app.request(
    '/api/v1/auth/sign-in/email',
    json({ email: OWNER.email, password: OWNER.password })
  );
  ownerCookie = extractCookie(signIn);
  const me = await readJson(await app.app.request('/api/v1/me', { headers: { cookie: ownerCookie } }));
  ownerUserId = me.user.id;

  // A few rows of different shapes: a session mint, a machine read, and a
  // couple of deck actions, so every filter has something to keep and
  // something to drop.
  const mint = await app.app.request('/api/v1/api-keys', {
    ...json({ name: 'filters', scopes: ['presentations:read', 'presentations:write'] }),
    headers: { 'content-type': 'application/json', cookie: ownerCookie }
  });
  expect(mint.status).toBe(201);
  apiKey = (await readJson(mint)).key;
  const machineRead = await app.app.request('/api/v1/me', { headers: { authorization: `Bearer ${apiKey}` } });
  expect(machineRead.status).toBe(200);
  // Two reserved upload sessions: two `presentation.upload_session_create`
  // rows on two different deck ids, without a byte uploaded.
  for (let i = 0; i < 2; i++) {
    const reserved = await app.app.request('/api/v1/presentations/uploads', {
      method: 'POST',
      headers: { cookie: ownerCookie }
    });
    expect(reserved.status).toBe(201);
  }
}, 240_000);

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

describe('GET /api/v1/audit with filters', () => {
  it('lists everything with a total when nothing filters', async () => {
    const { status, body } = await audit();
    expect(status).toBe(200);
    expect(body.total).toBe(body.entries.length);
    expect(body.entries.map((e: { action: string }) => e.action)).toEqual(
      expect.arrayContaining(['apikey.create', 'presentation.upload_session_create'])
    );
  });

  it('keeps a family by prefix and one action exactly', async () => {
    const family = await audit({ action: 'presentation.' });
    expect(family.status).toBe(200);
    expect(family.body.entries.length).toBeGreaterThanOrEqual(2);
    for (const e of family.body.entries) expect(e.action.startsWith('presentation.')).toBe(true);
    expect(family.body.total).toBe(family.body.entries.length);

    const exact = await audit({ action: 'apikey.create' });
    expect(exact.body.entries).toHaveLength(1);
    expect(exact.body.entries[0].action).toBe('apikey.create');

    const both = await audit({ action: 'presentation.,apikey.create' });
    expect(both.body.total).toBe(family.body.total + 1);
  });

  it('narrows by how the actor authenticated', async () => {
    const machine = await audit({ actorVia: 'api_key' });
    expect(machine.body.entries.length).toBeGreaterThanOrEqual(1);
    for (const e of machine.body.entries) expect(e.actorVia).toBe('api_key');

    const humans = await audit({ actorVia: 'session,oauth' });
    for (const e of humans.body.entries) expect(['session', 'oauth']).toContain(e.actorVia);

    // the genesis `instance.setup` row is the one signed by nobody
    const system = await audit({ actorVia: 'system' });
    expect(system.body.entries.map((e: { action: string }) => e.action)).toEqual(['instance.setup']);
    expect(humans.body.total + machine.body.total + system.body.total).toBe((await audit()).body.total);
  });

  it('narrows by actor: a user id, or `system` for the unsigned rows', async () => {
    const mine = await audit({ actor: ownerUserId });
    expect(mine.body.entries.length).toBeGreaterThan(0);
    for (const e of mine.body.entries) expect(e.actorUserId).toBe(ownerUserId);

    const nobody = await audit({ actor: 'no-such-user' });
    expect(nobody.body.entries).toEqual([]);
    expect(nobody.body.total).toBe(0);

    const system = await audit({ actor: 'system' });
    expect(system.body.entries.map((e: { action: string }) => e.action)).toEqual(['instance.setup']);
    for (const e of system.body.entries) expect(e.actorUserId).toBeNull();
    expect(mine.body.total + system.body.total).toBe((await audit()).body.total);
  });

  it('matches free text against the actor email and the action, wildcards escaped', async () => {
    const byEmail = await audit({ q: 'OWNER@auditfilters' });
    expect(byEmail.body.entries.length).toBeGreaterThan(0);
    for (const e of byEmail.body.entries) expect(e.actorEmail).toBe(OWNER.email);

    const byAction = await audit({ q: 'apikey' });
    expect(byAction.body.entries.map((e: { action: string }) => e.action)).toEqual(['apikey.create']);

    // `%` alone would match every row if it reached LIKE unescaped
    const literalPercent = await audit({ q: '%' });
    expect(literalPercent.body.entries).toEqual([]);
  });

  it('narrows by resource type and id', async () => {
    const decks = await audit({ resourceType: 'upload_session' });
    expect(decks.body.entries.length).toBe(2);
    const one = decks.body.entries[0];
    const byId = await audit({ resourceType: 'upload_session', resourceId: one.resourceId });
    expect(byId.body.entries.every((e: { resourceId: string }) => e.resourceId === one.resourceId)).toBe(
      true
    );
    expect(byId.body.entries).toHaveLength(1);
    expect((await audit({ resourceId: 'no-such-resource' })).body.total).toBe(0);
  });

  it('narrows by time window', async () => {
    const all = await audit();
    const newest = all.body.entries[0].createdAt;
    const oldest = all.body.entries[all.body.entries.length - 1].createdAt;

    const nothingYet = await audit({ to: new Date(new Date(oldest).getTime() - 60_000).toISOString() });
    expect(nothingYet.body.entries).toEqual([]);
    expect(nothingYet.body.total).toBe(0);

    // the wire carries milliseconds, the column microseconds: the upper bound
    // is a second past the newest row so its own instant is inside
    const window = await audit({
      from: oldest,
      to: new Date(new Date(newest).getTime() + 1_000).toISOString()
    });
    expect(window.body.total).toBe(all.body.total);
    const later = await audit({ from: new Date(new Date(oldest).getTime() + 1).toISOString() });
    expect(later.body.total).toBe(all.body.total - 1);

    const future = await audit({ from: new Date(Date.now() + 3_600_000).toISOString() });
    expect(future.body.entries).toEqual([]);
  });

  it('keeps the filters across pages: the cursor walks the filtered set only', async () => {
    const first = await audit({ actorVia: 'session', limit: '2' });
    expect(first.status).toBe(200);
    expect(first.body.entries).toHaveLength(2);
    expect(first.body.nextCursor).not.toBeNull();
    expect(first.body.total).toBeGreaterThan(2);

    const seen = new Set<number>(first.body.entries.map((e: { id: number }) => e.id));
    let cursor: string | null = first.body.nextCursor;
    let pages = 1;
    while (cursor) {
      const next = await audit({ actorVia: 'session', limit: '2', cursor });
      expect(next.status).toBe(200);
      // the total is the first page's figure only
      expect(next.body.total).toBeNull();
      for (const e of next.body.entries) {
        expect(e.actorVia).toBe('session');
        expect(seen.has(e.id)).toBe(false);
        seen.add(e.id);
      }
      cursor = next.body.nextCursor;
      pages++;
    }
    expect(seen.size).toBe(first.body.total);
    expect(pages).toBeGreaterThan(1);
  });

  it('refuses a malformed filter with a 400, never a 500', async () => {
    for (const bad of [
      { actorVia: 'browser' },
      { from: 'yesterday' },
      { q: 'a b' },
      { action: "presentation.'; drop table audit_log; --" }
    ]) {
      const { status, body } = await audit(bad);
      expect(status).toBe(400);
      expect(body.error.code).toBe('validation_error');
    }
  });

  it('stays an admin surface: the filters do not open the route to a machine principal', async () => {
    const res = await app.app.request('/api/v1/audit?actorVia=api_key', {
      headers: { authorization: `Bearer ${apiKey}` }
    });
    expect(res.status).toBe(403);
  });
});
