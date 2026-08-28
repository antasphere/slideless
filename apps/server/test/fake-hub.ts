import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';

/**
 * A minimal in-process Antasphere-hub stand-in for tests, faithful to the
 * USER-SCOPED federation contract (internal/federation.md; verified against the
 * hub's Stage A `api/orgs.ts` + the pinned oauth-provider plugin):
 *
 *  - OIDC discovery + JWKS + token endpoint. The token endpoint honors
 *    `grant_type=authorization_code` (one-shot codes via `mintCode`) AND
 *    `grant_type=refresh_token` with ROTATION + RFC 9700 REUSE DETECTION:
 *    every refresh rotates the token; presenting a rotated-out token
 *    answers 400 `invalid_grant` and tears down the whole (sub, client)
 *    family — the single most important fixture of the grant suite.
 *  - RFC 8707 `resource` controls JWT minting on BOTH grants: with it the
 *    access token is an RS256 JWT audienced `[<resource>, <userinfo>]`;
 *    without it the token is OPAQUE (and dies at the fake's /api/v1 exactly
 *    like at the real hub's).
 *  - `GET /api/v1/orgs` is CALLER-SCOPED: the presented bearer must be a
 *    live JWT this fake minted whose `aud` includes the HUB's own resource
 *    (`<issuer>/mcp`) — pinning the tokenResource seam: a tool-audienced
 *    token is refused 401. The answer is the token's SUBJECT's org list
 *    (`setUserOrg`/`removeUserOrg`; a `mintCode` fixture seeds its own org).
 *    There is NO target-user parameter anywhere.
 *  - `POST /api/v1/auth/oauth2/introspect` (RFC 7662, client-credentialed)
 *    answers `active` for a refresh token exactly like the pinned plugin:
 *    unknown / rotated-out / torn-down → `active:false`, and — the property
 *    the grant service's probe relies on — introspection is READ-ONLY: it
 *    never rotates and never tears a family down.
 *  - failure injection per surface: `orgsMode`/`tokenMode` ∈ ok | http500 |
 *    network (+ token-only: invalid_grant | invalid_client | hang |
 *    commit_then_hang — the latter ROTATES, then never answers: the
 *    slow-but-alive hub of PRDCT-1370), `introspectMode`, plus delays.
 *
 * Access tokens still carry the TRANSITIONAL advisory org claims the real
 * hub emits through the compat window ({role, workspace_id, …}) — Slideless
 * must ignore them, and the suites prove nothing reads them.
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
  /**
   * Put a `sid` claim on the id_token — what the real hub mints once its
   * tool client carries `enableEndSession` (RP-initiated logout). Absent by
   * default: the pre-flip token shape, which the tool's logout must degrade
   * on (sid-less hints hard-fail at the end-session endpoint).
   */
  idTokenSid?: string | undefined;
}

export interface HubUserFixture {
  sub: string;
  email: string;
  emailVerified?: boolean | undefined;
  name?: string | undefined;
  /** The user's (first) hub org — seeded into the org registry at mintCode. */
  workspaceId: string;
  role: string;
  /** Org display name; set null to simulate a hub without names. */
  workspaceName?: string | null | undefined;
  overrides?: HubTokenOverrides | undefined;
}

/** One entry of a user's org registry (what GET /orgs serves). */
export interface HubOrgEntry {
  name: string | null;
  role: string;
  status?: 'active' | 'suspended' | undefined;
  isDefault?: boolean | undefined;
}

interface HubKey {
  kid: string;
  privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
  publicJwk: JWK;
}

interface AccessTokenRecord {
  sub: string;
  aud: string[];
  expMs: number;
}

interface RefreshTokenRecord {
  sub: string;
  clientId: string;
  family: string;
  rotatedOut: boolean;
}

export class FakeHub {
  readonly codes = new Map<string, HubUserFixture>();
  /** Body of the most recent token request — pins the `resource` passthrough. */
  lastTokenRequest: URLSearchParams | null = null;

  /** sub → orgId → entry: the caller-scoped truth GET /orgs serves. */
  private readonly userOrgs = new Map<string, Map<string, HubOrgEntry>>();
  /** Every JWT access token this fake minted (bearer lookup for /api/v1). */
  private readonly accessTokens = new Map<string, AccessTokenRecord>();
  /** Live + rotated-out refresh tokens (rotation families). */
  private readonly refreshTokens = new Map<string, RefreshTokenRecord>();
  /** Families torn down by reuse detection (or `revokeGrants`). */
  private readonly deadFamilies = new Set<string>();

  // ── Failure injection ─────────────────────────────────────────────────
  /** GET /api/v1/orgs behavior. */
  orgsMode: 'ok' | 'http500' | 'network' = 'ok';
  /** Hold every /orgs answer this long (single-flight/race tests). */
  orgsDelayMs = 0;
  /**
   * Token endpoint behavior (both grants). `hang` never answers (the request
   * is parked, nothing consumed); `commit_then_hang` consumes the presented
   * refresh token — rotation committed hub-side — and THEN never answers.
   */
  tokenMode: 'ok' | 'http500' | 'network' | 'invalid_grant' | 'invalid_client' | 'hang' | 'commit_then_hang' =
    'ok';
  /** Hold every token answer this long (refresh-race tests). */
  tokenDelayMs = 0;
  /** How long a `hang` / `commit_then_hang` request is parked before the fake gives up on it. */
  tokenHangMs = 30_000;
  /** Introspection endpoint behavior. */
  introspectMode: 'ok' | 'http500' | 'network' = 'ok';
  /** Lifetime of newly minted access tokens (seconds). */
  accessTokenTtlSeconds = 900;

  /** Every /api/v1/orgs request: the presented Authorization header. */
  readonly orgsRequests: Array<{ auth: string | null }> = [];
  /** Every refresh-grant presentation (single-flight/rotation pins). */
  readonly refreshRequests: Array<{
    refreshToken: string;
    resource: string | null;
    clientId: string | null;
  }> = [];
  /** Every introspection call (the grant service's probe pins). */
  readonly introspectRequests: Array<{ token: string; hint: string | null; clientId: string | null }> = [];

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

  /** The hub's own API resource identifier — the aud /api/v1 requires. */
  get apiResource(): string {
    return `${this.issuer}/mcp`;
  }

  // ── The org registry (what GET /orgs serves per sub) ──────────────────

  setUserOrg(sub: string, orgId: string, entry: HubOrgEntry): void {
    let orgs = this.userOrgs.get(sub);
    if (!orgs) {
      orgs = new Map();
      this.userOrgs.set(sub, orgs);
    }
    orgs.set(orgId, entry);
  }

  removeUserOrg(sub: string, orgId: string): void {
    this.userOrgs.get(sub)?.delete(orgId);
  }

  clearUserOrgs(sub: string): void {
    this.userOrgs.delete(sub);
  }

  /**
   * The hub-side "revoke this tool's access" action: tears down the user's
   * refresh families AND forgets their live access tokens (emulating expiry
   * — real JWTs die at their 15-minute exp; tests shouldn't wait).
   */
  revokeGrants(sub: string): void {
    for (const [, record] of this.refreshTokens) {
      if (record.sub === sub) this.deadFamilies.add(record.family);
    }
    for (const [token, record] of this.accessTokens) {
      if (record.sub === sub) this.accessTokens.delete(token);
    }
  }

  /** Number of refresh-grant presentations seen so far (single-flight pins). */
  /** Whether reuse detection (or `revokeGrants`) tore this (sub, client) family down. */
  isFamilyDead(sub: string, clientId = 'tool-slideless-cloud'): boolean {
    return this.deadFamilies.has(`${sub}:${clientId}`);
  }

  refreshCount(): number {
    return this.refreshRequests.length;
  }

  /** Register a one-shot authorization code for the given user fixture. */
  mintCode(fixture: HubUserFixture): string {
    const code = `code_${randomUUID()}`;
    this.codes.set(code, fixture);
    return code;
  }

  /** Sign an access token directly (no HTTP dance); recorded as a live bearer. */
  async signAccessToken(fixture: HubUserFixture, resource: string): Promise<string> {
    return this.accessToken(fixture, resource);
  }

  /**
   * Sign an H3 exchange token — what the real hub's `POST /sso/tool-token`
   * mints for `slideless /sso/cli-connect` (the P5 pinned contract): a
   * 120 s RS256 JWT, `aud` = the TOOL's resource URL (single string, no
   * userinfo entry — this is not an OIDC access token), the transitional
   * org-claims payload (Slideless must IGNORE it — suites prove nothing
   * reads it), `purpose: 'sso-connect'`, and a unique `jti`. Like the real
   * H3 response, a `hubRefreshToken` rides along: a RAW one-time
   * offline-grant refresh token in the ordinary (sub, client) rotation
   * family — redeemable at this fake's token endpoint under the TOOL
   * CLIENT's credentials, rotation + reuse detection included. And like
   * the real hub (whose H3 mint proves a live membership of the target
   * org), the fixture's org is seeded into the sub's registry so a
   * subsequent as-the-user `GET /orgs` asserts it. `opts` bends the
   * connect-specific claims for negative tests; `fixture.overrides` still
   * bends iss/exp/aud like everywhere else.
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
  ): Promise<{ token: string; jti: string; hubRefreshToken: string }> {
    const key = this.signingKey();
    const o = fixture.overrides ?? {};
    const now = Math.floor(Date.now() / 1000);
    const jti = opts.jti ?? `jti_${randomUUID()}`;
    const purpose = opts.purpose === undefined ? 'sso-connect' : opts.purpose;
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
    // The org registry mirror of the real H3 membership precondition —
    // registry-level extras survive, exactly like the code-exchange seed.
    const previous = this.userOrgs.get(fixture.sub)?.get(fixture.workspaceId);
    this.setUserOrg(fixture.sub, fixture.workspaceId, {
      name: fixture.workspaceName === null ? null : (fixture.workspaceName ?? 'Fake Org'),
      role: fixture.role,
      ...(previous?.status !== undefined ? { status: previous.status } : {}),
      ...(previous?.isDefault !== undefined ? { isDefault: previous.isDefault } : {})
    });
    // A fresh H3 exchange is a FRESH grant, like a fresh consent: a past
    // reuse-detection teardown must not shadow a new connect.
    this.deadFamilies.delete(`${fixture.sub}:tool-slideless-cloud`);
    const hubRefreshToken = this.mintRefreshToken(fixture.sub, 'tool-slideless-cloud');
    return { token, jti, hubRefreshToken };
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
        // RP-initiated logout (SL-2): the real hub's oauth-provider plugin
        // advertises this once end-session ships; the tool discovers it here
        // and builds ?id_token_hint&post_logout_redirect_uri URLs against it.
        end_session_endpoint: `${this.issuer}/api/v1/auth/oauth2/end-session`,
        code_challenge_methods_supported: ['S256'],
        id_token_signing_alg_values_supported: ['RS256']
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/v1/auth/jwks') {
      return sendJson(res, 200, { keys: this.keys.map((k) => ({ ...k.publicJwk, kid: k.kid })) });
    }
    if (req.method === 'GET' && url.pathname === '/api/v1/orgs') {
      return this.handleOrgs(req, res);
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/auth/oauth2/token') {
      return this.handleToken(req, res);
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/auth/oauth2/introspect') {
      return this.handleIntrospect(req, res);
    }
    sendJson(res, 404, { error: 'not_found' });
  }

  // ── GET /api/v1/orgs: the caller-scoped org list ──────────────────────
  private async handleOrgs(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.orgsRequests.push({ auth: req.headers.authorization ?? null });
    if (this.orgsDelayMs > 0) await new Promise((r) => setTimeout(r, this.orgsDelayMs));
    if (this.orgsMode === 'network') {
      req.destroy(); // mid-request connection failure, no HTTP answer
      return;
    }
    if (this.orgsMode === 'http500') return sendJson(res, 500, { error: { code: 'internal' } });
    const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1] ?? null;
    const record = bearer ? this.accessTokens.get(bearer) : undefined;
    // The real hub's OauthJwtVerifier: JWT it minted, unexpired, aud pinned
    // to ITS OWN resource. An opaque/unknown/expired/foreign-aud bearer is
    // one uniform 401 — exactly what a tool-audienced token gets.
    if (!record || record.expMs <= Date.now() || !record.aud.includes(this.apiResource)) {
      return sendJson(res, 401, { error: { code: 'invalid_token', message: 'Unauthorized' } });
    }
    const orgs = [...(this.userOrgs.get(record.sub) ?? new Map<string, HubOrgEntry>())].map(
      ([id, entry]) => ({
        id,
        name: entry.name,
        role: entry.role,
        personal: false,
        status: entry.status ?? 'active',
        isDefault: entry.isDefault ?? false,
        createdAt: new Date(0).toISOString()
      })
    );
    return sendJson(res, 200, { orgs });
  }

  // ── POST /api/v1/auth/oauth2/token: both grants ───────────────────────
  private async handleToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = new URLSearchParams(await readBody(req));
    this.lastTokenRequest = body;
    if (this.tokenDelayMs > 0) await new Promise((r) => setTimeout(r, this.tokenDelayMs));
    if (this.tokenMode === 'network') {
      req.destroy();
      return;
    }
    if (this.tokenMode === 'http500') return sendJson(res, 500, { error: { code: 'internal' } });
    if (this.tokenMode === 'invalid_grant') {
      return sendJson(res, 400, { error: 'invalid_grant', error_description: 'injected' });
    }
    if (this.tokenMode === 'invalid_client') {
      return sendJson(res, 401, { error: 'invalid_client', error_description: 'injected' });
    }
    if (this.tokenMode === 'hang') return this.park(res);

    const grantType = body.get('grant_type') ?? (body.get('code') ? 'authorization_code' : '');
    if (grantType === 'refresh_token') return this.handleRefreshGrant(body, res);

    const fixture = this.codes.get(body.get('code') ?? '');
    if (!fixture) {
      return sendJson(res, 400, { error: 'invalid_grant', error_description: 'unknown code' });
    }
    this.codes.delete(body.get('code')!); // one-shot, like the real thing
    // The code's fixture seeds the sub's org registry (the hub knows the
    // orgs its own users SSO from) — name/role from the fixture, while the
    // registry-level extras (`status`, `isDefault` — managed via
    // `setUserOrg`) survive a re-login's re-seed.
    const previous = this.userOrgs.get(fixture.sub)?.get(fixture.workspaceId);
    this.setUserOrg(fixture.sub, fixture.workspaceId, {
      name: fixture.workspaceName === null ? null : (fixture.workspaceName ?? 'Fake Org'),
      role: fixture.role,
      ...(previous?.status !== undefined ? { status: previous.status } : {}),
      ...(previous?.isDefault !== undefined ? { isDefault: previous.isDefault } : {})
    });
    const clientId = body.get('client_id') ?? 'tool-slideless-cloud';
    // A fresh code exchange is a FRESH grant: the real hub's new consent
    // mints a new family — a past reuse-detection teardown does not shadow
    // a re-login (the hub_grant_expired → browser-re-login heal path).
    this.deadFamilies.delete(`${fixture.sub}:${clientId}`);
    const resource = body.get('resource');
    // JWT iff the token request carries `resource` (checkResource →
    // isJwtAccessToken on the real hub); otherwise opaque.
    const accessToken =
      resource && !fixture.overrides?.forceOpaque
        ? await this.accessToken(fixture, resource)
        : `opaque_${randomUUID()}`;
    const refreshToken = this.mintRefreshToken(fixture.sub, clientId);
    return sendJson(res, 200, {
      access_token: accessToken,
      id_token: await this.idToken(fixture, clientId),
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: fixture.overrides?.expiresInSeconds ?? this.accessTokenTtlSeconds,
      scope: 'openid profile email offline_access account:read'
    });
  }

  private handleRefreshGrant(body: URLSearchParams, res: ServerResponse): void {
    const presented = body.get('refresh_token') ?? '';
    const clientId = body.get('client_id');
    this.refreshRequests.push({
      refreshToken: presented,
      resource: body.get('resource'),
      clientId
    });
    if (!clientId || !body.get('client_secret')) {
      return sendJson(res, 401, { error: 'invalid_client', error_description: 'client auth required' });
    }
    const record = this.refreshTokens.get(presented);
    if (!record) {
      return sendJson(res, 400, { error: 'invalid_grant', error_description: 'unknown refresh token' });
    }
    if (this.deadFamilies.has(record.family)) {
      return sendJson(res, 400, { error: 'invalid_grant', error_description: 'grant family revoked' });
    }
    if (record.rotatedOut) {
      // RFC 9700 REUSE DETECTION: presenting a rotated-out token is treated
      // as theft — the WHOLE (sub, client) family dies, current token
      // included. The single most important behavior this fake models.
      this.deadFamilies.add(record.family);
      return sendJson(res, 400, {
        error: 'invalid_grant',
        error_description: 'reuse detected — family revoked'
      });
    }
    record.rotatedOut = true;
    const rotated = this.mintRefreshToken(record.sub, record.clientId);
    // The slow-but-alive hub: the rotation above is committed and the
    // answer never leaves. Whoever presented `presented` now holds a
    // rotated-out token without knowing it.
    if (this.tokenMode === 'commit_then_hang') return this.park(res);
    const resource = body.get('resource');
    const respond = async () => {
      const accessToken = resource
        ? await this.accessToken(
            { sub: record.sub, email: 'refresh@fake.hub', workspaceId: '', role: 'member' },
            resource
          )
        : `opaque_${randomUUID()}`;
      sendJson(res, 200, {
        access_token: accessToken,
        refresh_token: rotated,
        token_type: 'Bearer',
        expires_in: this.accessTokenTtlSeconds,
        scope: 'openid profile email offline_access account:read'
      });
    };
    void respond();
  }

  /** Never answer; give up with a 504 long after any client timeout (nothing observes it). */
  private park(res: ServerResponse): void {
    const t = setTimeout(() => {
      if (!res.writableEnded) sendJson(res, 504, { error: 'parked' });
    }, this.tokenHangMs);
    t.unref();
  }

  // ── POST /api/v1/auth/oauth2/introspect: RFC 7662, read-only ──────────
  private async handleIntrospect(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = new URLSearchParams(await readBody(req));
    const token = body.get('token') ?? '';
    const clientId = body.get('client_id');
    this.introspectRequests.push({ token, hint: body.get('token_type_hint'), clientId });
    if (this.introspectMode === 'network') {
      req.destroy();
      return;
    }
    if (this.introspectMode === 'http500') return sendJson(res, 500, { error: { code: 'internal' } });
    if (!clientId || !body.get('client_secret')) {
      return sendJson(res, 401, { error: 'invalid_client', error_description: 'client auth required' });
    }
    // Refresh tokens only (the grant service's probe always hints it); an
    // access token is out of scope for this fake's introspection.
    const record = this.refreshTokens.get(token);
    if (
      !record ||
      record.clientId !== clientId ||
      record.rotatedOut ||
      this.deadFamilies.has(record.family)
    ) {
      return sendJson(res, 200, { active: false });
    }
    return sendJson(res, 200, {
      active: true,
      client_id: clientId,
      sub: record.sub,
      token_type: 'refresh_token'
    });
  }

  private mintRefreshToken(sub: string, clientId: string): string {
    const token = `rt_${randomUUID()}`;
    this.refreshTokens.set(token, { sub, clientId, family: `${sub}:${clientId}`, rotatedOut: false });
    return token;
  }

  private signingKey(): HubKey {
    const key = this.keys[0];
    if (!key) throw new Error('fake hub has no signing key');
    return key;
  }

  private async accessToken(fixture: HubUserFixture, resource: string): Promise<string> {
    const key = this.signingKey();
    const o = fixture.overrides ?? {};
    const rawAud = o.accessAud ?? [resource, `${this.issuer}/api/v1/auth/oauth2/userinfo`];
    const aud = Array.isArray(rawAud) ? rawAud : [rawAud];
    const now = Math.floor(Date.now() / 1000);
    const exp = now + (o.expiresInSeconds ?? this.accessTokenTtlSeconds);
    const token = await new SignJWT({
      // TRANSITIONAL advisory org claims (compat window) — never read by
      // the new login path; suites prove it.
      role: fixture.role,
      ...(fixture.workspaceId ? { workspace_id: fixture.workspaceId } : {}),
      ...(fixture.workspaceName === null ? {} : { workspace_name: fixture.workspaceName ?? 'Fake Org' }),
      email: fixture.email,
      azp: 'tool-slideless-cloud',
      scope: 'openid profile email offline_access account:read',
      aud
    })
      .setProtectedHeader({ alg: 'RS256', kid: key.kid })
      .setSubject(fixture.sub)
      .setIssuer(o.iss ?? this.issuer)
      .setIssuedAt(now)
      .setExpirationTime(exp)
      .sign(key.privateKey);
    // Recorded so /api/v1/orgs can resolve the bearer to its subject —
    // with the REAL exp/aud so wrong-audience and expiry refuse honestly.
    this.accessTokens.set(token, { sub: fixture.sub, aud, expMs: exp * 1000 });
    return token;
  }

  private async idToken(fixture: HubUserFixture, clientId: string): Promise<string> {
    const key = this.signingKey();
    const o = fixture.overrides ?? {};
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      name: fixture.name ?? 'Fake Hub User',
      email: fixture.email,
      email_verified: fixture.emailVerified ?? true,
      ...(o.idTokenSid ? { sid: o.idTokenSid } : {}),
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
