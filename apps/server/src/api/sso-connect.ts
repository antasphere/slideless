import type { OpenAPIHono } from '@hono/zod-openapi';
import { eq, lt, sql } from 'drizzle-orm';
import { ssoCliConnectRoute } from '@slideless/contract/routes';
import { apiKeys as apiKeysTable, ssoConnectJtis, type Db } from '@slideless/db';
import type { Auth } from '../identity/better-auth.js';
import { HubSsoLoginError, type HubConnectAssertion, type HubSsoService } from '../identity/hub-sso.js';
import type { ApiKeyService } from '../apikeys/service.js';
import type { AuditService } from '../audit/service.js';
import type { Logger } from '../logger.js';
import { CLI_KEY_SCOPES } from './cli-auth.js';

const err = (code: string, message: string) => ({ error: { code, message } });

/**
 * CLI cross-tool connect (cloud edition ONLY — docs/federation.md P5):
 *
 *   POST /sso/cli-connect → verify a hub-minted 120 s exchange JWT (the H3
 *   counterpart), JIT-provision exactly like an SSO login, mint an `slk_` key
 *
 * PUBLIC path (the hub JWT IS the credential — the invitation-lookup /
 * cli-auth tier-2 pattern), rate-limited on the login wall (api/index.ts),
 * and registered by api/index.ts ONLY when the instance boots EDITION=cloud
 * — an oss boot never mounts this module, so the path answers the JSON 404
 * terminator there (zero hub surface, matching every other cloud seam).
 *
 * Because the endpoint is public, verification discipline is the whole
 * game (a replayable exchange token mints N keys):
 *
 *  - the token passes `HubSsoService.verifyConnectToken` — hub-JWKS
 *    signature, iss pinned to the hub, aud pinned to OUR resource URL,
 *    RS256 only, expiry, `purpose: 'sso-connect'` required, `jti` required;
 *  - the `jti` is consumed ONE-TIME-USE via an INSERT into the Postgres
 *    `sso_connect_jtis` ledger — the primary-key conflict IS the replay
 *    signal, multi-replica safe by construction (finding G8). Claim-first
 *    discipline: the jti is burned BEFORE provisioning, so two concurrent
 *    presentations of one token can never both reach the mint (a
 *    transient provisioning failure costs the caller one fresh hub
 *    exchange — cheap, and the safe side of the race);
 *  - every verification failure (signature, iss, aud, purpose, expiry,
 *    replay) answers ONE uniform 401 — no oracle for probing tokens.
 *
 * On success the user is provisioned through the SAME HubSsoService path as
 * a browser SSO login (JIT user via the internal adapter — the user.created
 * hook and collaborator sweep fire — plus D9 trusted link, D10 email sync,
 * lazy org projection, origin='hub' membership upsert with the asserted
 * role), and the minted key is an ordinary `slk_` key bound to the ONE
 * projected workspace, scopes presentations:read + presentations:write —
 * NEVER data:export (the CLI_KEY_SCOPES grant, same as /cli/auth/complete).
 * The audit row is written directly (principal-less public route), exactly
 * like /cli/auth/complete's.
 */

export interface SsoConnectRouteDeps {
  db: Db;
  auth: Auth;
  hubSso: HubSsoService;
  apiKeys: ApiKeyService;
  audit: AuditService;
  logger: Logger;
}

export function registerSsoConnectRoutes(api: OpenAPIHono, deps: SsoConnectRouteDeps): void {
  const { db, auth, hubSso, apiKeys, audit, logger } = deps;

  api.openapi(ssoCliConnectRoute, async (c) => {
    const body = c.req.valid('json');

    // 1. Verify hard. One uniform 401 for every rejection reason.
    let assertion: HubConnectAssertion;
    try {
      assertion = await hubSso.verifyConnectToken(body.token);
    } catch (cause) {
      logger.warn({ err: cause }, 'sso cli-connect: exchange token rejected');
      return c.json(err('invalid_token', 'The exchange token is invalid, expired, or already used'), 401);
    }

    // 2. Burn the jti (one-time-use, G8). Insert-first: the claim precedes
    // any effect, so a replay — even a concurrent one — mints nothing. The
    // sweep keeps the ledger tiny; best-effort, never correctness-bearing
    // (expired rows only shadow jtis of already-expired tokens).
    void db
      .delete(ssoConnectJtis)
      .where(lt(ssoConnectJtis.expiresAt, sql`now() - interval '1 minute'`))
      .catch(() => {});
    const claimed = await db
      .insert(ssoConnectJtis)
      .values({ jti: assertion.jti, expiresAt: assertion.expiresAt })
      .onConflictDoNothing()
      .returning({ jti: ssoConnectJtis.jti });
    if (claimed.length === 0) {
      logger.warn({ jti: assertion.jti }, 'sso cli-connect: replayed jti rejected');
      return c.json(err('invalid_token', 'The exchange token is invalid, expired, or already used'), 401);
    }

    // 3. JIT-provision through the SSO projection path (identical rows).
    let provisioned: Awaited<ReturnType<HubSsoService['provisionConnect']>>;
    try {
      provisioned = await hubSso.provisionConnect(auth, assertion);
    } catch (cause) {
      if (cause instanceof HubSsoLoginError) {
        logger.warn({ err: cause, code: cause.code }, 'sso cli-connect: provisioning refused');
        return c.json(err(cause.code, 'Could not provision this account on the instance'), 403);
      }
      logger.error({ err: cause }, 'sso cli-connect: provisioning failed');
      return c.json(err('internal', 'Connect failed — try again'), 500);
    }
    const { user, workspaceId } = provisioned;

    // 4. Mint the ordinary local key, bound to the projected workspace.
    const name = `Antasphere CLI ${new Date().toISOString().slice(0, 10)}`;
    const minted = await apiKeys.mint({
      workspaceId,
      createdBy: user.id,
      name,
      scopes: [...CLI_KEY_SCOPES],
      expiresAt: null
    });
    const [row] = await db.select().from(apiKeysTable).where(eq(apiKeysTable.id, minted.id)).limit(1);
    if (!row) {
      return c.json(err('internal', 'Key mint failed — try again'), 500);
    }

    // Principal-less public route: the audit middleware cannot attribute it —
    // write the row directly, exactly like /cli/auth/complete does.
    await audit.write({
      workspaceId,
      principal: { userId: user.id, via: 'session' },
      action: 'apikey.create',
      resourceType: 'api_key',
      resourceId: minted.id,
      requestId: c.get('requestId'),
      metadata: {
        name,
        scopes: [...CLI_KEY_SCOPES],
        via: 'sso_cli_connect',
        hubSub: assertion.sub,
        hubWorkspaceId: assertion.hubWorkspaceId
      }
    });

    return c.json(
      {
        key: minted.key,
        apiKey: {
          id: row.id,
          name: row.name,
          keyId: row.keyId,
          scopes: row.scopes as Array<'presentations:read' | 'presentations:write' | 'data:export'>,
          workspaceId: row.workspaceId,
          createdBy: row.createdBy,
          createdAt: row.createdAt.toISOString(),
          lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
          revokedAt: row.revokedAt?.toISOString() ?? null,
          expiresAt: row.expiresAt?.toISOString() ?? null
        },
        user,
        workspaceId
      },
      201
    );
  });
}
