import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { serve, type ServerType } from '@hono/node-server';
import { createServer } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { OauthJwtVerifier } from '../../src/identity/oauth-jwt.js';
import type { Auth } from '../../src/identity/better-auth.js';
import {
  createDatabase,
  createTestApp,
  extractCookie,
  readJson,
  startPostgres,
  type TestApp
} from './helpers.js';

/**
 * OAuth workspace binding (ADR 014): the grant carries the workspace chosen
 * at consent through the plugin's referenceId seam — into the access-token
 * claim, onto the refresh-token row, and back out of every refresh re-mint.
 * Plus the fail-closed legacy rules (grants/tokens minted before binding
 * existed) and the claimless-JWT resolution fallback.
 */
const OWNER = {
  email: 'oauth-multi@ws.test',
  name: 'OAuth Multi',
  password: 'a-long-owner-password-123'
};
const BOB = { email: 'oauth-bob@ws.test', name: 'OAuth Bob', password: 'a-long-bob-password-1234' };
const REDIRECT_URI = 'http://127.0.0.1:39218/callback';

let container: StartedPostgreSqlContainer;
let app: TestApp;
let server: ServerType;
let base = '';
let ownerCookie = '';
let bobCookie = '';
let ownerId = '';
let bobId = '';
let w1 = '';
let w2 = '';
let w3 = ''; // Bob's sole workspace
let clientId = '';

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function jwtPayload(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString());
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('no port'));
        return;
      }
      srv.close(() => resolve(address.port));
    });
  });
}

async function signIn(email: string, password: string): Promise<string> {
  const res = await fetch(`${base}/api/v1/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  expect(res.status).toBe(200);
  return extractCookie(res);
}

/** GET /oauth2/authorize → the redirect target (302 or JSON shape). */
async function authorize(cookie: string): Promise<{ location: string; verifier: string }> {
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: 'openid offline_access presentations:read presentations:write',
    state: 'ws-state',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: `${base}/mcp`
  });
  const res = await fetch(`${base}/api/v1/auth/oauth2/authorize?${params}`, {
    headers: { cookie },
    redirect: 'manual'
  });
  let location: string;
  if (res.status === 302) {
    location = res.headers.get('location') ?? '';
  } else {
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.redirect).toBe(true);
    location = body.url;
  }
  return { location, verifier };
}

/** POST the signed query back as consent, returning the code redirect URL. */
async function consent(cookie: string, consentLocation: string): Promise<Response> {
  const signedQuery = consentLocation.split('?')[1] ?? '';
  return fetch(`${base}/api/v1/auth/oauth2/consent`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ accept: true, oauth_query: signedQuery })
  });
}

async function exchange(code: string, verifier: string): Promise<Response> {
  return fetch(`${base}/api/v1/auth/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
      resource: `${base}/mcp`
    })
  });
}

async function refresh(refreshToken: string): Promise<Response> {
  return fetch(`${base}/api/v1/auth/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      resource: `${base}/mcp`
    })
  });
}

/** Full dance for a cookie, optionally parking a workspace selection first. */
async function dance(
  cookie: string,
  selectWorkspace?: string
): Promise<{ accessToken: string; refreshToken: string }> {
  if (selectWorkspace) {
    const sel = await fetch(`${base}/api/v1/oauth/consent-workspace`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: selectWorkspace })
    });
    expect(sel.status).toBe(200);
  }
  const { location, verifier } = await authorize(cookie);
  let codeUrl: URL;
  if (location.includes('/oauth/consent?')) {
    const consented = await consent(cookie, location);
    expect(consented.status).toBe(200);
    const body = await readJson(consented);
    codeUrl = new URL(body.redirect_uri ?? body.url ?? '');
  } else {
    codeUrl = new URL(location); // silent re-authorize (existing consent)
  }
  expect(codeUrl.origin + codeUrl.pathname).toBe(REDIRECT_URI);
  const code = codeUrl.searchParams.get('code');
  expect(code).toBeTruthy();
  const token = await exchange(code!, verifier);
  expect(token.status).toBe(200);
  const grant = await readJson(token);
  expect(grant.access_token.split('.')).toHaveLength(3);
  return { accessToken: grant.access_token, refreshToken: grant.refresh_token };
}

beforeAll(async () => {
  container = await startPostgres();
  const dbUrl = await createDatabase(container, 'oauth_ws');
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  app = await createTestApp(dbUrl, { PUBLIC_BASE_URL: base });
  server = serve({ fetch: app.app.fetch, port, hostname: '127.0.0.1' });

  const setup = await fetch(`${base}/api/v1/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instanceName: 'OAuth WS One', owner: OWNER })
  });
  expect(setup.status).toBe(201);
  w1 = (await readJson(setup)).workspaceId;

  ownerCookie = await signIn(OWNER.email, OWNER.password);
  const me = await readJson(await fetch(`${base}/api/v1/me`, { headers: { cookie: ownerCookie } }));
  ownerId = me.user.id;
  w2 = (await app.registry.workspaces.create('OAuth WS Two', ownerId)).workspaceId;

  const bob = await app.auth.api.signUpEmail({
    body: { email: BOB.email, password: BOB.password, name: BOB.name }
  });
  bobId = bob.user.id;
  w3 = (await app.registry.workspaces.create('Bob WS', bobId)).workspaceId;
  bobCookie = await signIn(BOB.email, BOB.password);

  const register = await fetch(`${base}/api/v1/auth/oauth2/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'ws-binding-client',
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code']
    })
  });
  expect([200, 201]).toContain(register.status);
  clientId = (await readJson(register)).client_id;
}, 240_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await app?.stop();
  await container?.stop();
});

describe('consent-time binding', () => {
  let w1Tokens: { accessToken: string; refreshToken: string };
  let w2Tokens: { accessToken: string; refreshToken: string };

  it('a pickerless consent binds the deterministic default (oldest membership)', async () => {
    w1Tokens = await dance(ownerCookie);
    expect(jwtPayload(w1Tokens.accessToken).workspace_id).toBe(w1);
    const me = await readJson(
      await fetch(`${base}/api/v1/me`, {
        headers: { authorization: `Bearer ${w1Tokens.accessToken}` }
      })
    );
    expect(me.activeWorkspaceId).toBe(w1);
    expect(me.workspaces).toEqual([{ id: w1, name: 'OAuth WS One', role: 'owner' }]);
  });

  it('a parked selection binds the CHOSEN workspace; consents coexist per workspace', async () => {
    w2Tokens = await dance(ownerCookie, w2);
    expect(jwtPayload(w2Tokens.accessToken).workspace_id).toBe(w2);

    // Resource access is scoped to the granted workspace.
    const up = await fetch(`${base}/api/v1/files?name=w2-oauth.txt`, {
      method: 'POST',
      headers: { cookie: ownerCookie, 'content-type': 'text/plain', 'x-workspace-id': w2 },
      body: 'w2 bytes'
    });
    expect(up.status).toBe(201);
    const viaW2 = await readJson(
      await fetch(`${base}/api/v1/files`, {
        headers: { authorization: `Bearer ${w2Tokens.accessToken}` }
      })
    );
    expect(viaW2.files.map((f: { originalName: string }) => f.originalName)).toEqual(['w2-oauth.txt']);
    const viaW1 = await readJson(
      await fetch(`${base}/api/v1/files`, {
        headers: { authorization: `Bearer ${w1Tokens.accessToken}` }
      })
    );
    expect(viaW1.files).toEqual([]);
  });

  it('refresh re-mints keep the STORED workspace (the selection is long gone)', async () => {
    // The parked selection was consumed by the consent flow; the refresh
    // grant must read the workspace from the refresh-token ROW.
    const res = await refresh(w2Tokens.refreshToken);
    expect(res.status).toBe(200);
    const grant = await readJson(res);
    expect(jwtPayload(grant.access_token).workspace_id).toBe(w2);
    // And the rotated refresh token keeps it too.
    const again = await refresh(grant.refresh_token);
    expect(again.status).toBe(200);
    expect(jwtPayload((await readJson(again)).access_token).workspace_id).toBe(w2);
  });

  it('a legacy unbound grant fails closed for a multi-workspace user', async () => {
    // Simulate a pre-ADR-012 grant: strip the stored binding.
    const fresh = await dance(ownerCookie, w2);
    await app.db.pool.query(`UPDATE oauth_refresh_token SET reference_id = NULL WHERE user_id = $1`, [
      ownerId
    ]);
    const res = await refresh(fresh.refreshToken);
    expect(res.ok).toBe(false);
    const body = await readJson(res).catch(() => ({}));
    expect(JSON.stringify(body)).toContain('access_denied');
  });

  it('a legacy unbound grant falls back to the SOLE membership', async () => {
    const bobTokens = await dance(bobCookie);
    expect(jwtPayload(bobTokens.accessToken).workspace_id).toBe(w3);
    await app.db.pool.query(`UPDATE oauth_refresh_token SET reference_id = NULL WHERE user_id = $1`, [bobId]);
    const res = await refresh(bobTokens.refreshToken);
    expect(res.status).toBe(200);
    expect(jwtPayload((await readJson(res)).access_token).workspace_id).toBe(w3);
  });
});

describe('the consent-workspace endpoint fails closed', () => {
  it('rejects a workspace the caller does not belong to (uniform 403)', async () => {
    for (const target of [w1, '00000000-0000-4000-8000-000000000000']) {
      const res = await fetch(`${base}/api/v1/oauth/consent-workspace`, {
        method: 'POST',
        headers: { cookie: bobCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: target })
      });
      expect(res.status).toBe(403);
      expect((await readJson(res)).error.code).toBe('forbidden');
    }
  });

  it('is unreachable with a machine credential (fail-closed scope gate)', async () => {
    const mint = await fetch(`${base}/api/v1/api-keys`, {
      method: 'POST',
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'ws-probe', scopes: ['presentations:read', 'presentations:write'] })
    });
    expect(mint.status).toBe(201);
    const key = (await readJson(mint)).key;
    const res = await fetch(`${base}/api/v1/oauth/consent-workspace`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: w1 })
    });
    expect(res.status).toBe(403);
    expect((await readJson(res)).error.code).toBe('endpoint_not_allowed');
  });

  it('a selection whose membership was revoked kills the consent, never rebinds silently', async () => {
    // Bob temporarily joins W2 as a plain member (deactivating a MEMBER row
    // never trips the 0009 last-owner trigger), parks a W2 selection, and
    // loses the membership before authorize re-computes the binding.
    await app.db.pool.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'member')`,
      [w2, bobId]
    );
    try {
      const sel = await fetch(`${base}/api/v1/oauth/consent-workspace`, {
        method: 'POST',
        headers: { cookie: bobCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: w2 })
      });
      expect(sel.status).toBe(200);
      await app.db.pool.query(
        `UPDATE workspace_members SET is_active = false WHERE user_id = $1 AND workspace_id = $2`,
        [bobId, w2]
      );
      // The authorize itself re-computes the referenceId and must refuse
      // outright (403 access_denied) — never silently fall back to another
      // workspace.
      const params = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        scope: 'openid presentations:read',
        code_challenge: b64url(
          createHash('sha256')
            .update(b64url(randomBytes(48)))
            .digest()
        ),
        code_challenge_method: 'S256',
        resource: `${base}/mcp`
      });
      const res = await fetch(`${base}/api/v1/auth/oauth2/authorize?${params}`, {
        headers: { cookie: bobCookie },
        redirect: 'manual'
      });
      expect(res.status).toBe(403);
      expect(JSON.stringify(await readJson(res).catch(() => ({})))).toContain('access_denied');
    } finally {
      await app.db.pool.query(`DELETE FROM workspace_members WHERE user_id = $1 AND workspace_id = $2`, [
        bobId,
        w2
      ]);
    }
  });
});

describe('claimless-JWT resolution fallback (OauthJwtVerifier)', () => {
  it('resolves by claim, falls back to the sole membership, fails closed on several', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), alg: 'RS256', kid: 'ws-test' };
    const fakeAuth = { api: { getJwks: async () => ({ keys: [jwk] }) } } as unknown as Auth;
    const verifier = new OauthJwtVerifier(fakeAuth, app.db.db, base);

    const sign = (sub: string, workspaceId?: string) =>
      new SignJWT({ scope: 'presentations:read', ...(workspaceId ? { workspace_id: workspaceId } : {}) })
        .setProtectedHeader({ alg: 'RS256', kid: 'ws-test' })
        .setIssuer(base)
        .setAudience(`${base}/mcp`)
        .setSubject(sub)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);

    // Claimed workspace pins the membership re-check.
    const claimed = await verifier.resolve(await sign(ownerId, w2));
    expect(claimed?.workspaceId).toBe(w2);
    // Legacy claimless token: several memberships → null (fail closed).
    expect(await verifier.resolve(await sign(ownerId))).toBeNull();
    // Legacy claimless token: sole membership → resolves to it.
    const sole = await verifier.resolve(await sign(bobId));
    expect(sole?.workspaceId).toBe(w3);
    // A claim naming a workspace the subject does not belong to → null.
    expect(await verifier.resolve(await sign(bobId, w1))).toBeNull();
    // A malformed claim never reaches the uuid cast → null, not a 500.
    expect(await verifier.resolve(await sign(ownerId, 'not-a-uuid'))).toBeNull();
  });
});
