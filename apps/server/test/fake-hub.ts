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

  // ── Phase 4 + H4: the accounts:status machine surface ────────────────
  /**
   * Org status per hub workspace id. Unset = 'active' (a hub knows the orgs
   * its own users SSO from), so login-focused suites need no fixtures;
   * 'missing' answers 404 (org deleted / unknown — a definitive deny).
   */
  readonly orgStatuses = new Map<string, 'active' | 'suspended' | 'missing'>();
  /**
   * H2 member status per `${workspaceId}:${sub}`. Unset = `{active:true}`
   * with NO role (the tool keeps its local role), so login-focused suites
   * are undisturbed; the real H2 answers `{active:false}` for unknown pairs.
   */
  readonly members = new Map<string, { active: boolean; role?: string }>();
  /**
   * H4 org list per hub sub: workspaceId → what the list entry carries.
   * ACCUMULATES AT MINT TIME — `mintCode`/`signConnectToken` upsert the
   * fixture's org, faithful to the real hub: a minted token implies an
   * active membership of the asserted org. Tests may also write it
   * directly (`setUserOrg`/`removeUserOrg`) to model hub-side org
   * creation/removal between logins.
   *
   * H2/H4 COHERENCE at read time (the two endpoints must never contradict
   * each other mid-test): an explicit H2 `{active:false}` override drops
   * the entry from the H4 list (H4 lists ACTIVE memberships only), an
   * explicit H2 role override wins over the accumulated role, and an org
   * marked 'missing' in `orgStatuses` (deleted hub-side, FK cascade) is
   * absent from the list.
   */
  readonly userOrgs = new Map<string, Map<string, { name: string | null; role: string }>>();
  /** Failure injection for ALL status/membership endpoints. */
  statusMode: 'ok' | 'http500' | 'http403' | 'network' = 'ok';
  /**
   * Hold every status answer for this many ms (0 = answer immediately).
   * Race tests use it to keep N concurrent re-assertions in flight at once.
   */
  statusDelayMs = 0;
  /** false = the member-status route 404s wholesale (an older hub without H2). */
  h2 = true;
  /** Every status-surface request: path + presented Authorization header. */
  readonly statusRequests: Array<{ path: string; auth: string | null }> = [];

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
    this.accumulateOrg(fixture);
    return code;
  }

  /** Explicitly set/replace one org on a user's H4 list (hub-side org grant). */
  setUserOrg(sub: string, workspaceId: string, entry: { name: string | null; role: string }): void {
    const orgs = this.userOrgs.get(sub) ?? new Map<string, { name: string | null; role: string }>();
    orgs.set(workspaceId, entry);
    this.userOrgs.set(sub, orgs);
  }

  /** Drop one org from a user's H4 list (hub-side removal/leave). */
  removeUserOrg(sub: string, workspaceId: string): void {
    this.userOrgs.get(sub)?.delete(workspaceId);
  }

  /** Mint-time accumulation: a minted token implies an active membership. */
  private accumulateOrg(fixture: HubUserFixture): void {
    // Mirror the token claims exactly: a fixture minted with
    // `workspaceName: null` models a hub that carries no name for the org,
    // so its H4 entry carries none either (the endpoints stay coherent).
    this.setUserOrg(fixture.sub, fixture.workspaceId, {
      name: fixture.workspaceName === null ? null : (fixture.workspaceName ?? 'Fake Org'),
      role: fixture.role
    });
  }

  /** Sign an access token directly (verifier unit tests — no HTTP dance). */
  async signAccessToken(fixture: HubUserFixture, resource: string): Promise<string> {
    return this.accessToken(fixture, resource);
  }

  /**
   * Sign an H3 exchange token — what the real hub's `POST /sso/tool-token`
   * mints for `slideless /sso/cli-connect` (the P5 pinned contract): a
   * 120 s RS256 JWT, `aud` = the TOOL's resource URL (single string, no
   * userinfo entry — this is not an OIDC access token), the
   * membershipAccessClaims org payload, `purpose: 'sso-connect'`, and a
   * unique `jti`. `opts` bends the connect-specific claims for negative
   * tests; `fixture.overrides` still bends iss/exp/aud like everywhere else.
   */
  async signConnectToken(
    fixture: HubUserFixture,
    resource: string,
    opts: {
      /** Explicit jti (replay tests share one); default = fresh unique. */
      jti?: string | undefined;
      /** true = omit the jti claim entirely. */
      omitJti?: boolean | undefined;
      /** Replacement purpose; null = omit the claim. Default 'sso-connect'. */
      purpose?: string | null | undefined;
    } = {}
  ): Promise<{ token: string; jti: string }> {
    const key = this.signingKey();
    const o = fixture.overrides ?? {};
    const now = Math.floor(Date.now() / 1000);
    const jti = opts.jti ?? `jti_${randomUUID()}`;
    const purpose = opts.purpose === undefined ? 'sso-connect' : opts.purpose;
    this.accumulateOrg(fixture);
    const token = await new SignJWT({
      role: fixture.role,
      workspace_id: fixture.workspaceId,
      ...(fixture.workspaceName === null ? {} : { workspace_name: fixture.workspaceName ?? 'Fake Org' }),
      email: fixture.email,
      ...(purpose === null ? {} : { purpose }),
      ...(opts.omitJti ? {} : { jti }),
      aud: o.accessAud ?? resource
    })
      .setProtectedHeader({ alg: 'RS256', kid: key.kid })
      .setSubject(fixture.sub)
      .setIssuer(o.iss ?? this.issuer)
      .setIssuedAt(now)
      .setExpirationTime(now + (o.expiresInSeconds ?? 120))
      .sign(key.privateKey);
    return { token, jti };
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
    // ── Phase 4 + H4: GET /accounts/{ws}/status, /accounts/{ws}/members/{sub}/status,
    // and /accounts/users/{sub}/memberships (always present — the real hub always has H4)
    const userMemberships = /^\/api\/v1\/accounts\/users\/([^/]+)\/memberships$/.exec(url.pathname);
    const orgStatus = userMemberships ? null : /^\/api\/v1\/accounts\/([^/]+)\/status$/.exec(url.pathname);
    const memberStatus = /^\/api\/v1\/accounts\/([^/]+)\/members\/([^/]+)\/status$/.exec(url.pathname);
    if (req.method === 'GET' && (orgStatus || memberStatus || userMemberships)) {
      this.statusRequests.push({ path: url.pathname, auth: req.headers.authorization ?? null });
      if (this.statusDelayMs > 0) await new Promise((r) => setTimeout(r, this.statusDelayMs));
      if (this.statusMode === 'network') {
        req.destroy(); // mid-request connection failure, no HTTP answer
        return;
      }
      if (this.statusMode === 'http500') return sendJson(res, 500, { error: { code: 'internal' } });
      if (this.statusMode === 'http403') {
        // A stale hub's scope allowlist (or a broken key): the consumer must
        // read it as a loud transient error, never as a membership answer.
        return sendJson(res, 403, { error: { code: 'endpoint_not_allowed' } });
      }
      if (userMemberships) {
        return sendJson(res, 200, this.userMembershipsBody(decodeURIComponent(userMemberships[1]!)));
      }
      if (orgStatus) {
        const status = this.orgStatuses.get(decodeURIComponent(orgStatus[1]!)) ?? 'active';
        if (status === 'missing') return sendJson(res, 404, { error: { code: 'not_found' } });
        return sendJson(res, 200, { status, kind: 'organization' });
      }
      if (!this.h2) return sendJson(res, 404, { error: { code: 'not_found' } });
      const key = `${decodeURIComponent(memberStatus![1]!)}:${decodeURIComponent(memberStatus![2]!)}`;
      const member = this.members.get(key) ?? { active: true };
      // Contract shape (hub delta H2): role present ONLY while active.
      return sendJson(
        res,
        200,
        member.active ? { active: true, ...(member.role ? { role: member.role } : {}) } : { active: false }
      );
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

  /**
   * The H4 body for one sub (pinned wire shape:
   * `{ memberships: [{ workspaceId, name, role, status, kind }] }`), with
   * the H2/H4 coherence rules applied at read time. Unknown user =
   * `{ memberships: [] }` — the real machine surface is uniformly 200.
   */
  private userMembershipsBody(sub: string): {
    memberships: Array<{ workspaceId: string; name?: string; role: string; status: string; kind: string }>;
  } {
    const memberships: Array<{
      workspaceId: string;
      name?: string;
      role: string;
      status: string;
      kind: string;
    }> = [];
    for (const [workspaceId, entry] of this.userOrgs.get(sub) ?? []) {
      const override = this.members.get(`${workspaceId}:${sub}`);
      if (override && !override.active) continue; // H2 {active:false} wins — H4 lists ACTIVE only
      const orgStatus = this.orgStatuses.get(workspaceId) ?? 'active';
      if (orgStatus === 'missing') continue; // deleted org: FK cascade, absent from the list
      memberships.push({
        workspaceId,
        // A null name models a hub org whose name claim the tool never saw
        // (H1-less token) — omit the field, tolerant parse maps it to null.
        ...(entry.name === null ? {} : { name: entry.name }),
        role: override?.role ?? entry.role, // an explicit H2 role override wins
        status: orgStatus,
        kind: 'organization'
      });
    }
    return { memberships };
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
