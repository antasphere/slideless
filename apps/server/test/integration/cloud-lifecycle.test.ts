import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  createDatabase,
  createTestApp,
  extractCookie,
  readJson,
  startPostgres,
  SETUP_TOKEN,
  type TestApp
} from './helpers.js';
import { seedLocalWorkspace } from './sso-helpers.js';

/**
 * PRDCT-1356 — cloud lifecycle & recovery, the server-side members:
 *
 *  - CLOUD-1 / AUTH-13: POST /auth/unlink-account for the `antasphere`
 *    provider answers 403 on cloud (the /auth mount never saw the principal
 *    gate; unlinking left hub-origin memberships behind a permanent
 *    fail-open `no_link` reconcile);
 *  - EDIT-2: /sign-in/email on cloud is the OPERATOR's + allowlist's door
 *    only — every other local credential is refused with one 403 (no
 *    account oracle);
 *  - CLOUD-5: the invitation-accept account-creation branch is closed on
 *    cloud (409 sso_required), the same stance as the collaborator claim;
 *  - EDIT-1/3/4: the oss→cloud flip is REFUSED while an unprojected
 *    workspace or an unverified user exists, and the reverse flip is
 *    refused outright.
 */

const OWNER = { email: 'operator@lifecycle.test', name: 'Operator', password: 'operator-password-123' };
const HUB_ENV = {
  EDITION: 'cloud',
  HUB_ISSUER_URL: 'http://hub.localhost:3300',
  HUB_CLIENT_ID: 'tool-slideless-cloud',
  HUB_CLIENT_SECRET: 'integration-test-hub-secret-0001'
};

let ipCounter = 0;
const nextIp = () => `198.51.100.${++ipCounter % 250}`;
const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp(), ...headers },
  body: JSON.stringify(body)
});

let container: StartedPostgreSqlContainer;

beforeAll(async () => {
  container = await startPostgres();
}, 180_000);

afterAll(async () => {
  await container?.stop();
});

describe("cloud edition: the local doors are the operator's only", () => {
  let app: TestApp;
  let operatorCookie: string;

  beforeAll(async () => {
    app = await createTestApp(await createDatabase(container, 'lifecycle_cloud'), HUB_ENV);
    const setup = await app.app.request(
      '/api/v1/setup',
      json({ setupToken: SETUP_TOKEN, instanceName: 'LC', owner: OWNER })
    );
    expect(setup.status).toBe(201);
    const signIn = await app.app.request(
      '/api/v1/auth/sign-in/email',
      json({ email: OWNER.email, password: OWNER.password })
    );
    expect(signIn.status).toBe(200);
    operatorCookie = extractCookie(signIn);
  });

  afterAll(async () => {
    await app.stop();
  });

  it('setup recorded the operator durably on the instance row (CLOUD-3)', async () => {
    const { rows } = await app.db.pool.query<{ operator_user_id: string | null; email: string }>(
      `SELECT s.operator_user_id, u.email FROM instance_settings s JOIN "user" u ON u.id = s.operator_user_id`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.email).toBe(OWNER.email);
  });

  it('refuses to unlink the antasphere provider (403 hub_unlink_forbidden), even for a signed-in caller', async () => {
    const res = await app.app.request(
      '/api/v1/auth/unlink-account',
      json({ providerId: 'antasphere' }, { cookie: operatorCookie })
    );
    expect(res.status).toBe(403);
    const body = await readJson(res);
    expect(JSON.stringify(body)).toContain('hub_unlink_forbidden');
  });

  it('a non-operator, non-allowlisted email is refused at the password door (403 local_signin_disabled)', async () => {
    const res = await app.app.request(
      '/api/v1/auth/sign-in/email',
      json({ email: 'someone@lifecycle.test', password: 'whatever-password-123' })
    );
    expect(res.status).toBe(403);
    expect(JSON.stringify(await readJson(res))).toContain('local_signin_disabled');
  });

  it('the operator keeps the door (the break-glass identity)', async () => {
    const res = await app.app.request(
      '/api/v1/auth/sign-in/email',
      json({ email: OWNER.email.toUpperCase(), password: OWNER.password })
    );
    expect(res.status).toBe(200);
  });

  it('invitation accept on a cloud-LOCAL workspace never mints a local-password account (409 sso_required)', async () => {
    const wsId = await seedLocalWorkspace(app, 'Local Host', OWNER.email);
    const inv = await app.app.request(
      '/api/v1/invitations',
      json(
        { email: 'invitee@lifecycle.test', role: 'member' },
        { cookie: operatorCookie, 'x-workspace-id': wsId }
      )
    );
    expect(inv.status).toBe(201);
    const token = ((await readJson(inv)).acceptUrl as string).split('/invite/')[1]!;
    const accepted = await app.app.request(
      '/api/v1/invitations/accept',
      json({ token, name: 'Invitee', password: 'invitee-password-123' })
    );
    expect(accepted.status).toBe(409);
    expect((await readJson(accepted)).error.code).toBe('sso_required');
    const users = await app.db.pool.query(`SELECT 1 FROM "user" WHERE email = 'invitee@lifecycle.test'`);
    expect(users.rows).toHaveLength(0);
  });
});

describe('the edition flip pre-flights (EDIT-1/3) and the reverse flip is refused (EDIT-4)', () => {
  let connectionString: string;

  beforeAll(async () => {
    connectionString = await createDatabase(container, 'lifecycle_flip');
    const app = await createTestApp(connectionString);
    const res = await app.app.request(
      '/api/v1/setup',
      json({ setupToken: SETUP_TOKEN, instanceName: 'Flip', owner: OWNER })
    );
    expect(res.status).toBe(201);
    await app.stop();
  });

  it('oss→cloud with the flag is REFUSED while a workspace has no hub projection', async () => {
    await expect(
      createTestApp(connectionString, { ...HUB_ENV, EDITION_CHANGE_ALLOWED: 'true' })
    ).rejects.toThrow(/refusing the edition flip 'oss' → 'cloud'.*no hub projection/);
    // Nothing moved: the stamp is still oss and a plain oss boot still works.
    const still = await createTestApp(connectionString);
    const { rows } = await still.db.pool.query<{ edition: string }>(`SELECT edition FROM instance_settings`);
    expect(rows).toEqual([{ edition: 'oss' }]);
    await still.stop();
  });

  it('…and while a user has an unverified email', async () => {
    const app = await createTestApp(connectionString);
    // Project the workspace (what the hub onboarding would do) so only the
    // unverified user stands in the way.
    await app.db.pool.query(
      `UPDATE workspaces SET central_account_id = '44444444-aaaa-4bbb-8ccc-000000000001'`
    );
    await app.db.pool.query(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
       VALUES ('u-unverified', 'Unverified', 'unverified@lifecycle.test', false, now(), now())`
    );
    await app.stop();
    await expect(
      createTestApp(connectionString, { ...HUB_ENV, EDITION_CHANGE_ALLOWED: 'true' })
    ).rejects.toThrow(/refusing the edition flip 'oss' → 'cloud'.*unverified email/);
  });

  it('flips once the instance is in shape, then refuses the reverse flip even with the flag', async () => {
    const app = await createTestApp(connectionString);
    await app.db.pool.query(`DELETE FROM "user" WHERE id = 'u-unverified'`);
    await app.stop();
    const flipped = await createTestApp(connectionString, { ...HUB_ENV, EDITION_CHANGE_ALLOWED: 'true' });
    const { rows } = await flipped.db.pool.query<{ edition: string }>(
      `SELECT edition FROM instance_settings`
    );
    expect(rows).toEqual([{ edition: 'cloud' }]);
    await flipped.stop();
    await expect(createTestApp(connectionString, { EDITION_CHANGE_ALLOWED: 'true' })).rejects.toThrow(
      /refusing the edition flip 'cloud' → 'oss'/
    );
    // …and still stamped cloud.
    const cloud = await createTestApp(connectionString, HUB_ENV);
    const after = await cloud.db.pool.query<{ edition: string }>(`SELECT edition FROM instance_settings`);
    expect(after.rows).toEqual([{ edition: 'cloud' }]);
    await cloud.stop();
  });
});
