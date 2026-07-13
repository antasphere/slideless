import { describe, expect, it } from 'vitest';
import { HUB_TOOL, saveConfig as saveCoreConfig } from '@antasphere/cli-core';
import { run } from '../src/index.js';
import { loadConfig, saveConfig } from '../src/config.js';
import { routedHarness, tempConfigEnv, type Route } from './harness.js';

/**
 * The cross-tool connect flow (cli-core binding patterns §7): one
 * `antasphere login` serves the Slideless CLI on a CLOUD instance — on a
 * cache miss the hub key is exchanged for a tool-local slk_ key, cached per
 * (tool, hub org). Everything here runs against the routed fake fetch on
 * two origins (http://hub / http://tool) with an isolated XDG_CONFIG_HOME;
 * the real flow runs in the federation E2E gate.
 *
 * The invariants under test: oss/direct-key resolution is byte-identical to
 * before (no discovery beyond the probe, no hub call), the hub key is sent
 * to the hub ONLY, and the minted slk_ key never travels to the hub.
 */

const HUB_KEY = 'ant_hubkey12_secretsecretsecret1234';
const SLK = 'slk_minted12_0123456789abcdefghijklmnopqrstuvwxyz';

const CLOUD_INSTANCE = {
  name: 'Slideless Cloud',
  instanceId: 'i1',
  edition: 'cloud',
  version: '1.0.0',
  apiVersion: 'v1',
  setupRequired: false,
  auth: {
    methods: ['antasphere', 'api-key', 'oauth'],
    passwordReset: false,
    emailChange: false,
    twoFactor: false
  },
  features: { mcp: true, oauth: true, files: true }
};
const OSS_INSTANCE = {
  ...CLOUD_INSTANCE,
  name: 'Selfhosted',
  edition: 'oss',
  auth: { ...CLOUD_INSTANCE.auth, methods: ['password', 'email-otp', 'api-key', 'oauth'] }
};

const instanceRoute = (info: unknown): Route => ({
  method: 'GET',
  path: /\/api\/v1\/instance$/,
  reply: () => ({ body: info })
});

const decksRoute: Route = {
  method: 'GET',
  path: /\/api\/v1\/presentations$/,
  reply: () => ({ body: { presentations: [], nextCursor: null } })
};

const MINTED_META = {
  id: '44444444-4444-4444-4444-444444444444',
  name: 'Antasphere connect 2026-07-13',
  keyId: 'minted12',
  scopes: ['presentations:read', 'presentations:write'],
  createdBy: 'u1',
  createdAt: '2026-07-13T00:00:00.000Z',
  lastUsedAt: null,
  revokedAt: null,
  expiresAt: null
};

/** The hub + tool exchange pair; tokens are sequenced so a retry is provable. */
function exchangeRoutes(opts: { failConnect?: 'first' | 'always' } = {}): Route[] {
  let tokenSeq = 0;
  let connectSeq = 0;
  return [
    {
      method: 'POST',
      path: /\/api\/v1\/sso\/tool-token$/,
      reply: ({ body }) => ({
        body: {
          token: `jwt-${++tokenSeq}`,
          expiresAt: '2026-07-13T00:02:00.000Z',
          workspaceId: (body as { workspaceId?: string }).workspaceId ?? 'org1'
        }
      })
    },
    {
      method: 'POST',
      path: /\/api\/v1\/sso\/cli-connect$/,
      reply: () => {
        connectSeq += 1;
        if (opts.failConnect === 'always' || (opts.failConnect === 'first' && connectSeq === 1)) {
          return { status: 401, body: { error: { code: 'invalid_token', message: 'token expired' } } };
        }
        return {
          status: 201,
          body: {
            key: SLK,
            apiKey: MINTED_META,
            user: { id: 'u1', email: 'ada@x.co', name: 'Ada' },
            workspaceId: 'tws1'
          }
        };
      }
    }
  ];
}

/** What `antasphere login` leaves behind: a hub profile with key + bound org. */
function seedHubLogin(env: Record<string, string>, workspaceId = 'org1'): void {
  saveCoreConfig(env, HUB_TOOL, {
    activeProfile: 'default',
    profiles: { default: { apiKey: HUB_KEY, baseUrl: 'http://hub', email: 'ada@x.co', workspaceId } }
  });
}

describe('cross-tool connect (hub → slk_ exchange)', () => {
  it('a direct key wins outright: no discovery, no hub call, even with a hub login present', async () => {
    const env = await tempConfigEnv();
    seedHubLogin(env);
    const h = routedHarness([decksRoute], env);
    const code = await run(['list', '--api-url', 'http://tool', '--api-key', 'slk_direct_key'], h.io);
    expect(h.err()).toBe('');
    expect(code).toBe(0);
    expect(h.wire).toEqual([
      {
        method: 'GET',
        origin: 'http://tool',
        path: '/api/v1/presentations',
        auth: 'Bearer slk_direct_key'
      }
    ]);
  });

  it('an oss instance without a key keeps the classic error: one anonymous probe, nothing else', async () => {
    const env = await tempConfigEnv();
    seedHubLogin(env); // present but must never be consulted for oss
    const h = routedHarness([instanceRoute(OSS_INSTANCE)], env);
    const code = await run(['list', '--api-url', 'http://tool'], h.io);
    expect(code).toBe(1);
    expect(h.err()).toContain('API key is required');
    expect(h.wire).toEqual([
      { method: 'GET', origin: 'http://tool', path: '/api/v1/instance', auth: undefined }
    ]);
  });

  it('cloud + cache miss + hub login: one exchange, cached per (tool, org), replayed next run', async () => {
    const env = await tempConfigEnv();
    seedHubLogin(env, 'org1');
    const h = routedHarness([instanceRoute(CLOUD_INSTANCE), ...exchangeRoutes(), decksRoute], env);
    const code = await run(['list', '--json', '--api-url', 'http://tool'], h.io);
    expect(code).toBe(0);
    expect(h.calls.map((c) => c.path)).toEqual([
      '/api/v1/instance',
      '/api/v1/sso/tool-token',
      '/api/v1/sso/cli-connect',
      '/api/v1/presentations'
    ]);

    // The hub key goes to the hub ONLY; the minted slk_ never visits the hub.
    const toolToken = h.wire.find((w) => w.path.endsWith('/sso/tool-token'))!;
    expect(toolToken.origin).toBe('http://hub');
    expect(toolToken.auth).toBe(`Bearer ${HUB_KEY}`);
    expect(toolToken.body).toEqual({ resource: 'http://tool/mcp', workspaceId: 'org1' });
    const cliConnect = h.wire.find((w) => w.path.endsWith('/sso/cli-connect'))!;
    expect(cliConnect.origin).toBe('http://tool');
    expect(cliConnect.auth).toBeUndefined(); // the JWT in the body IS the credential
    expect(cliConnect.body).toEqual({ token: 'jwt-1' });
    const decks = h.wire.find((w) => w.path.endsWith('/presentations'))!;
    expect(decks.origin).toBe('http://tool');
    expect(decks.auth).toBe(`Bearer ${SLK}`);
    for (const w of h.wire) {
      if (w.origin !== 'http://hub') expect(w.auth ?? '').not.toContain(HUB_KEY);
      if (w.origin === 'http://hub') expect(w.auth ?? '').not.toContain(SLK);
    }

    // stdout stays machine-clean under --json; the connect notice is stderr.
    expect(JSON.parse(h.out())).toEqual({ presentations: [], nextCursor: null });
    expect(h.err()).toContain('Connected to http://tool as ada@x.co');

    // Cached per (tool, hub org) + the fresh profile pinned to the instance.
    const cfg = loadConfig(env);
    expect(cfg.activeProfile).toBe('default');
    expect(cfg.profiles.default?.baseUrl).toBe('http://tool');
    expect(cfg.profiles.default?.apiKey).toBeUndefined(); // the legacy slot is untouched
    expect(cfg.profiles.default?.workspaceKeys?.org1).toMatchObject({
      apiKey: SLK,
      toolWorkspaceId: 'tws1',
      email: 'ada@x.co'
    });

    // Second invocation: no flags, no discovery, no hub — the cache serves.
    const h2 = routedHarness([decksRoute], env);
    const code2 = await run(['list'], h2.io);
    expect(h2.err()).toBe('');
    expect(code2).toBe(0);
    expect(h2.wire).toEqual([
      { method: 'GET', origin: 'http://tool', path: '/api/v1/presentations', auth: `Bearer ${SLK}` }
    ]);
  });

  it('--org selects a cached key for that org (no exchange)', async () => {
    const env = await tempConfigEnv();
    seedHubLogin(env, 'org1'); // active org is org1 …
    saveConfig(env, {
      activeProfile: 'default',
      profiles: { default: { baseUrl: 'http://tool', workspaceKeys: { org2: { apiKey: 'slk_org2_key' } } } }
    });
    const h = routedHarness([decksRoute], env);
    const code = await run(['list', '--org', 'org2'], h.io); // … but --org overrides it
    expect(h.err()).toBe('');
    expect(code).toBe(0);
    expect(h.wire).toEqual([
      { method: 'GET', origin: 'http://tool', path: '/api/v1/presentations', auth: 'Bearer slk_org2_key' }
    ]);
  });

  it('--org targets the exchange when that org has no cached key yet', async () => {
    const env = await tempConfigEnv();
    seedHubLogin(env, 'org1');
    const h = routedHarness([instanceRoute(CLOUD_INSTANCE), ...exchangeRoutes(), decksRoute], env);
    const code = await run(['list', '--api-url', 'http://tool', '--org', 'org3'], h.io);
    expect(code).toBe(0);
    const toolToken = h.wire.find((w) => w.path.endsWith('/sso/tool-token'))!;
    expect(toolToken.body).toEqual({ resource: 'http://tool/mcp', workspaceId: 'org3' });
    expect(loadConfig(env).profiles.default?.workspaceKeys?.org3?.apiKey).toBe(SLK);
  });

  it('cloud + no hub login points at `antasphere login` after the single probe', async () => {
    const env = await tempConfigEnv();
    const h = routedHarness([instanceRoute(CLOUD_INSTANCE)], env);
    const code = await run(['list', '--api-url', 'http://tool'], h.io);
    expect(code).toBe(1);
    expect(h.err()).toContain('antasphere login');
    expect(h.calls.map((c) => c.path)).toEqual(['/api/v1/instance']);
  });

  it('a hub-rejected key maps to the fresh-login guidance (no tool call)', async () => {
    const env = await tempConfigEnv();
    seedHubLogin(env);
    const h = routedHarness(
      [
        instanceRoute(CLOUD_INSTANCE),
        {
          method: 'POST',
          path: /\/api\/v1\/sso\/tool-token$/,
          reply: () => ({ status: 401, body: { error: { code: 'unauthenticated', message: 'bad key' } } })
        }
      ],
      env
    );
    const code = await run(['list', '--api-url', 'http://tool'], h.io);
    expect(code).toBe(1);
    expect(h.err()).toContain('antasphere login');
    expect(h.calls.map((c) => c.path)).toEqual(['/api/v1/instance', '/api/v1/sso/tool-token']);
  });

  it('a tool-rejected JWT triggers exactly one fresh exchange (new token), then succeeds', async () => {
    const env = await tempConfigEnv();
    seedHubLogin(env, 'org1');
    const h = routedHarness(
      [instanceRoute(CLOUD_INSTANCE), ...exchangeRoutes({ failConnect: 'first' }), decksRoute],
      env
    );
    const code = await run(['list', '--api-url', 'http://tool'], h.io);
    expect(code).toBe(0);
    expect(h.calls.map((c) => c.path)).toEqual([
      '/api/v1/instance',
      '/api/v1/sso/tool-token',
      '/api/v1/sso/cli-connect',
      '/api/v1/sso/tool-token',
      '/api/v1/sso/cli-connect',
      '/api/v1/presentations'
    ]);
    // The retry re-ran the FULL exchange — a fresh JWT, not a replay.
    const connects = h.wire.filter((w) => w.path.endsWith('/sso/cli-connect'));
    expect(connects.map((w) => w.body)).toEqual([{ token: 'jwt-1' }, { token: 'jwt-2' }]);
  });

  it('a persistently rejected JWT fails after the single retry', async () => {
    const env = await tempConfigEnv();
    seedHubLogin(env, 'org1');
    const h = routedHarness(
      [instanceRoute(CLOUD_INSTANCE), ...exchangeRoutes({ failConnect: 'always' })],
      env
    );
    const code = await run(['list', '--api-url', 'http://tool'], h.io);
    expect(code).toBe(1);
    // Exactly two exchange attempts — no retry loop.
    expect(h.calls.filter((c) => c.path.endsWith('/sso/tool-token'))).toHaveLength(2);
    expect(h.calls.filter((c) => c.path.endsWith('/sso/cli-connect'))).toHaveLength(2);
    expect(loadConfig(env).profiles.default?.workspaceKeys).toBeUndefined();
  });

  it('per-org logout revokes the cached key server-side and evicts only that org', async () => {
    const env = await tempConfigEnv();
    seedHubLogin(env, 'org1');
    saveConfig(env, {
      activeProfile: 'default',
      profiles: {
        default: {
          baseUrl: 'http://tool',
          workspaceKeys: { org1: { apiKey: 'slk_one_key' }, org2: { apiKey: 'slk_two_key' } }
        }
      }
    });
    const revokeRoute: Route = {
      method: 'DELETE',
      path: /\/api\/v1\/cli\/auth\/key$/,
      reply: () => ({ body: { revoked: true, id: 'k1' } })
    };

    // No --org: the active hub org (org1) is the target.
    const h = routedHarness([revokeRoute], env);
    expect(await run(['logout'], h.io)).toBe(0);
    expect(h.wire).toEqual([
      { method: 'DELETE', origin: 'http://tool', path: '/api/v1/cli/auth/key', auth: 'Bearer slk_one_key' }
    ]);
    expect(Object.keys(loadConfig(env).profiles.default?.workspaceKeys ?? {})).toEqual(['org2']);

    // Explicit --org picks the other one; the profile (baseUrl) survives.
    const h2 = routedHarness([revokeRoute], env);
    expect(await run(['logout', '--org', 'org2'], h2.io)).toBe(0);
    expect(h2.wire[0]?.auth).toBe('Bearer slk_two_key');
    const cfg = loadConfig(env);
    expect(cfg.profiles.default?.workspaceKeys).toBeUndefined();
    expect(cfg.profiles.default?.baseUrl).toBe('http://tool');
  });

  it('a 403-refused self-revoke is reported as such — never as "already unusable"', async () => {
    const env = await tempConfigEnv();
    seedHubLogin(env, 'org1');
    saveConfig(env, {
      activeProfile: 'default',
      profiles: { default: { baseUrl: 'http://tool', workspaceKeys: { org1: { apiKey: 'slk_one_key' } } } }
    });
    // The live cloud instance today: /cli/auth/key is not on the machine
    // allowlist, so the (perfectly valid) key gets a fail-closed 403.
    const h = routedHarness(
      [
        {
          method: 'DELETE',
          path: /\/api\/v1\/cli\/auth\/key$/,
          reply: () => ({
            status: 403,
            body: { error: { code: 'endpoint_not_allowed', message: 'not available' } }
          })
        }
      ],
      env
    );
    expect(await run(['logout', '--json'], h.io)).toBe(0);
    expect(h.err()).toContain('STAYS VALID');
    expect(h.err()).toContain('endpoint_not_allowed');
    expect(h.err()).not.toContain('already unusable');
    expect(JSON.parse(h.out())).toMatchObject({ org: 'org1', revoked: false, evicted: true });
    expect(loadConfig(env).profiles.default?.workspaceKeys).toBeUndefined();
  });

  it('per-org logout revokes against the profile instance, never a flag/env URL', async () => {
    const env = await tempConfigEnv();
    seedHubLogin(env, 'org1');
    saveConfig(env, {
      activeProfile: 'default',
      profiles: { default: { baseUrl: 'http://tool', workspaceKeys: { org1: { apiKey: 'slk_one_key' } } } }
    });
    const revokeRoute: Route = {
      method: 'DELETE',
      path: /\/api\/v1\/cli\/auth\/key$/,
      reply: () => ({ body: { revoked: true, id: 'k1' } })
    };
    // A stray SLIDELESS_URL (or --api-url) pointing somewhere else must not
    // receive the cached key — the self-revoke belongs to the minting host.
    const h = routedHarness([revokeRoute], { ...env, SLIDELESS_URL: 'http://other' });
    expect(await run(['logout', '--org', 'org1', '--api-url', 'http://elsewhere'], h.io)).toBe(0);
    expect(h.wire).toEqual([
      { method: 'DELETE', origin: 'http://tool', path: '/api/v1/cli/auth/key', auth: 'Bearer slk_one_key' }
    ]);
    expect(loadConfig(env).profiles.default?.workspaceKeys).toBeUndefined();
  });

  it('classic logout is untouched when the profile holds its own key (hub cache preserved)', async () => {
    const env = await tempConfigEnv();
    saveConfig(env, {
      activeProfile: 'default',
      profiles: {
        default: {
          apiKey: 'slk_classic_key',
          baseUrl: 'http://tool',
          workspaceKeys: { org1: { apiKey: 'slk_one_key' } }
        }
      }
    });
    const h = routedHarness([], env);
    expect(await run(['logout'], h.io)).toBe(0);
    expect(h.calls).toHaveLength(0); // classic logout never talks to the network
    const cfg = loadConfig(env);
    expect(cfg.profiles.default?.apiKey).toBeUndefined();
    expect(cfg.profiles.default?.workspaceKeys?.org1?.apiKey).toBe('slk_one_key');
  });

  it('logout of an unconnected org names the connected ones', async () => {
    const env = await tempConfigEnv();
    seedHubLogin(env, 'org9');
    saveConfig(env, {
      activeProfile: 'default',
      profiles: { default: { baseUrl: 'http://tool', workspaceKeys: { org1: { apiKey: 'slk_one_key' } } } }
    });
    const h = routedHarness([], env);
    expect(await run(['logout'], h.io)).toBe(1); // active hub org org9 has no key here
    expect(h.err()).toContain('org9');
    expect(h.err()).toContain('org1');
    expect(loadConfig(env).profiles.default?.workspaceKeys?.org1?.apiKey).toBe('slk_one_key');
  });

  it('a cached cloud key never travels to a different instance named by --api-url', async () => {
    const env = await tempConfigEnv();
    seedHubLogin(env, 'org1');
    saveConfig(env, {
      activeProfile: 'default',
      profiles: { default: { baseUrl: 'http://tool', workspaceKeys: { org1: { apiKey: 'slk_one_key' } } } }
    });
    // Point the SAME profile at another host: the cache must not be replayed
    // there — the probe runs instead (oss ⇒ classic error, no key sent).
    const h = routedHarness([instanceRoute(OSS_INSTANCE)], env);
    const code = await run(['list', '--api-url', 'http://other'], h.io);
    expect(code).toBe(1);
    expect(h.wire).toEqual([
      { method: 'GET', origin: 'http://other', path: '/api/v1/instance', auth: undefined }
    ]);
  });
});
