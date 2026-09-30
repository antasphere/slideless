import { describe, expect, it } from 'vitest';
import { HUB_TOOL, loadConfig as loadCoreConfig, saveConfig as saveCoreConfig } from '@antasphere/cli-core';
import { redactKey } from '@antasphere/chassis-cli';
import { routedHarness, tempConfigEnv, type Route } from '@antasphere/chassis-cli/testing';
import { cli, run } from '@chassis-cli-test/host';
import {
  cloudInstanceRoute,
  exchangeRoutes,
  HUB,
  HUB_KEY,
  key,
  meBody,
  meRoute,
  ORG,
  ossInstanceRoute,
  otpRoutes,
  seedHubLogin,
  TOOL_ACCESS_DENIED,
  wsRow
} from './signin-fixtures.js';

/**
 * ONE `login` that ends in the tool (PRDCT-2947): a pasted key, the
 * instance's email code (self-hosted), or the Antasphere sign-in then the
 * exchange (cloud). The profile it signs in on is the instance's, and it
 * becomes the active one.
 */

const { configPath, loadConfig, saveConfig } = cli;
const { envPrefix: P, keyPrefix: K, displayName, cloudUrl } = cli.identity;

const TWO = [wsRow('w1', 'Acme', { default: true }), wsRow('w2', 'Beta')];

/** A scripted prompt: answers in order, questions recorded. */
function scripted(h: ReturnType<typeof routedHarness>, answers: string[]): string[] {
  const asked: string[] = [];
  h.io.prompt = async (q) => {
    asked.push(q);
    return answers.shift() ?? '';
  };
  return asked;
}

describe('login with a pasted key', () => {
  it('verifies the key with /me, saves it on the instance profile and makes it active', async () => {
    const env = await tempConfigEnv();
    const pasted = key('paste');
    const h = routedHarness([meRoute()], env);
    expect(await run(['login', '--api-key', pasted, '--api-url', 'http://inst'], h.io)).toBe(0);
    expect(h.err()).toBe('');
    expect(h.wire).toEqual([
      { method: 'GET', origin: 'http://inst', path: '/api/v1/me', auth: `Bearer ${pasted}` }
    ]);
    expect(h.out()).toBe(
      `Signed in as Ada <ada@x.co> in Acme on http://inst.\nKey saved to profile "inst" (${configPath(env)}).\n`
    );
    const config = loadConfig(env);
    expect(config.activeProfile).toBe('inst');
    expect(config.profiles).toEqual({ inst: { apiKey: pasted, baseUrl: 'http://inst', email: 'ada@x.co' } });
  });

  it(`reads the key from ${P}_API_KEY too, and lists the workspaces when there are two`, async () => {
    const env = await tempConfigEnv();
    const pasted = key('envkey');
    const h = routedHarness([meRoute(meBody({ workspaces: TWO }))], { ...env, [`${P}_API_KEY`]: pasted });
    expect(await run(['login', '--api-url', 'http://localhost:3400'], h.io)).toBe(0);
    expect(h.out()).toBe(
      'Signed in as Ada <ada@x.co> in Acme on http://localhost:3400.\n' +
        `Key saved to profile "localhost:3400" (${configPath(env)}).\n` +
        'Your workspaces: Acme, Beta. Pass --org <name> (or --workspace <name>) to work in another.\n'
    );
    expect(loadConfig(env).profiles['localhost:3400']?.apiKey).toBe(pasted);
  });

  it('reads the key from --api-key-stdin', async () => {
    const env = await tempConfigEnv();
    const pasted = key('stdin');
    const h = routedHarness([meRoute()], env);
    h.io.readStdin = async () => `${pasted}\n`;
    expect(await run(['login', '--api-key-stdin', '--api-url', 'http://inst'], h.io)).toBe(0);
    expect(h.wire[0]?.auth).toBe(`Bearer ${pasted}`);
    expect(loadConfig(env).profiles.inst?.apiKey).toBe(pasted);
  });

  it('a person with no name reads as the email alone', async () => {
    const env = await tempConfigEnv();
    const h = routedHarness([meRoute(meBody({ name: '' }))], env);
    expect(await run(['login', '--api-key', key('paste'), '--api-url', 'http://inst'], h.io)).toBe(0);
    expect(h.out().split('\n')[0]).toBe('Signed in as ada@x.co in Acme on http://inst.');
  });

  it(`refuses a key that is not a ${displayName} key, before any request`, async () => {
    const env = await tempConfigEnv();
    const h = routedHarness([meRoute()], env);
    expect(await run(['login', '--api-key', 'zzz_not_ours', '--api-url', 'http://inst'], h.io)).toBe(1);
    expect(h.err()).toBe(`Error: That is not a ${displayName} key: it should start with ${K}_.\n`);
    expect(h.wire).toEqual([]);
    expect(loadConfig(env)).toEqual({ profiles: {} });
  });

  it('a key the instance refuses is never saved', async () => {
    const env = await tempConfigEnv();
    const h = routedHarness(
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
    expect(await run(['login', '--api-key', key('bad'), '--api-url', 'http://inst'], h.io)).toBe(1);
    expect(loadConfig(env)).toEqual({ profiles: {} });
  });

  it('--json: the profile, the URL, how, who, where, and the file', async () => {
    const env = await tempConfigEnv();
    const pasted = key('paste');
    const me = meBody();
    const h = routedHarness([meRoute(me)], env);
    expect(await run(['login', '--json', '--api-key', pasted, '--api-url', 'http://inst'], h.io)).toBe(0);
    expect(JSON.parse(h.out())).toEqual({
      profile: 'inst',
      baseUrl: 'http://inst',
      via: 'key',
      user: me.user,
      workspace: me.workspace,
      configPath: configPath(env)
    });
    expect(h.out()).not.toContain(pasted);
  });

  it('--profile names the profile the key is saved on', async () => {
    const env = await tempConfigEnv();
    saveConfig(env, { profiles: { work: { baseUrl: 'http://inst' } } });
    const h = routedHarness([meRoute()], env);
    expect(await run(['login', '--api-key', key('paste'), '--profile', 'work'], h.io)).toBe(0);
    expect(loadConfig(env)).toEqual({
      activeProfile: 'work',
      profiles: { work: { apiKey: key('paste'), baseUrl: 'http://inst', email: 'ada@x.co' } }
    });
  });
});

describe('login on a self-hosted instance: the email code', () => {
  it('asks the email and the code, mints the key, saves it on the instance profile', async () => {
    const env = await tempConfigEnv();
    const minted = key('minted');
    const h = routedHarness([ossInstanceRoute, ...otpRoutes(minted), meRoute()], env);
    const asked = scripted(h, ['ada@x.co', '123456']);
    expect(await run(['login', '--api-url', 'http://inst'], h.io)).toBe(0);
    expect(asked).toEqual(['Email: ', 'Code: ']);
    expect(h.wire).toEqual([
      { method: 'GET', origin: 'http://inst', path: '/api/v1/instance', auth: undefined },
      {
        method: 'POST',
        origin: 'http://inst',
        path: '/api/v1/cli/auth/request',
        auth: undefined,
        body: { email: 'ada@x.co' }
      },
      {
        method: 'POST',
        origin: 'http://inst',
        path: '/api/v1/cli/auth/complete',
        auth: undefined,
        body: { email: 'ada@x.co', otp: '123456' }
      },
      { method: 'GET', origin: 'http://inst', path: '/api/v1/me', auth: `Bearer ${minted}` }
    ]);
    expect(h.err()).toBe('A sign-in code was sent to ada@x.co (if that account exists on http://inst).\n');
    expect(h.out()).toBe(
      'Signed in as Ada <ada@x.co> in Acme on http://inst.\n' +
        `API key "CLI login" (${redactKey(minted)}) saved to profile "inst" (${configPath(env)}).\n`
    );
    expect(h.out()).not.toContain(minted);
    const config = loadConfig(env);
    expect(config.activeProfile).toBe('inst');
    expect(config.profiles.inst).toEqual({ apiKey: minted, baseUrl: 'http://inst', email: 'ada@x.co' });
  });

  it('--email skips the first question; --key-name and --expires-in-days reach the mint', async () => {
    const env = await tempConfigEnv();
    const h = routedHarness([ossInstanceRoute, ...otpRoutes(key('minted')), meRoute()], env);
    const asked = scripted(h, ['654321']);
    expect(
      await run(
        [
          'login',
          '--api-url',
          'http://inst',
          '--email',
          'ada@x.co',
          '--key-name',
          'laptop',
          '--expires-in-days',
          '30'
        ],
        h.io
      )
    ).toBe(0);
    expect(asked).toEqual(['Code: ']);
    expect(h.wire.find((c) => c.path.endsWith('/complete'))?.body).toEqual({
      email: 'ada@x.co',
      otp: '654321',
      keyName: 'laptop',
      expiresInDays: 30
    });
  });

  it('--json never carries the key', async () => {
    const env = await tempConfigEnv();
    const minted = key('minted');
    const me = meBody();
    const h = routedHarness([ossInstanceRoute, ...otpRoutes(minted), meRoute(me)], env);
    scripted(h, ['123456']);
    expect(await run(['login', '--json', '--api-url', 'http://inst', '--email', 'ada@x.co'], h.io)).toBe(0);
    expect(JSON.parse(h.out())).toEqual({
      profile: 'inst',
      baseUrl: 'http://inst',
      via: 'otp',
      user: me.user,
      workspace: me.workspace,
      keyName: 'CLI login',
      configPath: configPath(env)
    });
    expect(h.out()).not.toContain(minted);
  });

  it('an instance whose discovery does not answer is signed in the self-hosted way', async () => {
    const env = await tempConfigEnv();
    const h = routedHarness([...otpRoutes(key('minted')), meRoute()], env);
    scripted(h, ['123456']);
    expect(await run(['login', '--api-url', 'http://inst', '--email', 'ada@x.co'], h.io)).toBe(0);
    expect(h.wire.map((c) => c.path)).toEqual([
      '/api/v1/instance',
      '/api/v1/cli/auth/request',
      '/api/v1/cli/auth/complete',
      '/api/v1/me'
    ]);
  });

  it('with no prompt wired, the question is a clean error and nothing is requested', async () => {
    const env = await tempConfigEnv();
    const h = routedHarness([ossInstanceRoute, ...otpRoutes(key('minted')), meRoute()], env);
    expect(await run(['login', '--api-url', 'http://inst'], h.io)).toBe(1);
    expect(h.err()).toBe(
      'Error: This command is interactive — no prompt available (pass the value as a flag).\n'
    );
    expect(h.wire.map((c) => c.path)).toEqual(['/api/v1/instance']);
    expect(loadConfig(env)).toEqual({ profiles: {} });
  });
});

describe('login on the cloud: the Antasphere sign-in, then the exchange', () => {
  const hubEnv = async () => ({ ...(await tempConfigEnv()), ANTASPHERE_URL: HUB });
  const ORG_ROWS = [
    wsRow('w1', 'Acme', { default: true, hubOrigin: true, centralAccountId: ORG }),
    wsRow('w2', 'Beta', { hubOrigin: true, centralAccountId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' })
  ];

  it('with no Antasphere login: the hub email code, the hub profile written as the hub CLI writes it, then the exchange', async () => {
    const env = await hubEnv();
    const minted = key('tool');
    const h = routedHarness(
      [
        cloudInstanceRoute,
        ...otpRoutes(HUB_KEY, ORG),
        ...exchangeRoutes([minted]),
        meRoute(meBody({ workspaces: ORG_ROWS }))
      ],
      env
    );
    const asked = scripted(h, ['ada@x.co', '123456']);
    expect(await run(['login', '--api-url', 'http://tool'], h.io)).toBe(0);
    expect(asked).toEqual(['Antasphere email: ', 'Code: ']);
    expect(h.wire.map((c) => `${c.method} ${c.origin}${c.path} ${c.auth ?? '-'}`)).toEqual([
      'GET http://tool/api/v1/instance -',
      `POST ${HUB}/api/v1/cli/auth/request -`,
      `POST ${HUB}/api/v1/cli/auth/complete -`,
      'GET http://tool/api/v1/instance -',
      `POST ${HUB}/api/v1/sso/tool-token Bearer ${HUB_KEY}`,
      'POST http://tool/api/v1/sso/cli-connect -',
      `GET http://tool/api/v1/me Bearer ${minted}`
    ]);
    expect(h.wire[2]?.body).toEqual({ email: 'ada@x.co', otp: '123456' });
    expect(h.err()).toContain(
      'A sign-in code was sent to ada@x.co (if that Antasphere account can receive mail).\n'
    );
    expect(h.out()).toBe(
      `Signed in as Ada <ada@x.co> in Acme (organization ${ORG}) on http://tool.\n` +
        'Your workspaces: Acme, Beta. Pass --org <name> (or --workspace <name>) to work in another.\n'
    );
    // The hub profile: exactly what `antasphere login` writes.
    expect(loadCoreConfig(env, HUB_TOOL)).toEqual({
      activeProfile: 'default',
      profiles: { default: { apiKey: HUB_KEY, baseUrl: HUB, email: 'ada@x.co', workspaceId: ORG } }
    });
    // The tool's key is cached on the instance profile, which is the active one.
    const config = loadConfig(env);
    expect(config.activeProfile).toBe('tool');
    expect(config.profiles.tool?.baseUrl).toBe('http://tool');
    expect(config.profiles.tool?.apiKey).toBeUndefined();
    expect(config.profiles.tool?.connectKeys?.default).toMatchObject({ apiKey: minted, email: 'ada@x.co' });
  });

  it('the hub URL defaults to account.antasphere.com', async () => {
    const env = await tempConfigEnv();
    const h = routedHarness(
      [cloudInstanceRoute, ...otpRoutes(HUB_KEY, ORG), ...exchangeRoutes([key('tool')]), meRoute()],
      env
    );
    scripted(h, ['123456']);
    expect(await run(['login', '--api-url', 'http://tool', '--email', 'ada@x.co'], h.io)).toBe(0);
    expect(h.wire[1]).toMatchObject({
      origin: 'https://account.antasphere.com',
      path: '/api/v1/cli/auth/request'
    });
    expect(loadCoreConfig(env, HUB_TOOL).profiles.default?.baseUrl).toBe('https://account.antasphere.com');
  });

  it('the hub profile keeps the name the hub CLI made active', async () => {
    const env = await hubEnv();
    saveCoreConfig(env, HUB_TOOL, { activeProfile: 'work', profiles: { work: { baseUrl: HUB } } });
    const h = routedHarness(
      [cloudInstanceRoute, ...otpRoutes(HUB_KEY, ORG), ...exchangeRoutes([key('tool')]), meRoute()],
      env
    );
    scripted(h, ['123456']);
    expect(await run(['login', '--api-url', 'http://tool', '--email', 'ada@x.co'], h.io)).toBe(0);
    expect(loadCoreConfig(env, HUB_TOOL)).toEqual({
      activeProfile: 'work',
      profiles: { work: { apiKey: HUB_KEY, baseUrl: HUB, email: 'ada@x.co', workspaceId: ORG } }
    });
    expect(loadConfig(env).profiles.tool?.connectKeys?.work?.apiKey).toBe(key('tool'));
  });

  it('with no URL at all, signs in on the implicit cloud profile at the cloud URL', async () => {
    const env = await hubEnv();
    seedHubLogin(env);
    const minted = key('tool');
    const h = routedHarness([cloudInstanceRoute, ...exchangeRoutes([minted]), meRoute()], env);
    expect(await run(['login'], h.io)).toBe(0);
    const origin = new URL(cloudUrl).origin;
    expect(h.wire.map((c) => `${c.method} ${c.origin}${c.path}`)).toEqual([
      `GET ${origin}/api/v1/instance`,
      `GET ${origin}/api/v1/instance`,
      `POST ${HUB}/api/v1/sso/tool-token`,
      `POST ${origin}/api/v1/sso/cli-connect`,
      `GET ${origin}/api/v1/me`
    ]);
    const config = loadConfig(env);
    expect(config.activeProfile).toBe('cloud');
    expect(Object.keys(config.profiles)).toEqual(['cloud']);
    expect(config.profiles.cloud?.baseUrl).toBe(origin);
    expect(config.profiles.cloud?.connectKeys?.default?.apiKey).toBe(minted);
    expect(h.out()).toBe(`Signed in as Ada <ada@x.co> in Acme on ${origin}.\n`);
  });

  it('with an Antasphere login stored: no question, the exchange alone', async () => {
    const env = await hubEnv();
    seedHubLogin(env);
    const h = routedHarness([cloudInstanceRoute, ...exchangeRoutes([key('tool')]), meRoute()], env);
    const asked = scripted(h, []);
    expect(await run(['login', '--api-url', 'http://tool'], h.io)).toBe(0);
    expect(asked).toEqual([]);
    expect(h.wire.map((c) => c.path)).toEqual([
      '/api/v1/instance',
      '/api/v1/instance',
      '/api/v1/sso/tool-token',
      '/api/v1/sso/cli-connect',
      '/api/v1/me'
    ]);
  });

  it('a stored Antasphere login the hub rejects: signs in again, then the exchange again', async () => {
    const env = await hubEnv();
    seedHubLogin(env);
    const fresh = 'ant_freshkey_secretsecretsecret1234';
    const h = routedHarness(
      [
        cloudInstanceRoute,
        ...otpRoutes(fresh, ORG),
        ...exchangeRoutes([key('tool')], {
          toolToken: (n) =>
            n === 1
              ? { status: 401, body: { error: { code: 'unauthenticated', message: 'bad key' } } }
              : undefined
        }),
        meRoute()
      ],
      env
    );
    scripted(h, ['123456']);
    expect(await run(['login', '--api-url', 'http://tool', '--email', 'ada@x.co'], h.io)).toBe(0);
    expect(h.err()).toContain('The stored Antasphere login was rejected: signing in again.\n');
    expect(h.wire.map((c) => `${c.method} ${c.origin}${c.path} ${c.auth ?? '-'}`)).toEqual([
      'GET http://tool/api/v1/instance -',
      'GET http://tool/api/v1/instance -',
      `POST ${HUB}/api/v1/sso/tool-token Bearer ${HUB_KEY}`,
      `POST ${HUB}/api/v1/cli/auth/request -`,
      `POST ${HUB}/api/v1/cli/auth/complete -`,
      'GET http://tool/api/v1/instance -',
      `POST ${HUB}/api/v1/sso/tool-token Bearer ${fresh}`,
      'POST http://tool/api/v1/sso/cli-connect -',
      `GET http://tool/api/v1/me Bearer ${key('tool')}`
    ]);
    expect(loadCoreConfig(env, HUB_TOOL).profiles.default?.apiKey).toBe(fresh);
  });

  it('--json: via antasphere, the hub profile, the workspaces', async () => {
    const env = await hubEnv();
    seedHubLogin(env);
    const me = meBody({ workspaces: ORG_ROWS });
    const h = routedHarness([cloudInstanceRoute, ...exchangeRoutes([key('tool')]), meRoute(me)], env);
    expect(await run(['login', '--json', '--api-url', 'http://tool'], h.io)).toBe(0);
    expect(JSON.parse(h.out())).toEqual({
      profile: 'tool',
      baseUrl: 'http://tool',
      via: 'antasphere',
      hubProfile: 'default',
      user: me.user,
      workspace: me.workspace,
      workspaces: me.workspaces,
      configPath: configPath(env)
    });
    expect(h.out()).not.toContain(key('tool'));
  });

  it('a hub refusal of the person is its own sentence, and exit 3', async () => {
    const env = await hubEnv();
    seedHubLogin(env);
    const h = routedHarness(
      [cloudInstanceRoute, ...exchangeRoutes([key('tool')], { toolToken: () => TOOL_ACCESS_DENIED })],
      env
    );
    expect(await run(['login', '--api-url', 'http://tool'], h.io)).toBe(3);
    expect(h.err()).toBe(`Error: This account has no access to ${displayName} in any of its organizations\n`);
    expect(loadConfig(env).profiles.tool).toBeUndefined();
  });
});

describe('the old sign-in pair is gone', () => {
  it.each([['login-request'], ['login-complete']])('`auth %s` is an unknown command', async (sub) => {
    const h = routedHarness([ossInstanceRoute] as Route[]);
    expect(await run(['auth', sub, '--email', 'ada@x.co'], h.io)).toBe(1);
    expect(h.err()).toContain("unknown command 'auth'");
    expect(h.wire).toEqual([]);
  });
});
