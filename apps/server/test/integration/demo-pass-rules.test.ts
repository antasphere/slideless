import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import * as chassisRoutes from '@antasphere/chassis-contract/routes';
import { workspaceMembers } from '@antasphere/chassis-db';
import {
  DEMO_SESSION_REFUSED_API_ROUTES,
  type DemoSessionRefusedApiRoute
} from '@antasphere/chassis-server/identity';
import * as deckRoutes from '@slideless/contract/routes';
import { slidelessTool } from '../../src/tool.js';
import {
  createDatabase,
  createTestApp,
  extractCookie,
  readJson,
  startPostgres,
  type TestApp
} from './helpers.js';

/**
 * A session a demo link opened is a visit: it mints no credential for anyone,
 * on the product's doors as on the chassis's (the verifier's round 1, F1). The
 * chassis refuses its own list (`DEMO_SESSION_REFUSED_API_ROUTES`); the tool
 * declares its own routes of the kind in its `demoSessionRefusedRoutes` slot,
 * appended at the one mount. This file pins the deck invite (a claim link, and
 * an outsider's claim seats a standing guest member) refused to a pass session
 * at admin for an outside address and for a colleague, and walks the PRODUCT's
 * contract with the chassis's, so the next product route that answers a
 * credential cannot be added without joining the list.
 */

const PASSWORD = 'a-long-demo-pass-password-1';
const ORIGIN = 'http://localhost:3000';
const OWNER = { email: 'owner@example.com', name: 'Olive Owner', password: PASSWORD };

const HTML = Buffer.from('<!doctype html><html><body><h1>demo</h1></body></html>');
const SHA = createHash('sha256').update(HTML).digest('hex');

type Actor = { email: string; cookie: string; userId: string };

let container: StartedPostgreSqlContainer;
let app: TestApp;
let workspaceId = '';
let owner: Actor;
let demoAdmin: Actor;
let colleague: Actor;
let deckId = '';

let ipCounter = 0;
const nextIp = () => `10.91.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

const send = (method: string, path: string, who: { cookie?: string } = {}, body?: unknown) =>
  app.app.request(`/api/v1${path}`, {
    method,
    headers: {
      'x-forwarded-for': nextIp(),
      origin: ORIGIN,
      ...(who.cookie ? { cookie: who.cookie } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {})
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });

async function expectError(res: Response, status: number, code: string): Promise<void> {
  const body = await readJson(res);
  expect({ status: res.status, code: body?.error?.code }).toEqual({ status, code });
}

async function signIn(email: string): Promise<string> {
  const res = await send('POST', '/auth/sign-in/email', {}, { email, password: PASSWORD });
  expect(res.status).toBe(200);
  return extractCookie(res);
}

async function addMember(email: string, role: 'admin' | 'member'): Promise<Actor> {
  const created = await app.auth.api.signUpEmail({ body: { email, password: PASSWORD, name: email } });
  await app.db.db
    .insert(workspaceMembers)
    .values({ workspaceId, userId: created.user.id, role, origin: 'local' });
  return { email, cookie: await signIn(email), userId: created.user.id };
}

/** Mint a pass for `email` as the owner, redeem it, and answer the session cookie it set. */
async function passCookieFor(email: string): Promise<string> {
  const minted = await send('POST', '/demo/passes', owner, { email });
  const body = await readJson(minted);
  expect(minted.status, JSON.stringify(body)).toBe(201);
  const redeemed = await send('POST', '/auth/demo/redeem', {}, { pass: body.secret });
  expect(redeemed.status).toBe(200);
  return extractCookie(redeemed);
}

async function createDeck(title: string, cookie: string): Promise<string> {
  const form = new FormData();
  form.set('sha256', SHA);
  form.set('file', new Blob([new Uint8Array(HTML)], { type: 'text/html' }), 'index.html');
  const asset = await app.app.request('/api/v1/presentations/assets', {
    method: 'POST',
    headers: { cookie, origin: ORIGIN },
    body: form
  });
  expect(asset.status).toBe(201);
  const reserve = await readJson(await send('POST', '/presentations/uploads', { cookie }));
  const commit = await send(
    'POST',
    `/presentations/uploads/${reserve.uploadSession.id}/commit`,
    { cookie },
    {
      title,
      entryPath: 'index.html',
      manifest: [{ path: 'index.html', sha256: SHA, sizeBytes: HTML.length, contentType: 'text/html' }]
    }
  );
  expect(commit.status).toBe(201);
  return reserve.uploadSession.presentationId as string;
}

const collaboratorRows = async (email: string) =>
  (
    await app.db.pool.query(`SELECT id FROM collaborators WHERE presentation_id = $1 AND lower(email) = $2`, [
      deckId,
      email.toLowerCase()
    ])
  ).rows;

beforeAll(async () => {
  container = await startPostgres();
  app = await createTestApp(await createDatabase(container, 'deck_demo_pass_rules'), {
    DEMO_SIGN_IN: 'true'
  });
  const setup = await send(
    'POST',
    '/setup',
    {},
    { setupToken: 'integration-test-setup-token', instanceName: 'Demo', owner: OWNER }
  );
  expect(setup.status).toBe(201);
  const setupBody = await readJson(setup);
  workspaceId = setupBody.workspaceId;
  owner = { email: OWNER.email, cookie: await signIn(OWNER.email), userId: setupBody.ownerUserId };
  demoAdmin = await addMember('demo-admin@example.com', 'admin');
  colleague = await addMember('colleague@antasphere-customer.io', 'member');
  deckId = await createDeck('Demo deck', owner.cookie);
}, 240_000);

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

describe('a demo link’s session invites nobody to a deck', () => {
  it('a. refused at admin for an outside address and for a colleague; the owner’s own session invites', async () => {
    const cookie = await passCookieFor(demoAdmin.email);
    const outsider = 'outsider@customer.io';

    await expectError(
      await send('POST', `/presentations/${deckId}/collaborators`, { cookie }, { email: outsider }),
      403,
      'demo_session'
    );
    expect(await collaboratorRows(outsider)).toHaveLength(0);

    await expectError(
      await send('POST', `/presentations/${deckId}/collaborators`, { cookie }, { email: colleague.email }),
      403,
      'demo_session'
    );
    expect(await collaboratorRows(colleague.email)).toHaveLength(0);

    const invited = await send('POST', `/presentations/${deckId}/collaborators`, owner, { email: outsider });
    expect(invited.status).toBe(201);
    expect((await readJson(invited)).claimUrl).toMatch(/\/collab\//);
  });
});

describe('the product’s contract walk: every route that answers a credential is on the list', () => {
  /** Top-level keys of a 2xx JSON answer that carry a credential for someone. */
  const CREDENTIAL_KEYS = new Set([
    'resetUrl',
    'verifyUrl',
    'acceptUrl',
    'claimUrl',
    'secret',
    'apiKey',
    'key'
  ]);
  /** Routes no session reaches, so no demo link's session either (the chassis walk's own). */
  const EXCLUDED: Record<string, string> = {
    'POST /cli/auth/complete': 'no session: the CLI completes an emailed code, signed out',
    'POST /sso/cli-connect':
      'no session: a hub exchange token, and cloud only, where demo sign-in never runs',
    'POST /setup': 'no session: the first boot’s setup token',
    // A share link opens one deck to READ through the viewer: it seats nobody,
    // signs nobody in and makes no account, and showing it is the product's
    // demonstration. Not refused by the lane's call, open to Romain's review.
    'POST /presentations/{id}/tokens': 'a share link: a read of one deck, the product’s own demonstration',
    'POST /presentations/{id}/preview-token':
      'the dashboard’s own one-hour preview of one deck, read only, never shown in the sharing panel'
  };
  const EXCLUDED_PREFIXES: Record<string, string> = {
    '/auth/': 'the sign-in library’s own mount: DEMO_SESSION_REFUSED_AUTH_PATHS judges it'
  };

  type RouteLike = { method: string; path: string; responses: Record<string, unknown> };
  const isRoute = (value: unknown): value is RouteLike =>
    !!value && typeof value === 'object' && 'method' in value && 'path' in value && 'responses' in value;

  /** Unwrap optional, nullable, default and readonly to the schema underneath. */
  function unwrap(schema: unknown): unknown {
    let current = schema as { _zod?: { def?: { type?: string; innerType?: unknown } } } | undefined;
    for (let i = 0; i < 10; i++) {
      const def = current?._zod?.def;
      if (!def || !['optional', 'nullable', 'default', 'readonly'].includes(def.type ?? '')) break;
      current = def.innerType as typeof current;
    }
    return current;
  }

  function credentialKeys(route: RouteLike): string[] {
    const found = new Set<string>();
    for (const [status, response] of Object.entries(route.responses)) {
      if (!/^2\d\d$/.test(status)) continue;
      const schema = unwrap(
        (response as { content?: Record<string, { schema?: unknown }> })?.content?.['application/json']
          ?.schema
      ) as { shape?: Record<string, unknown> } | undefined;
      const keys = Object.keys(schema?.shape ?? {});
      for (const key of keys) if (CREDENTIAL_KEYS.has(key)) found.add(key);
      if (keys.includes('url') && keys.includes('secret')) found.add('url');
    }
    return [...found];
  }

  /** OpenAPI `{id}` → the router's `:id`, every parameter name normalized so `:id` matches `:userId`. */
  const routerPath = (path: string) => path.replace(/\{[^}]+\}/g, ':p');

  /** The list the one mount installs: the chassis's, then the tool's declared routes. */
  const refused: readonly DemoSessionRefusedApiRoute[] = [
    ...DEMO_SESSION_REFUSED_API_ROUTES,
    ...(slidelessTool.demoSessionRefusedRoutes ?? [])
  ];

  function onTheList(method: string, path: string): boolean {
    const target = routerPath(path);
    return refused.some((rule) => {
      if (rule.method !== 'ALL' && rule.method !== method) return false;
      const rulePath = rule.path.replace(/:[A-Za-z]+/g, ':p');
      if (rulePath.endsWith('/*')) return target.startsWith(rulePath.slice(0, -1));
      return target === rulePath;
    });
  }

  it('b. finds the credential routes in the product’s contract and the chassis’s, and every one is refused a demo link’s session', () => {
    const exported: unknown[] = [...Object.values(deckRoutes), ...Object.values(chassisRoutes)];
    const routes = exported.filter(isRoute);
    expect(routes.length).toBeGreaterThan(80);

    const covered: string[] = [];
    const excluded: string[] = [];
    const missing: string[] = [];
    const seen = new Set<string>();
    for (const route of routes) {
      const method = route.method.toUpperCase();
      const name = `${method} ${route.path}`;
      if (seen.has(name)) continue;
      seen.add(name);
      const keys = credentialKeys(route);
      if (keys.length === 0) continue;
      const prefix = Object.keys(EXCLUDED_PREFIXES).find((p) => route.path.startsWith(p));
      if (EXCLUDED[name] || prefix) {
        excluded.push(`${name} (${EXCLUDED[name] ?? EXCLUDED_PREFIXES[prefix!]})`);
      } else if (onTheList(method, route.path)) {
        covered.push(`${name} [${keys.join(', ')}]`);
      } else {
        missing.push(`${name} [${keys.join(', ')}]`);
      }
    }
    console.log(`demo session refusals, covered:\n  ${covered.join('\n  ')}`);
    console.log(`demo session refusals, excluded:\n  ${excluded.join('\n  ')}`);
    expect(missing).toEqual([]);
    expect(covered).toContain('POST /presentations/{id}/collaborators [claimUrl]');
  });
});
