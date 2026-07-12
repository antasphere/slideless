import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDatabase, createTestApp, readJson, startPostgres, type TestApp } from './helpers.js';

/**
 * The edition split, Phase 2 (docs/federation.md):
 *  - setup stamps the instance's edition; the R7 boot guard refuses an env
 *    EDITION that differs on an already-set-up instance, and
 *    EDITION_CHANGE_ALLOWED=true is the one-boot acknowledgement that
 *    re-stamps it;
 *  - a fresh database boots under any edition (cloud starts from a fresh DB);
 *  - EDITION=oss keeps today's behavior byte-identical — no hub config read.
 *
 * The SSO wiring itself is Phase 3; these tests pin the scaffolding only.
 */

const OWNER = { email: 'owner@edition.test', name: 'Ed Owner', password: 'ed-owner-password-123' };

/** The full hub block a cloud boot requires (dev-shaped values). */
const HUB_ENV = {
  EDITION: 'cloud',
  HUB_ISSUER_URL: 'http://hub.localhost:3300',
  HUB_CLIENT_ID: 'tool-slideless-cloud',
  HUB_CLIENT_SECRET: 'integration-test-hub-secret-0001',
  HUB_SERVICE_KEY: 'ant_integration_test_key'
};

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body)
});

let container: StartedPostgreSqlContainer;

beforeAll(async () => {
  container = await startPostgres();
});

afterAll(async () => {
  await container?.stop();
});

describe('R7 edition-flip boot guard', () => {
  let connectionString: string;

  beforeAll(async () => {
    connectionString = await createDatabase(container, 'edition_guard');
    const app = await createTestApp(connectionString);
    const res = await app.app.request('/api/v1/setup', json({ instanceName: 'Ed', owner: OWNER }));
    expect(res.status).toBe(201);
    await app.stop();
  });

  it('setup stamped the instance as oss (the test boot default)', async () => {
    const app = await createTestApp(connectionString);
    const { rows } = await app.db.pool.query<{ edition: string }>(`SELECT edition FROM instance_settings`);
    expect(rows).toEqual([{ edition: 'oss' }]);
    await app.stop();
  });

  it('refuses to boot EDITION=cloud on the populated oss instance', async () => {
    await expect(createTestApp(connectionString, HUB_ENV)).rejects.toThrow(
      /refusing to boot: EDITION=cloud but this instance was set up as 'oss'/
    );
  });

  it('EDITION_CHANGE_ALLOWED=true re-stamps and boots; the flip then holds without the flag', async () => {
    const flipped = await createTestApp(connectionString, { ...HUB_ENV, EDITION_CHANGE_ALLOWED: 'true' });
    const { rows } = await flipped.db.pool.query<{ edition: string }>(
      `SELECT edition FROM instance_settings`
    );
    expect(rows).toEqual([{ edition: 'cloud' }]);
    await flipped.stop();

    // The stamp moved: a plain cloud boot now succeeds, and an oss boot is
    // now the refused flip (the guard is symmetric).
    const cloudAgain = await createTestApp(connectionString, HUB_ENV);
    await cloudAgain.stop();
    await expect(createTestApp(connectionString)).rejects.toThrow(
      /refusing to boot: EDITION=oss but this instance was set up as 'cloud'/
    );
  });
});

describe('cloud edition on a fresh database', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp(await createDatabase(container, 'edition_cloud'), HUB_ENV);
  });

  afterAll(async () => {
    await app.stop();
  });

  it('boots (fresh DB — nothing to guard) and setup stamps edition=cloud', async () => {
    const res = await app.app.request('/api/v1/setup', json({ instanceName: 'EdCloud', owner: OWNER }));
    expect(res.status).toBe(201);
    const { rows } = await app.db.pool.query<{ edition: string }>(`SELECT edition FROM instance_settings`);
    expect(rows).toEqual([{ edition: 'cloud' }]);
  });

  it('reports edition=cloud in discovery', async () => {
    const info = await readJson(await app.app.request('/api/v1/instance'));
    expect(info.edition).toBe('cloud');
  });

  it('advertises the hub SSO method — alongside the local entrance, which still works in P2', async () => {
    const info = await readJson(await app.app.request('/api/v1/instance'));
    expect(info.auth.methods).toContain('antasphere');
    // The D1 hub-only posture (hide password/OTP) lands with the REAL SSO
    // binding in Phase 3; until then the local entrance stays advertised
    // because it is still the only working one.
    expect(info.auth.methods).toContain('password');
  });

  it('identity resolution is unchanged by the cloud stub (local sessions work)', async () => {
    const signIn = await app.app.request(
      '/api/v1/auth/sign-in/email',
      json({ email: OWNER.email, password: OWNER.password })
    );
    expect(signIn.status).toBe(200);
    const cookie = signIn.headers.get('set-cookie')!.split(';')[0]!;
    const me = await app.app.request('/api/v1/me', { headers: { cookie } });
    expect(me.status).toBe(200);
    expect((await readJson(me)).user.email).toBe(OWNER.email);
  });
});

describe('oss edition discovery (unchanged)', () => {
  it('never advertises the hub SSO method', async () => {
    const app = await createTestApp(await createDatabase(container, 'edition_oss_disc'));
    const info = await readJson(await app.app.request('/api/v1/instance'));
    expect(info.edition).toBe('oss');
    expect(info.auth.methods).not.toContain('antasphere');
    expect(info.auth.methods).toContain('password');
    await app.stop();
  });
});
