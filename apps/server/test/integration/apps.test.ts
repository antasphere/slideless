import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
 * The Apps page's route (`GET /apps`, `src/apps/`) through the REAL boot, on a
 * self-hosted instance with an operator's file (`APPS_FILE`): a browser
 * session reads the list (this tool marked current, the account from the
 * file's `account` entry, a non-http entry left out), and a machine
 * credential is refused before the handler, since no rule of the scope
 * allowlist opens the path (fail-closed). The selection rules and the cloud
 * branch against a fake hub are the unit suite's (`test/unit/apps.test.ts`).
 */

const OWNER = { email: 'owner@apps.test', name: 'Apps Owner', password: 'apps-owner-password-1' };

let container: StartedPostgreSqlContainer;
let app: TestApp;
let cookie = '';
let workspaceId = '';

let ipCounter = 0;
const nextIp = () => `10.76.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

const send = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
  app.app.request(`/api/v1${path}`, {
    method,
    headers: {
      'x-forwarded-for': nextIp(),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apps-route-'));
  const appsFile = join(dir, 'apps.json');
  writeFileSync(
    appsFile,
    JSON.stringify([
      { slug: 'account', name: 'Antasphere account', launchUrl: 'https://account.example.com' },
      { slug: 'finance', name: 'Antasphere Finance', launchUrl: 'https://finance.example.com' },
      { slug: 'slideless', name: 'Slideless', launchUrl: 'https://slideless.example.com' },
      { slug: 'crm', name: 'Antasphere CRM', launchUrl: 'javascript:alert(1)' }
    ])
  );
  container = await startPostgres();
  app = await createTestApp(await createDatabase(container, 'apps_route'), { APPS_FILE: appsFile });
  const setup = await send(
    'POST',
    '/setup',
    {},
    { setupToken: 'integration-test-setup-token', instanceName: 'Apps', owner: OWNER }
  );
  expect(setup.status).toBe(201);
  workspaceId = (await readJson(setup)).workspaceId;
  const signIn = await send(
    'POST',
    '/auth/sign-in/email',
    {},
    { email: OWNER.email, password: OWNER.password }
  );
  expect(signIn.status).toBe(200);
  cookie = extractCookie(signIn);
});

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

describe('GET /apps', () => {
  it('a session reads the operator’s list: this tool current, the account apart, a non-http entry left out', async () => {
    const res = await send('GET', '/apps', { cookie, 'x-workspace-id': workspaceId });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.source).toBe('file');
    expect(body.hub).toEqual({ url: 'https://account.example.com/', name: 'Antasphere account' });
    expect(body.apps.map((a: { slug: string; current: boolean }) => [a.slug, a.current])).toEqual([
      ['finance', false],
      ['slideless', true]
    ]);
  });

  it('answers 401 with no credential', async () => {
    expect((await send('GET', '/apps', {})).status).toBe(401);
  });

  it('refuses an API key 403 whatever its scopes: the path is in no rule of the allowlist', async () => {
    const created = await send(
      'POST',
      '/api-keys',
      { cookie, 'x-workspace-id': workspaceId },
      { name: 'apps-probe', scopes: ['presentations:read', 'presentations:write'] }
    );
    expect(created.status).toBe(201);
    const key = (await readJson(created)).key as string;
    const res = await send('GET', '/apps', { authorization: `Bearer ${key}` });
    expect(res.status).toBe(403);
  });
});
