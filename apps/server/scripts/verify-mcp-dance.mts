/**
 * End-to-end MCP connector proof against a RUNNING instance (exit criterion
 * 13): discovery → dynamic client registration → login → consent → PKCE
 * token exchange → official MCP SDK client calling get_me.
 *
 *   pnpm --filter @slideless/server exec tsx scripts/verify-mcp-dance.mts \
 *     http://localhost:3000 owner@example.com 'password'
 */
import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const [base, email, password] = process.argv.slice(2);
if (!base || !email || !password) {
  console.error('usage: verify-mcp-dance.mts <base-url> <email> <password>');
  process.exit(1);
}

const ok = (msg: string) => console.log(`✔ ${msg}`);
const fail = (msg: string): never => {
  console.error(`✖ ${msg}`);
  process.exit(1);
};

// 1. Bare /mcp must challenge with resource metadata.
const bare = await fetch(`${base}/mcp`, { method: 'POST' });
if (bare.status !== 401) fail(`bare /mcp: expected 401, got ${bare.status}`);
const challenge = bare.headers.get('www-authenticate') ?? '';
if (!challenge.includes('oauth-protected-resource/mcp')) fail(`challenge header missing: ${challenge}`);
ok(`401 challenge: ${challenge}`);

// 2. RFC 9728 resource metadata points at this instance as the AS.
const meta = (await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json()) as {
  resource: string;
  authorization_servers: string[];
};
if (meta.resource !== `${base}/mcp`) fail(`resource mismatch: ${meta.resource}`);
ok(`resource metadata: ${meta.resource} ← AS ${meta.authorization_servers[0]}`);

// 3. Dynamic client registration (no auth).
const reg = (await (
  await fetch(`${base}/api/v1/auth/oauth2/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'mcp-dance-drill',
      redirect_uris: ['http://localhost:19191/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code']
    })
  })
).json()) as { client_id: string };
if (!reg.client_id) fail('DCR returned no client_id');
ok(`registered client ${reg.client_id}`);

// 4. Sign in for a session cookie.
// Node's fetch sends sec-fetch-mode: cors with no Origin, which Better Auth
// rightly rejects (MISSING_OR_NULL_ORIGIN). Send the origin a browser would.
const signIn = await fetch(`${base}/api/v1/auth/sign-in/email`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: base },
  body: JSON.stringify({ email, password })
});
if (signIn.status !== 200) fail(`sign-in: ${signIn.status}`);
const cookie = (signIn.headers.get('set-cookie') ?? '')
  .split(',')
  .map((p) => p.split(';')[0]?.trim())
  .filter(Boolean)
  .join('; ');
ok(`signed in as ${email}`);

// 5. Authorize with PKCE → consent redirect carrying the signed query.
const verifier = randomBytes(32).toString('base64url');
const challengeS256 = createHash('sha256').update(verifier).digest('base64url');
const authorizeUrl = new URL(`${base}/api/v1/auth/oauth2/authorize`);
authorizeUrl.search = new URLSearchParams({
  response_type: 'code',
  client_id: reg.client_id,
  redirect_uri: 'http://localhost:19191/callback',
  scope: 'openid presentations:read presentations:write offline_access',
  state: 'drill-state',
  code_challenge: challengeS256,
  code_challenge_method: 'S256',
  resource: `${base}/mcp`
}).toString();
const authorize = await fetch(authorizeUrl, { headers: { cookie }, redirect: 'manual' });
let consentLocation: string;
if (authorize.status === 302) {
  consentLocation = authorize.headers.get('location') ?? '';
} else {
  const body = (await authorize.json()) as { redirect?: boolean; url?: string };
  if (!body.url) fail(`authorize: unexpected ${authorize.status}`);
  consentLocation = body.url!;
}
if (!consentLocation.includes('/oauth/consent')) fail(`no consent redirect: ${consentLocation}`);
ok('authorize → consent redirect (signed query present)');

// 6. Approve consent with the opaque query.
const oauthQuery = consentLocation.split('?')[1] ?? '';
const consent = await fetch(`${base}/api/v1/auth/oauth2/consent`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie, origin: base },
  body: JSON.stringify({ accept: true, oauth_query: oauthQuery })
});
const consentBody = (await consent.json()) as { redirect_uri?: string; url?: string };
const cbUrl = consentBody.redirect_uri ?? consentBody.url ?? fail(`consent: ${consent.status}`);
const code = new URL(cbUrl).searchParams.get('code') ?? fail('no code in callback');
ok('consent approved → authorization code');

// 7. PKCE token exchange (cookie-less, foreign Origin — the RFC 6749 shape).
const token = (await (
  await fetch(`${base}/api/v1/auth/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://claude.ai' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: 'http://localhost:19191/callback',
      client_id: reg.client_id,
      code_verifier: verifier,
      resource: `${base}/mcp`
    })
  })
).json()) as { access_token?: string };
if (!token.access_token || token.access_token.split('.').length !== 3) {
  fail('token exchange did not yield a JWT');
}
ok('token exchange → RS256 access token');

// 8. Official MCP SDK client: initialize + call get_me.
const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
  requestInit: { headers: { authorization: `Bearer ${token.access_token}` } }
});
const client = new Client({ name: 'dance-drill', version: '1.0.0' });
await client.connect(transport);
const tools = await client.listTools();
ok(`MCP tools: ${tools.tools.map((t) => t.name).join(', ')}`);
const me = await client.callTool({ name: 'get_me', arguments: {} });
const text = JSON.stringify(me.content);
if (!text.includes(email)) fail(`get_me did not return the caller: ${text}`);
ok(`get_me → ${email} (full dance complete)`);
await client.close();
