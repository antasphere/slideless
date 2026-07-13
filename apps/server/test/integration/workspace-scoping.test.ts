import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { and, eq } from 'drizzle-orm';
import { workspaceMembers } from '@slideless/db';
import {
  createDatabase,
  createTestApp,
  extractCookie,
  readJson,
  RecordingEmailDriver,
  startPostgres,
  type TestApp
} from './helpers.js';

/**
 * The workspace-scoped principal (ADR 014): one user in TWO workspaces, one
 * workspace per request. Covers the X-Workspace-Id session mechanism
 * (default, switch, fail-closed), /me's additive fields, cross-workspace
 * data/key/invitation isolation, the machine-credential mismatch guard, the
 * CLI-auth workspace binding, the multi-owned-workspace deletion guard, and
 * the admin cross-workspace delete refusal.
 */
const OWNER = {
  email: 'multi-owner@ws.test',
  name: 'Multi Owner',
  password: 'a-long-owner-password-123'
};
const BOB = { email: 'bob@ws.test', name: 'Bob Member', password: 'a-long-bob-password-1234' };

let container: StartedPostgreSqlContainer;
let app: TestApp;
let email: RecordingEmailDriver;
let ownerCookie: string;
let w1 = ''; // setup's workspace — the OLDEST membership, the default
let w2 = ''; // second workspace, created through the registry service

const WS_HEADER = 'x-workspace-id';

async function me(cookie: string, workspace?: string) {
  return app.app.request('/api/v1/me', {
    headers: { cookie, ...(workspace ? { [WS_HEADER]: workspace } : {}) }
  });
}

beforeAll(async () => {
  container = await startPostgres();
  const dbUrl = await createDatabase(container, 'ws_scoping');
  email = new RecordingEmailDriver();
  app = await createTestApp(dbUrl, {}, { email });

  const setup = await app.app.request('/api/v1/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instanceName: 'First Workspace', owner: OWNER })
  });
  expect(setup.status).toBe(201);
  w1 = (await readJson(setup)).workspaceId;

  const signIn = await app.app.request('/api/v1/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: OWNER.email, password: OWNER.password })
  });
  expect(signIn.status).toBe(200);
  ownerCookie = extractCookie(signIn);

  // The registry's WorkspaceService is the blessed later-workspace path.
  const meRes = await readJson(await me(ownerCookie));
  const created = await app.registry.workspaces.create('Second Workspace', meRes.user.id);
  w2 = created.workspaceId;

  // Bob: a single-membership member of W2 only.
  const bob = await app.auth.api.signUpEmail({
    body: { email: BOB.email, password: BOB.password, name: BOB.name }
  });
  await app.db.db.insert(workspaceMembers).values({ workspaceId: w2, userId: bob.user.id, role: 'member' });
}, 240_000);

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

describe('session resolution (X-Workspace-Id)', () => {
  it('defaults to the OLDEST active membership and lists all workspaces', async () => {
    const res = await me(ownerCookie);
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.activeWorkspaceId).toBe(w1);
    expect(body.workspace.id).toBe(w1);
    expect(body.workspace.name).toBe('First Workspace');
    expect(body.workspaces.map((w: { id: string }) => w.id)).toEqual([w1, w2]);
    expect(body.workspaces[1]).toEqual({ id: w2, name: 'Second Workspace', role: 'owner', hubOrigin: false });
  });

  it('the header switches the active workspace', async () => {
    const body = await readJson(await me(ownerCookie, w2));
    expect(body.activeWorkspaceId).toBe(w2);
    expect(body.workspace.name).toBe('Second Workspace');
    expect(body.role).toBe('owner');
    // The list is header-independent — all memberships either way.
    expect(body.workspaces).toHaveLength(2);
  });

  it('fails closed on a workspace the user does not belong to (no oracle)', async () => {
    // Bob is NOT a member of W1 — same 401 as a workspace that does not exist.
    const bobSignIn = await app.app.request('/api/v1/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: BOB.email, password: BOB.password })
    });
    const bobCookie = extractCookie(bobSignIn);
    const foreign = await me(bobCookie, w1);
    expect(foreign.status).toBe(401);
    const phantom = await me(bobCookie, '00000000-0000-4000-8000-000000000000');
    expect(phantom.status).toBe(401);
    // Malformed header: clean 401, never a Postgres uuid-cast 500.
    const malformed = await me(bobCookie, 'not-a-uuid');
    expect(malformed.status).toBe(401);
    // Sanity: without the header Bob's sole membership resolves.
    const plain = await readJson(await me(bobCookie));
    expect(plain.activeWorkspaceId).toBe(w2);
    expect(plain.workspaces).toHaveLength(1);
  });
});

describe('data + invitation isolation across workspaces', () => {
  it('files are scoped to the active workspace', async () => {
    const up1 = await app.app.request('/api/v1/files?name=w1.txt', {
      method: 'POST',
      headers: { cookie: ownerCookie, 'content-type': 'text/plain' },
      body: 'first workspace bytes'
    });
    expect(up1.status).toBe(201);
    const up2 = await app.app.request('/api/v1/files?name=w2.txt', {
      method: 'POST',
      headers: { cookie: ownerCookie, 'content-type': 'text/plain', [WS_HEADER]: w2 },
      body: 'second workspace bytes'
    });
    expect(up2.status).toBe(201);

    const list1 = await readJson(
      await app.app.request('/api/v1/files', { headers: { cookie: ownerCookie } })
    );
    expect(list1.files.map((f: { originalName: string }) => f.originalName)).toEqual(['w1.txt']);
    const list2 = await readJson(
      await app.app.request('/api/v1/files', { headers: { cookie: ownerCookie, [WS_HEADER]: w2 } })
    );
    expect(list2.files.map((f: { originalName: string }) => f.originalName)).toEqual(['w2.txt']);

    // A W2 file id is NOT reachable in the W1 context (404, not leak).
    const w2FileId = list2.files[0].id;
    const cross = await app.app.request(`/api/v1/files/${w2FileId}`, {
      headers: { cookie: ownerCookie }
    });
    expect(cross.status).toBe(404);
  });

  it('invitations land in — and list under — the active workspace only', async () => {
    const create = await app.app.request('/api/v1/invitations', {
      method: 'POST',
      headers: { cookie: ownerCookie, 'content-type': 'application/json', [WS_HEADER]: w2 },
      body: JSON.stringify({ email: 'invitee-w2@ws.test', role: 'member' })
    });
    expect(create.status).toBe(201);

    const listW1 = await readJson(
      await app.app.request('/api/v1/invitations', { headers: { cookie: ownerCookie } })
    );
    expect(
      listW1.invitations.filter((i: { email: string }) => i.email === 'invitee-w2@ws.test')
    ).toHaveLength(0);
    const listW2 = await readJson(
      await app.app.request('/api/v1/invitations', {
        headers: { cookie: ownerCookie, [WS_HEADER]: w2 }
      })
    );
    expect(
      listW2.invitations.filter((i: { email: string }) => i.email === 'invitee-w2@ws.test')
    ).toHaveLength(1);
  });

  it('members lists follow the active workspace', async () => {
    const listW2 = await readJson(
      await app.app.request('/api/v1/members', { headers: { cookie: ownerCookie, [WS_HEADER]: w2 } })
    );
    const emails = listW2.members.map((m: { email: string }) => m.email);
    expect(emails).toContain(BOB.email);
    const listW1 = await readJson(
      await app.app.request('/api/v1/members', { headers: { cookie: ownerCookie } })
    );
    expect(listW1.members.map((m: { email: string }) => m.email)).not.toContain(BOB.email);
  });
});

describe('API keys bind the mint-time workspace', () => {
  let keyW1 = '';
  let keyW2 = '';

  it('mints into the ACTIVE workspace; lists are workspace-scoped', async () => {
    const mint1 = await app.app.request('/api/v1/api-keys', {
      method: 'POST',
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'k-w1', scopes: ['presentations:read'] })
    });
    expect(mint1.status).toBe(201);
    keyW1 = (await readJson(mint1)).key;

    const mint2 = await app.app.request('/api/v1/api-keys', {
      method: 'POST',
      headers: { cookie: ownerCookie, 'content-type': 'application/json', [WS_HEADER]: w2 },
      body: JSON.stringify({ name: 'k-w2', scopes: ['presentations:read', 'presentations:write'] })
    });
    expect(mint2.status).toBe(201);
    keyW2 = (await readJson(mint2)).key;

    const listW1 = await readJson(
      await app.app.request('/api/v1/api-keys', { headers: { cookie: ownerCookie } })
    );
    expect(listW1.apiKeys.map((k: { name: string }) => k.name)).toEqual(['k-w1']);
    const listW2 = await readJson(
      await app.app.request('/api/v1/api-keys', { headers: { cookie: ownerCookie, [WS_HEADER]: w2 } })
    );
    expect(listW2.apiKeys.map((k: { name: string }) => k.name)).toEqual(['k-w2']);
  });

  it('a key reads ONLY its workspace; /me shows only the bound workspace', async () => {
    const files1 = await readJson(
      await app.app.request('/api/v1/files', { headers: { authorization: `Bearer ${keyW1}` } })
    );
    expect(files1.files.map((f: { originalName: string }) => f.originalName)).toEqual(['w1.txt']);
    const files2 = await readJson(
      await app.app.request('/api/v1/files', { headers: { authorization: `Bearer ${keyW2}` } })
    );
    expect(files2.files.map((f: { originalName: string }) => f.originalName)).toEqual(['w2.txt']);

    const meKey = await readJson(
      await app.app.request('/api/v1/me', { headers: { authorization: `Bearer ${keyW2}` } })
    );
    expect(meKey.activeWorkspaceId).toBe(w2);
    // Even though the key's OWNER belongs to two workspaces, the credential
    // enumerates only the one it is bound to.
    expect(meKey.workspaces).toEqual([{ id: w2, name: 'Second Workspace', role: 'owner', hubOrigin: false }]);
  });

  it('a mismatching X-Workspace-Id on a machine credential is rejected loudly', async () => {
    const mismatch = await app.app.request('/api/v1/me', {
      headers: { authorization: `Bearer ${keyW1}`, [WS_HEADER]: w2 }
    });
    expect(mismatch.status).toBe(403);
    expect((await readJson(mismatch)).error.code).toBe('workspace_mismatch');
    // A MATCHING header is fine (idempotent restatement of the binding).
    const match = await app.app.request('/api/v1/me', {
      headers: { authorization: `Bearer ${keyW1}`, [WS_HEADER]: w1 }
    });
    expect(match.status).toBe(200);
  });
});

describe('CLI auth binds one workspace (ADR 011 + 012)', () => {
  async function completeCli(extra: Record<string, unknown> = {}) {
    email.sent.length = 0;
    const req = await app.app.request('/api/v1/cli/auth/request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: OWNER.email })
    });
    expect(req.status).toBe(200);
    const mail = [...email.sent].reverse().find((m) => m.to === OWNER.email);
    const otp = /^(\d{6}) /.exec(mail?.subject ?? '')?.[1];
    expect(otp, 'a 6-digit code in the OTP mail subject').toBeTruthy();
    return app.app.request('/api/v1/cli/auth/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: OWNER.email, otp, ...extra })
    });
  }

  it('defaults to the oldest active membership', async () => {
    const res = await completeCli();
    expect(res.status).toBe(201);
    expect((await readJson(res)).workspaceId).toBe(w1);
  });

  it('honors an explicit workspaceId the account belongs to', async () => {
    const res = await completeCli({ workspaceId: w2 });
    expect(res.status).toBe(201);
    const body = await readJson(res);
    expect(body.workspaceId).toBe(w2);
    // The minted key really is W2-scoped.
    const files = await readJson(
      await app.app.request('/api/v1/files', { headers: { authorization: `Bearer ${body.key}` } })
    );
    expect(files.files.map((f: { originalName: string }) => f.originalName)).toEqual(['w2.txt']);
  });

  it('rejects a workspace the account is not an active member of (uniform 403)', async () => {
    const res = await completeCli({ workspaceId: '00000000-0000-4000-8000-000000000000' });
    expect(res.status).toBe(403);
    expect((await readJson(res)).error.code).toBe('no_membership');
  });
});

describe('admin delete stays inside the workspace', () => {
  it('refuses to delete an account that belongs to other workspaces', async () => {
    // Bob joins W1 too — the admin surface must now refuse account deletion.
    const [bobRow] = await app.db.db
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, w2), eq(workspaceMembers.role, 'member')));
    await app.db.db
      .insert(workspaceMembers)
      .values({ workspaceId: w1, userId: bobRow!.userId, role: 'member' });

    const members = await readJson(
      await app.app.request('/api/v1/members', { headers: { cookie: ownerCookie } })
    );
    const bobMember = members.members.find((m: { email: string }) => m.email === BOB.email);
    expect(bobMember).toBeTruthy();

    const del = await app.app.request(`/api/v1/members/${bobMember.id}`, {
      method: 'DELETE',
      headers: { cookie: ownerCookie }
    });
    expect(del.status).toBe(409);
    expect((await readJson(del)).error.code).toBe('member_of_other_workspaces');

    // Deactivation is the in-workspace tool and still works.
    const patch = await app.app.request(`/api/v1/members/${bobMember.id}`, {
      method: 'PATCH',
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ isActive: false })
    });
    expect(patch.status).toBe(200);
    // Bob's W2 standing is untouched.
    const [w2Row] = await app.db.db
      .select({ isActive: workspaceMembers.isActive })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, w2), eq(workspaceMembers.userId, bobRow!.userId)));
    expect(w2Row!.isActive).toBe(true);
  });
});

describe('self-service deletion guards EVERY owned workspace', () => {
  const CARL = { email: 'carl@ws.test', name: 'Carl Owner', password: 'a-long-carl-password-123' };
  const DAVE = { email: 'dave@ws.test', name: 'Dave Owner', password: 'a-long-dave-password-123' };
  let carlCookie = '';
  let carlId = '';
  let daveId = '';
  let w3 = '';
  let w4 = '';

  beforeAll(async () => {
    const carl = await app.auth.api.signUpEmail({
      body: { email: CARL.email, password: CARL.password, name: CARL.name }
    });
    carlId = carl.user.id;
    const dave = await app.auth.api.signUpEmail({
      body: { email: DAVE.email, password: DAVE.password, name: DAVE.name }
    });
    daveId = dave.user.id;
    w3 = (await app.registry.workspaces.create('Carl W3', carlId)).workspaceId;
    w4 = (await app.registry.workspaces.create('Carl W4', carlId)).workspaceId;
    const signIn = await app.app.request('/api/v1/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: CARL.email, password: CARL.password })
    });
    carlCookie = extractCookie(signIn);
  });

  async function deleteCarl() {
    return app.app.request('/api/v1/auth/delete-user', {
      method: 'POST',
      headers: { cookie: carlCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ password: CARL.password })
    });
  }

  it('rejects while the user is the sole owner of ANY workspace', async () => {
    expect((await deleteCarl()).status).toBe(400);

    // A co-owner in ONE of the two owned workspaces is not enough.
    await app.db.db.insert(workspaceMembers).values({ workspaceId: w3, userId: daveId, role: 'owner' });
    expect((await deleteCarl()).status).toBe(400);
  });

  it('succeeds once every owned workspace keeps another owner; audits per workspace', async () => {
    await app.db.db.insert(workspaceMembers).values({ workspaceId: w4, userId: daveId, role: 'owner' });
    const res = await deleteCarl();
    expect(res.status).toBe(200);

    const rows = await app.db.pool.query(
      `SELECT workspace_id FROM audit_log
       WHERE action = 'user.account_delete' AND resource_id = $1
       ORDER BY workspace_id`,
      [carlId]
    );
    expect(rows.rows.map((r) => r.workspace_id).sort()).toEqual([w3, w4].sort());
  });
});
