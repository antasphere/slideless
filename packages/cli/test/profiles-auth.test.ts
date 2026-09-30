import { statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HUB_TOOL, loadConfig as loadCoreConfig } from '@antasphere/cli-core';
import { redactKey } from '@antasphere/chassis-cli';
import { run } from '../src/index.js';
import { cli, loadConfig, saveConfig } from '../src/cli.js';
import { DECK, routedHarness, tempConfigEnv, VERSION_ROW, type Route } from './harness.js';

const { configPath } = cli;

/**
 * Profile resolution + `login` (PRDCT-2947), against a routed fake fetch and an
 * isolated XDG_CONFIG_HOME. The real end-to-end (Mailpit OTP) runs in the
 * server integration suite and the E2E gate.
 */

const ME = {
  user: { id: 'u1', name: 'Ada', email: 'ada@x.co' },
  workspace: { id: 'w1', name: 'Acme' },
  workspaces: [
    {
      id: 'w1',
      name: 'Acme',
      role: 'owner',
      hubOrigin: false,
      centralAccountId: null,
      look: { theme: null, pattern: null, field: null, grain: null },
      suspended: false,
      default: true
    }
  ],
  activeWorkspaceId: 'w1',
  role: 'owner',
  via: 'api_key',
  scopes: ['presentations:read', 'presentations:write'],
  apiKeyExpiresAt: null
};

const MINTED = {
  key: 'slk_abcdefgh_0123456789abcdefghijklmnopqrstuvwxyz012345',
  apiKey: {
    id: '44444444-4444-4444-4444-444444444444',
    name: 'CLI login 2026-07-10',
    keyId: 'abcdefgh',
    scopes: ['presentations:read', 'presentations:write'],
    createdBy: 'u1',
    createdAt: '2026-07-10T00:00:00.000Z',
    lastUsedAt: null,
    revokedAt: null,
    expiresAt: null
  },
  user: { id: 'u1', email: 'ada@x.co', name: 'Ada' },
  workspaceId: 'w1'
};

const meRoute: Route = { method: 'GET', path: /\/api\/v1\/me$/, reply: () => ({ body: ME }) };

/** Discovery payloads for the cloud probe (cloud signs in through Antasphere). */
const instanceInfo = (edition: string, methods: string[]) => ({
  name: 'Inst',
  instanceId: 'i1',
  edition,
  version: '1.0.0',
  apiVersion: 'v1',
  setupRequired: false,
  auth: { methods, passwordReset: true, emailChange: true, twoFactor: true },
  features: { mcp: true, oauth: true, files: true }
});
const ossInstanceRoute: Route = {
  method: 'GET',
  path: /\/api\/v1\/instance$/,
  reply: () => ({ body: instanceInfo('oss', ['password', 'email-otp', 'api-key', 'oauth']) })
};
const cloudInstanceRoute: Route = {
  method: 'GET',
  path: /\/api\/v1\/instance$/,
  reply: () => ({ body: instanceInfo('cloud', ['antasphere', 'api-key', 'oauth']) })
};

describe('login, the Slideless bytes (the generic cases are the chassis suite: login, logout, profiles)', () => {
  /** A scripted prompt: answers in order, questions recorded. */
  function scripted(h: ReturnType<typeof routedHarness>, answers: string[]): string[] {
    const asked: string[] = [];
    h.io.prompt = async (q) => {
      asked.push(q);
      return answers.shift() ?? '';
    };
    return asked;
  }

  const otpRoutes = (key: string, workspaceId: string | null): Route[] => [
    { method: 'POST', path: /\/api\/v1\/cli\/auth\/request$/, reply: () => ({ body: { sent: true } }) },
    {
      method: 'POST',
      path: /\/api\/v1\/cli\/auth\/complete$/,
      reply: () => ({ status: 201, body: { ...MINTED, key, workspaceId } })
    }
  ];

  it('a pasted slk_ key: verified, saved on the instance profile, active', async () => {
    const env = await tempConfigEnv();
    const h = routedHarness([meRoute], env);
    expect(await run(['login', '--api-key', 'slk_paste_key', '--api-url', 'http://inst'], h.io)).toBe(0);
    expect(h.err()).toBe('');
    expect(h.out()).toBe(
      `Signed in as Ada <ada@x.co> in Acme on http://inst.\nKey saved to profile "inst" (${configPath(env)}).\n`
    );
    const config = loadConfig(env);
    expect(config.activeProfile).toBe('inst');
    expect(config.profiles.inst).toEqual({
      apiKey: 'slk_paste_key',
      baseUrl: 'http://inst',
      email: 'ada@x.co'
    });
  });

  it('a key of another tool is refused before any request', async () => {
    const env = await tempConfigEnv();
    const h = routedHarness([meRoute], env);
    expect(await run(['login', '--api-key', 'ant_hub_key', '--api-url', 'http://inst'], h.io)).toBe(1);
    expect(h.err()).toBe('Error: That is not a Slideless key: it should start with slk_.\n');
    expect(h.calls).toEqual([]);
  });

  it('self-hosted: the email code, both legs in one command', async () => {
    const env = await tempConfigEnv();
    const h = routedHarness([ossInstanceRoute, ...otpRoutes(MINTED.key, 'w1'), meRoute], env);
    const asked = scripted(h, ['ada@x.co', '123456']);
    expect(await run(['login', '--api-url', 'http://inst'], h.io)).toBe(0);
    expect(asked).toEqual(['Email: ', 'Code: ']);
    expect(h.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /api/v1/instance',
      'POST /api/v1/cli/auth/request',
      'POST /api/v1/cli/auth/complete',
      'GET /api/v1/me'
    ]);
    expect(h.err()).toBe('A sign-in code was sent to ada@x.co (if that account exists on http://inst).\n');
    expect(h.out()).toBe(
      'Signed in as Ada <ada@x.co> in Acme on http://inst.\n' +
        `API key "CLI login 2026-07-10" (${redactKey(MINTED.key)}) saved to profile "inst" (${configPath(env)}).\n`
    );
    expect(h.out()).not.toContain(MINTED.key);
    expect(loadConfig(env).profiles.inst).toEqual({
      apiKey: MINTED.key,
      baseUrl: 'http://inst',
      email: 'ada@x.co'
    });
    // The config file is private.
    expect(statSync(configPath(env)!).mode & 0o777).toBe(0o600);
  });

  it('cloud: the Antasphere email code on the hub, then the exchange, ends in Slideless', async () => {
    const HUB_KEY = 'ant_hubkey12_secretsecretsecret1234';
    const SLK = 'slk_minted12_0123456789abcdefghijklmnopqrstuvwxyz';
    const env = { ...(await tempConfigEnv()), ANTASPHERE_URL: 'http://hub' };
    const h = routedHarness(
      [
        cloudInstanceRoute,
        ...otpRoutes(HUB_KEY, 'org1'),
        {
          method: 'POST',
          path: /\/api\/v1\/sso\/tool-token$/,
          reply: () => ({
            body: { token: 'jwt-1', expiresAt: '2026-07-13T00:02:00.000Z', hubRefreshToken: 'hrt-1' }
          })
        },
        {
          method: 'POST',
          path: /\/api\/v1\/sso\/cli-connect$/,
          reply: () => ({ status: 201, body: { ...MINTED, key: SLK, workspaceId: null } })
        },
        meRoute
      ],
      env
    );
    const asked = scripted(h, ['123456']);
    expect(await run(['login', '--api-url', 'http://tool', '--email', 'ada@x.co'], h.io)).toBe(0);
    expect(asked).toEqual(['Code: ']);
    expect(h.wire.map((c) => `${c.method} ${c.origin}${c.path}`)).toEqual([
      'GET http://tool/api/v1/instance',
      'POST http://hub/api/v1/cli/auth/request',
      'POST http://hub/api/v1/cli/auth/complete',
      'GET http://tool/api/v1/instance',
      'POST http://hub/api/v1/sso/tool-token',
      'POST http://tool/api/v1/sso/cli-connect',
      'GET http://tool/api/v1/me'
    ]);
    expect(h.err()).toContain(
      'A sign-in code was sent to ada@x.co (if that Antasphere account can receive mail).\n'
    );
    expect(h.out()).toBe('Signed in as Ada <ada@x.co> in Acme on http://tool.\n');
    // The hub profile is named the hub CLI's way (cli-core `selectProfile`):
    // ANTASPHERE_URL=http://hub selects the profile of that host, `hub`.
    expect(loadCoreConfig(env, HUB_TOOL).activeProfile).toBe('hub');
    expect(loadCoreConfig(env, HUB_TOOL).profiles.hub).toEqual({
      apiKey: HUB_KEY,
      baseUrl: 'http://hub',
      email: 'ada@x.co',
      workspaceId: 'org1'
    });
    expect(loadConfig(env).profiles.tool?.connectKeys?.hub?.apiKey).toBe(SLK);
  });

  it('a saved profile feeds whoami without flags or env', async () => {
    const env = await tempConfigEnv();
    saveConfig(env, {
      activeProfile: 'work',
      profiles: { work: { apiKey: 'slk_k_s', baseUrl: 'http://saved' } }
    });
    const h = routedHarness([meRoute], env);
    const code = await run(['whoami'], h.io);
    expect(h.err()).toBe('');
    expect(code).toBe(0);
    expect(h.out()).toContain('ada@x.co');
    expect(h.out()).toContain('  instance:  http://saved (profile "work")');
  });

  it('flags beat env beats profile for the base URL', async () => {
    const env = await tempConfigEnv();
    saveConfig(env, {
      activeProfile: 'p',
      profiles: { p: { apiKey: 'slk_k_s', baseUrl: 'http://profile' } }
    });
    const h = routedHarness([meRoute], { ...env, SLIDELESS_URL: 'http://env', SLIDELESS_API_KEY: 'slk_e_e' });
    await run(['whoami'], h.io);
    expect(h.out()).toContain('http://env');

    const h2 = routedHarness([meRoute], {
      ...env,
      SLIDELESS_URL: 'http://env',
      SLIDELESS_API_KEY: 'slk_e_e'
    });
    await run(['whoami', '--api-url', 'http://flag'], h2.io);
    expect(h2.out()).toContain('http://flag');
  });

  it('with nothing configured, a command goes to the Slideless cloud and asks for a sign-in', async () => {
    const env = await tempConfigEnv();
    const h = routedHarness([], env);
    expect(await run(['list'], h.io)).toBe(1);
    expect(h.wire).toEqual([
      { method: 'GET', origin: 'https://slideless.antasphere.com', path: '/api/v1/instance', auth: undefined }
    ]);
    expect(h.err()).toBe(
      'Error: An API key is required. Sign in (`slideless login`), pass --api-key, or set SLIDELESS_API_KEY.\n'
    );
  });

  it('use + profiles + logout manage the profile set', async () => {
    const env = await tempConfigEnv();
    saveConfig(env, {
      activeProfile: 'a',
      profiles: {
        a: { apiKey: 'slk_a_verylongkeyvalue123', baseUrl: 'http://a' },
        b: { apiKey: 'slk_b_verylongkeyvalue456', baseUrl: 'http://b' }
      }
    });
    const h = routedHarness([], env);
    expect(await run(['use', 'b'], h.io)).toBe(0);
    expect(h.out()).toBe('Active profile: b (http://b)\n');
    expect(loadConfig(env).activeProfile).toBe('b');

    const h2 = routedHarness([], env);
    expect(await run(['profiles'], h2.io)).toBe(0);
    expect(h2.out()).toContain('https://slideless.antasphere.com');
    expect(h2.out()).toContain('http://a');
    expect(h2.out()).toContain('http://b');
    // Keys never appear in full.
    expect(h2.out()).not.toContain('slk_a_verylongkeyvalue123');

    const h3 = routedHarness(
      [{ method: 'DELETE', path: /\/api\/v1\/cli\/auth\/key$/, reply: () => ({ body: { revoked: true } }) }],
      env
    );
    expect(await run(['logout'], h3.io)).toBe(0);
    expect(h3.wire).toEqual([
      {
        method: 'DELETE',
        origin: 'http://b',
        path: '/api/v1/cli/auth/key',
        auth: 'Bearer slk_b_verylongkeyvalue456'
      }
    ]);
    expect(h3.out()).toBe('Logged out of profile "b" on http://b (1 key revoked server-side).\n');
    expect(loadConfig(env).profiles.b).toEqual({ baseUrl: 'http://b' });
    expect(loadConfig(env).profiles.a?.apiKey).toBe('slk_a_verylongkeyvalue123');
  });

  it('config show redacts keys; config clear wipes the file', async () => {
    const env = await tempConfigEnv();
    saveConfig(env, {
      activeProfile: 'a',
      profiles: { a: { apiKey: 'slk_abcdefgh_0123456789abcdef', baseUrl: 'http://a' } }
    });
    const h = routedHarness([], env);
    expect(await run(['config', 'show'], h.io)).toBe(0);
    expect(h.out()).not.toContain('slk_abcdefgh_0123456789abcdef');
    // The slideless namespace file in the shared antasphere config home.
    expect(h.out()).toContain('antasphere/tools/slideless.json');

    const h2 = routedHarness([], env);
    expect(await run(['config', 'clear'], h2.io)).toBe(0);
    expect(loadConfig(env)).toEqual({ profiles: {} });
  });

  it('verify exits 0 on a working key and 1 on a rejected one', async () => {
    const env = await tempConfigEnv();
    const ok = routedHarness([meRoute], env);
    expect(await run(['verify', '--api-url', 'http://x', '--api-key', 'slk_k_s'], ok.io)).toBe(0);
    expect(ok.out()).toContain('ok — ada@x.co');

    const bad = routedHarness(
      [
        {
          method: 'GET',
          path: /\/api\/v1\/me$/,
          reply: () => ({
            status: 401,
            body: { error: { code: 'invalid_api_key', message: 'API key not recognized' } }
          })
        }
      ],
      env
    );
    expect(await run(['verify', '--api-url', 'http://x', '--api-key', 'slk_k_s'], bad.io)).toBe(1);
  });
});

describe('deck + sharing commands (request shapes)', () => {
  const TOKEN_ID = '55555555-5555-5555-5555-555555555555';
  const TOKEN = {
    id: TOKEN_ID,
    presentationId: DECK.id,
    name: 'test',
    versionMode: 'latest',
    pinnedVersion: null,
    canAnnotate: false,
    expiresAt: null,
    hasPassword: false,
    revokedAt: null,
    accessCount: 0,
    lastAccessedAt: null,
    createdAt: '2026-07-10T00:00:00.000Z'
  };

  it('share prints the once-only viewer URL', async () => {
    const h = routedHarness([
      {
        method: 'POST',
        path: new RegExp(`/api/v1/presentations/${DECK.id}/tokens$`),
        reply: ({ body }) => {
          expect(body).toMatchObject({ name: 'test', versionMode: 'latest', canAnnotate: false });
          return { status: 201, body: { shareToken: TOKEN, secret: 's3cret', url: 'http://x/v/s3cret' } };
        }
      }
    ]);
    const code = await run(
      ['share', DECK.id, '--name', 'test', '--url', 'http://x', '--api-key', 'slk_k_s'],
      h.io
    );
    expect(h.err()).toBe('');
    expect(code).toBe(0);
    expect(h.out()).toContain('http://x/v/s3cret');
    expect(h.out()).toContain(TOKEN_ID);
  });

  it('share --to-version pins at creation; pin re-pins; pin --latest unpins', async () => {
    const h = routedHarness([
      {
        method: 'POST',
        path: new RegExp(`/api/v1/presentations/${DECK.id}/tokens$`),
        reply: ({ body }) => {
          expect(body).toMatchObject({ versionMode: 'pinned', pinnedVersion: 2 });
          return {
            status: 201,
            body: {
              shareToken: { ...TOKEN, versionMode: 'pinned', pinnedVersion: 2 },
              secret: 's',
              url: 'http://x/v/s'
            }
          };
        }
      }
    ]);
    expect(
      await run(['share', DECK.id, '--to-version', '2', '--url', 'http://x', '--api-key', 'slk_k_s'], h.io)
    ).toBe(0);

    const h2 = routedHarness([
      {
        method: 'PATCH',
        path: new RegExp(`/api/v1/presentations/${DECK.id}/tokens/${TOKEN_ID}$`),
        reply: ({ body }) => {
          expect(body).toEqual({ versionMode: 'pinned', pinnedVersion: 1 });
          return { body: { ...TOKEN, versionMode: 'pinned', pinnedVersion: 1 } };
        }
      }
    ]);
    expect(
      await run(
        ['pin', DECK.id, TOKEN_ID, '--to-version', '1', '--url', 'http://x', '--api-key', 'slk_k_s'],
        h2.io
      )
    ).toBe(0);
    expect(h2.out()).toContain('pinned to v1');

    const h3 = routedHarness([
      {
        method: 'PATCH',
        path: new RegExp(`/api/v1/presentations/${DECK.id}/tokens/${TOKEN_ID}$`),
        reply: ({ body }) => {
          expect(body).toEqual({ versionMode: 'latest' });
          return { body: TOKEN };
        }
      }
    ]);
    expect(
      await run(['pin', DECK.id, TOKEN_ID, '--latest', '--url', 'http://x', '--api-key', 'slk_k_s'], h3.io)
    ).toBe(0);

    const h4 = routedHarness([]);
    expect(await run(['pin', DECK.id, TOKEN_ID, '--url', 'http://x', '--api-key', 'slk_k_s'], h4.io)).toBe(1);
    expect(h4.err()).toContain('exactly one');
  });

  it('unshare without --token revokes every active token (paginated)', async () => {
    const OTHER = '66666666-6666-6666-6666-666666666666';
    const revoked: string[] = [];
    const h = routedHarness([
      {
        method: 'GET',
        path: new RegExp(`/api/v1/presentations/${DECK.id}/tokens$`),
        reply: ({ path }) =>
          path.includes('cursor=next')
            ? { body: { shareTokens: [{ ...TOKEN, id: OTHER }], nextCursor: null } }
            : {
                body: {
                  shareTokens: [
                    TOKEN,
                    {
                      ...TOKEN,
                      id: '77777777-7777-7777-7777-777777777777',
                      revokedAt: '2026-07-01T00:00:00.000Z'
                    }
                  ],
                  nextCursor: 'next'
                }
              }
      },
      {
        method: 'DELETE',
        path: new RegExp(`/api/v1/presentations/${DECK.id}/tokens/[0-9a-f-]+$`),
        reply: ({ path }) => {
          revoked.push(path.split('/').pop()!);
          return { body: { ...TOKEN, revokedAt: '2026-07-10T00:00:00.000Z' } };
        }
      }
    ]);
    const code = await run(['unshare', DECK.id, '--url', 'http://x', '--api-key', 'slk_k_s'], h.io);
    expect(code).toBe(0);
    expect(revoked.sort()).toEqual([TOKEN_ID, OTHER].sort());
    expect(h.out()).toContain('Revoked 2');
  });

  it('share-email creates one token per recipient and sends each', async () => {
    const created: string[] = [];
    const h = routedHarness([
      {
        method: 'POST',
        path: new RegExp(`/api/v1/presentations/${DECK.id}/tokens$`),
        reply: ({ body }) => {
          created.push((body as { name: string }).name);
          return { status: 201, body: { shareToken: TOKEN, secret: 's', url: 'http://x/v/s' } };
        }
      },
      {
        method: 'POST',
        path: new RegExp(`/api/v1/presentations/${DECK.id}/tokens/${TOKEN_ID}/send$`),
        reply: () => ({ body: { shareToken: TOKEN, emailSent: true } })
      }
    ]);
    const code = await run(
      ['share-email', DECK.id, '--to', 'a@x.co', 'b@x.co', '--url', 'http://x', '--api-key', 'slk_k_s'],
      h.io
    );
    expect(h.err()).toBe('');
    expect(code).toBe(0);
    expect(created).toEqual(['a@x.co', 'b@x.co']);
    expect(h.out()).toContain('sent');
  });

  it('tokens lists share links with access stats (--all paginates; --json wire shape)', async () => {
    const OPENED = {
      ...TOKEN,
      id: '99999999-9999-9999-9999-999999999999',
      name: 'Alice',
      versionMode: 'pinned',
      pinnedVersion: 2,
      canAnnotate: true,
      accessCount: 3,
      lastAccessedAt: '2026-07-11T00:00:00.000Z'
    };
    const REVOKED = { ...TOKEN, revokedAt: '2026-07-01T00:00:00.000Z' };
    const h = routedHarness([
      {
        method: 'GET',
        path: new RegExp(`/api/v1/presentations/${DECK.id}/tokens$`),
        reply: ({ path }) =>
          path.includes('cursor=next')
            ? { body: { shareTokens: [REVOKED], nextCursor: null } }
            : { body: { shareTokens: [OPENED], nextCursor: 'next' } }
      }
    ]);
    const code = await run(['tokens', DECK.id, '--all', '--url', 'http://x', '--api-key', 'slk_k_s'], h.io);
    expect(h.err()).toBe('');
    expect(code).toBe(0);
    expect(h.out()).toContain('3 opens');
    expect(h.out()).toContain('pinned v2');
    expect(h.out()).toContain('annotator');
    expect(h.out()).toContain('revoked');

    const h2 = routedHarness([
      {
        method: 'GET',
        path: new RegExp(`/api/v1/presentations/${DECK.id}/tokens$`),
        reply: () => ({ body: { shareTokens: [TOKEN], nextCursor: 'n1' } })
      }
    ]);
    expect(await run(['tokens', DECK.id, '--json', '--url', 'http://x', '--api-key', 'slk_k_s'], h2.io)).toBe(
      0
    );
    expect(JSON.parse(h2.out())).toEqual({ shareTokens: [TOKEN], nextCursor: 'n1' });
  });

  it('views drills into one token (--all paginates; --json wire shape) and lists tokens without one', async () => {
    const VIEW = {
      id: '77777777-7777-7777-7777-777777777777',
      version: 2,
      occurredAt: '2026-07-20T10:00:00.000Z',
      referrerHost: 'docs.example.com',
      placement: 'hero',
      uaFamily: 'chrome'
    };
    const DIRECT = {
      ...VIEW,
      id: '88888888-8888-8888-8888-888888888888',
      referrerHost: null,
      placement: null,
      uaFamily: null
    };
    const h = routedHarness([
      {
        method: 'GET',
        path: new RegExp(`/api/v1/presentations/${DECK.id}/tokens/${TOKEN_ID}/views`),
        reply: ({ path }) =>
          path.includes('cursor=next')
            ? { body: { views: [DIRECT], nextCursor: null } }
            : { body: { views: [VIEW], nextCursor: 'next' } }
      }
    ]);
    const code = await run(
      ['views', DECK.id, TOKEN_ID, '--all', '--url', 'http://x', '--api-key', 'slk_k_s'],
      h.io
    );
    expect(h.err()).toBe('');
    expect(code).toBe(0);
    expect(h.out()).toContain('docs.example.com');
    expect(h.out()).toContain('p:hero');
    expect(h.out()).toContain('chrome');
    expect(h.out()).toContain('direct');

    const h2 = routedHarness([
      {
        method: 'GET',
        path: new RegExp(`/api/v1/presentations/${DECK.id}/tokens/${TOKEN_ID}/views`),
        reply: () => ({ body: { views: [VIEW], nextCursor: 'n1' } })
      }
    ]);
    expect(
      await run(['views', DECK.id, TOKEN_ID, '--json', '--url', 'http://x', '--api-key', 'slk_k_s'], h2.io)
    ).toBe(0);
    expect(JSON.parse(h2.out())).toEqual({ views: [VIEW], nextCursor: 'n1' });

    // Without a tokenId the command lists the deck's tokens + the drill hint.
    const h3 = routedHarness([
      {
        method: 'GET',
        path: new RegExp(`/api/v1/presentations/${DECK.id}/tokens$`),
        reply: () => ({ body: { shareTokens: [TOKEN], nextCursor: null } })
      }
    ]);
    expect(await run(['views', DECK.id, '--url', 'http://x', '--api-key', 'slk_k_s'], h3.io)).toBe(0);
    expect(h3.out()).toContain(TOKEN_ID);
    expect(h3.out()).toContain('slideless views');
  });

  it('versions lists the history with --json wire shape', async () => {
    const V2 = {
      ...VERSION_ROW,
      version: 2,
      sizeBytes: 2048,
      fileCount: 3,
      createdByRole: 'dev',
      createdAt: '2026-07-12T00:00:00.000Z'
    };
    const route: Route = {
      method: 'GET',
      path: new RegExp(`/api/v1/presentations/${DECK.id}/versions$`),
      reply: () => ({ body: { versions: [V2, VERSION_ROW], nextCursor: null } })
    };
    const h = routedHarness([route]);
    const code = await run(['versions', DECK.id, '--url', 'http://x', '--api-key', 'slk_k_s'], h.io);
    expect(h.err()).toBe('');
    expect(code).toBe(0);
    expect(h.out()).toContain('v2');
    expect(h.out()).toContain('2.0 KB');
    expect(h.out()).toContain('3 files');
    expect(h.out()).toContain('u1 (dev)');

    const h2 = routedHarness([route]);
    expect(
      await run(['versions', DECK.id, '--json', '--url', 'http://x', '--api-key', 'slk_k_s'], h2.io)
    ).toBe(0);
    expect(JSON.parse(h2.out())).toEqual({ versions: [V2, VERSION_ROW], nextCursor: null });
  });

  it('annotation resolve / reopen PATCH the status', async () => {
    const ANNOTATION_ID = '99999999-0000-0000-0000-999999999999';
    const ANNOTATION = {
      id: ANNOTATION_ID,
      presentationId: DECK.id,
      version: 1,
      shareTokenId: null,
      authorUserId: 'u1',
      authorName: null,
      selection: {},
      body: 'Fix the chart',
      status: 'resolved',
      createdAt: '2026-07-10T00:00:00.000Z',
      updatedAt: '2026-07-12T00:00:00.000Z'
    };
    const h = routedHarness([
      {
        method: 'PATCH',
        path: new RegExp(`/api/v1/presentations/${DECK.id}/annotations/${ANNOTATION_ID}$`),
        reply: ({ body }) => {
          expect(body).toEqual({ status: 'resolved' });
          return { body: ANNOTATION };
        }
      }
    ]);
    const code = await run(
      ['annotation', 'resolve', DECK.id, ANNOTATION_ID, '--url', 'http://x', '--api-key', 'slk_k_s'],
      h.io
    );
    expect(h.err()).toBe('');
    expect(code).toBe(0);
    expect(h.out()).toContain(`Annotation ${ANNOTATION_ID} resolved.`);

    const h2 = routedHarness([
      {
        method: 'PATCH',
        path: new RegExp(`/api/v1/presentations/${DECK.id}/annotations/${ANNOTATION_ID}$`),
        reply: ({ body }) => {
          expect(body).toEqual({ status: 'open' });
          return { body: { ...ANNOTATION, status: 'open' } };
        }
      }
    ]);
    expect(
      await run(
        ['annotation', 'reopen', DECK.id, ANNOTATION_ID, '--url', 'http://x', '--api-key', 'slk_k_s'],
        h2.io
      )
    ).toBe(0);
    expect(h2.out()).toContain(`Annotation ${ANNOTATION_ID} reopened.`);
  });

  it('invite prints the claim link; uninvite revokes', async () => {
    const COLLAB_ID = '88888888-8888-8888-8888-888888888888';
    const collaborator = {
      id: COLLAB_ID,
      presentationId: DECK.id,
      email: 'dev@x.co',
      userId: null,
      role: 'dev',
      status: 'pending',
      invitedBy: 'u1',
      claimedAt: null,
      revokedAt: null,
      createdAt: '2026-07-10T00:00:00.000Z'
    };
    const h = routedHarness([
      {
        method: 'POST',
        path: new RegExp(`/api/v1/presentations/${DECK.id}/collaborators$`),
        reply: () => ({
          status: 201,
          body: { collaborator, claimUrl: 'http://x/collab/tok', emailSent: false }
        })
      }
    ]);
    const code = await run(
      ['invite', DECK.id, '--email', 'dev@x.co', '--url', 'http://x', '--api-key', 'slk_k_s'],
      h.io
    );
    expect(code).toBe(0);
    expect(h.out()).toContain('http://x/collab/tok');
    expect(h.out()).toContain('NOT sent');

    const h2 = routedHarness([
      {
        method: 'DELETE',
        path: new RegExp(`/api/v1/presentations/${DECK.id}/collaborators/${COLLAB_ID}$`),
        reply: () => ({ body: { ...collaborator, status: 'revoked', revokedAt: '2026-07-10T00:00:00.000Z' } })
      }
    ]);
    expect(
      await run(['uninvite', DECK.id, COLLAB_ID, '--url', 'http://x', '--api-key', 'slk_k_s'], h2.io)
    ).toBe(0);
  });

  it('list renders decks and threads pagination; delete confirms', async () => {
    const h = routedHarness([
      {
        method: 'GET',
        path: /\/api\/v1\/presentations$/,
        reply: () => ({ body: { presentations: [DECK], nextCursor: null } })
      }
    ]);
    expect(await run(['list', '--url', 'http://x', '--api-key', 'slk_k_s'], h.io)).toBe(0);
    expect(h.out()).toContain(DECK.id);
    expect(h.out()).toContain('Test Deck');

    const h2 = routedHarness([
      {
        method: 'DELETE',
        path: new RegExp(`/api/v1/presentations/${DECK.id}$`),
        reply: () => ({ body: DECK })
      }
    ]);
    expect(await run(['delete', DECK.id, '--url', 'http://x', '--api-key', 'slk_k_s'], h2.io)).toBe(0);
    expect(h2.out()).toContain('Deleted');
  });

  it('completion prints scripts for bash/zsh/fish and rejects others', async () => {
    for (const shell of ['bash', 'zsh', 'fish']) {
      const h = routedHarness([]);
      expect(await run(['completion', shell], h.io)).toBe(0);
      expect(h.out()).toContain('slideless');
      expect(h.out()).toContain('push');
    }
    const h = routedHarness([]);
    expect(await run(['completion', 'powershell'], h.io)).toBe(1);
  });
});
