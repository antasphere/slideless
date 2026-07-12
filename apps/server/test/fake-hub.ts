import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';

/**
 * A minimal in-process Antasphere-hub stand-in for tests: OIDC discovery,
 * JWKS, and a token endpoint that mints the SAME token shapes the real hub
 * does (verified against the pinned @better-auth/oauth-provider source and
 * the live hub in spike S1):
 *
 *  - access token: RS256 JWT with the hub's `membershipAccessClaims` custom
 *    claims ({ role, workspace_id, workspace_name, email }) and
 *    `aud = [<resource>, <issuer>/api/v1/auth/oauth2/userinfo]` — minted
 *    ONLY when the token request body carries RFC 8707 `resource` (without
 *    it the real hub mints an OPAQUE token; so does this fake);
 *  - id_token: RS256 JWT with the OIDC user claims
 *    ({ name, email, email_verified }) and `aud = <client_id>`.
 *
 * Fixtures are registered per authorization code (`mintCode`), consumed
 * once. `overrides` bend individual claims for negative tests.
 */

export interface HubTokenOverrides {
  /** Replace the access token's aud entirely (wrong-resource tests). */
  accessAud?: string | string[] | undefined;
  /** Replace iss on both tokens (wrong-issuer tests). */
  iss?: string | undefined;
  /** Seconds from now for exp; negative = already expired. */
  expiresInSeconds?: number | undefined;
  /** Return a non-JWT access token even when `resource` was sent. */
  forceOpaque?: boolean | undefined;
  /** Give the id_token a different sub (cross-pin tests). */
  idTokenSub?: string | undefined;
}

export interface HubUserFixture {
  sub: string;
  email: string;
  emailVerified?: boolean | undefined;
  name?: string | undefined;
  workspaceId: string;
  role: string;
  /** H1 claim; set null to simulate a hub without it. */
  workspaceName?: string | null | undefined;
  overrides?: HubTokenOverrides | undefined;
}

interface HubKey {
  kid: string;
  privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
  publicJwk: JWK;
}

export class FakeHub {
  readonly codes = new Map<string, HubUserFixture>();
  /** Body of the most recent token request — pins the `resource` passthrough. */
  lastTokenRequest: URLSearchParams | null = null;

  private constructor(
    private readonly server: Server,
    readonly issuer: string,
    private keys: HubKey[]
  ) {}

  static async start(): Promise<FakeHub> {
    const key = await newKey();
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fake hub failed to bind');
    const hub = new FakeHub(server, `http://127.0.0.1:${address.port}`, [key]);
    server.on('request', (req, res) => void hub.handle(req, res));
    return hub;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => this.server.close((err) => (err ? reject(err) : resolve())));
  }

  /** Rotate the signing key: new tokens sign with the new key; old key drops out of the JWKS. */
  async rotateKey(): Promise<void> {
    this.keys = [await newKey()];
  }

  /** Register a one-shot authorization code for the given user/org assertion. */
  mintCode(fixture: HubUserFixture): string {
    const code = `code_${randomUUID()}`;
    this.codes.set(code, fixture);
    return code;
  }

  /** Sign an access token directly (verifier unit tests — no HTTP dance). */
  async signAccessToken(fixture: HubUserFixture, resource: string): Promise<string> {
    return this.accessToken(fixture, resource);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.issuer);
    if (req.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
      return sendJson(res, 200, {
        issuer: this.issuer,
        authorization_endpoint: `${this.issuer}/api/v1/auth/oauth2/authorize`,
        token_endpoint: `${this.issuer}/api/v1/auth/oauth2/token`,
        userinfo_endpoint: `${this.issuer}/api/v1/auth/oauth2/userinfo`,
        jwks_uri: `${this.issuer}/api/v1/auth/jwks`,
        code_challenge_methods_supported: ['S256'],
        id_token_signing_alg_values_supported: ['RS256']
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/v1/auth/jwks') {
      return sendJson(res, 200, { keys: this.keys.map((k) => ({ ...k.publicJwk, kid: k.kid })) });
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/auth/oauth2/token') {
      const body = new URLSearchParams(await readBody(req));
      this.lastTokenRequest = body;
      const fixture = this.codes.get(body.get('code') ?? '');
      if (!fixture) {
        return sendJson(res, 400, { error: 'invalid_grant', error_description: 'unknown code' });
      }
      this.codes.delete(body.get('code')!); // one-shot, like the real thing
      const resource = body.get('resource');
      // The real hub mints a JWT access token IFF the TOKEN request carries
      // a valid `resource` (checkResource → isJwtAccessToken); otherwise the
      // token is opaque. Reproduce that faithfully — it is exactly what the
      // S1 spike de-risked.
      const accessToken =
        resource && !fixture.overrides?.forceOpaque
          ? await this.accessToken(fixture, resource)
          : `opaque_${randomUUID()}`;
      return sendJson(res, 200, {
        access_token: accessToken,
        id_token: await this.idToken(fixture, body.get('client_id') ?? 'tool-slideless-cloud'),
        token_type: 'Bearer',
        expires_in: 900,
        scope: 'openid profile email'
      });
    }
    sendJson(res, 404, { error: 'not_found' });
  }

  private signingKey(): HubKey {
    const key = this.keys[0];
    if (!key) throw new Error('fake hub has no signing key');
    return key;
  }

  private async accessToken(fixture: HubUserFixture, resource: string): Promise<string> {
    const key = this.signingKey();
    const o = fixture.overrides ?? {};
    const aud = o.accessAud ?? [resource, `${this.issuer}/api/v1/auth/oauth2/userinfo`];
    const now = Math.floor(Date.now() / 1000);
    const exp = now + (o.expiresInSeconds ?? 900);
    return new SignJWT({
      // membershipAccessClaims (+ H1 workspace_name)
      role: fixture.role,
      workspace_id: fixture.workspaceId,
      ...(fixture.workspaceName === null ? {} : { workspace_name: fixture.workspaceName ?? 'Fake Org' }),
      email: fixture.email,
      azp: 'tool-slideless-cloud',
      scope: 'openid profile email',
      aud
    })
      .setProtectedHeader({ alg: 'RS256', kid: key.kid })
      .setSubject(fixture.sub)
      .setIssuer(o.iss ?? this.issuer)
      .setIssuedAt(now)
      .setExpirationTime(exp)
      .sign(key.privateKey);
  }

  private async idToken(fixture: HubUserFixture, clientId: string): Promise<string> {
    const key = this.signingKey();
    const o = fixture.overrides ?? {};
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      name: fixture.name ?? 'Fake Hub User',
      email: fixture.email,
      email_verified: fixture.emailVerified ?? true,
      aud: clientId
    })
      .setProtectedHeader({ alg: 'RS256', kid: key.kid })
      .setSubject(o.idTokenSub ?? fixture.sub)
      .setIssuer(o.iss ?? this.issuer)
      .setIssuedAt(now)
      .setExpirationTime(now + (o.expiresInSeconds ?? 3600))
      .sign(key.privateKey);
  }
}

async function newKey(): Promise<HubKey> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  return { kid: `kid_${randomUUID()}`, privateKey, publicJwk };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
