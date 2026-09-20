import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildProgram, run } from '../src/index.js';
import { routedHarness, tempConfigEnv, type Route } from './harness.js';

/**
 * The Slideless instantiation of the CLI chassis, pinned by RAW BYTES
 * (PRDCT-2530, verifier F-4 / F-2 / F-3 / M18).
 *
 * The chassis suite (`packages/chassis-cli/test/suite`) reads the tool's
 * identity from the kit under test, which is right for a suite that runs under
 * two hosts and wrong as the only net: a wrong VALUE in `src/cli.ts` moves the
 * fixture together with the bug. So this file NEVER reads `cli.identity` and
 * never imports `src/cli.ts`: every expectation below is a literal, and each of
 * the six identity fields is proven by something a person can observe.
 * `packages/chassis-cli/test/host/identity.test.ts` is the mirror for the
 * minimal `things` tool.
 */

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

const ME = {
  user: { id: 'u1', name: 'Ada', email: 'ada@x.co' },
  workspace: { id: 'w1', name: 'Acme' },
  role: 'owner',
  via: 'api_key',
  scopes: ['presentations:read'],
  apiKeyExpiresAt: null
};

const meRoute: Route = { method: 'GET', path: /\/api\/v1\/me$/, reply: () => ({ body: ME }) };

const LEGACY = {
  activeProfile: 'work',
  profiles: { work: { apiKey: 'slk_abcdefgh_0123456789abcdef', baseUrl: 'http://legacy-inst' } }
};

describe('the Slideless identity, by its observable bytes', () => {
  it('legacyConfigDir: a config left at $XDG_CONFIG_HOME/slideless/config.json is imported', async () => {
    const env = await tempConfigEnv();
    const dir = join(env.XDG_CONFIG_HOME!, 'slideless');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'config.json'), JSON.stringify(LEGACY, null, 2));
    const h = routedHarness([meRoute], env);
    const code = await run(['whoami'], h.io);
    expect(h.err()).toBe('');
    expect(code).toBe(0);
    expect(h.out()).toContain('http://legacy-inst');
    expect(h.wire).toEqual([
      {
        method: 'GET',
        origin: 'http://legacy-inst',
        path: '/api/v1/me',
        auth: 'Bearer slk_abcdefgh_0123456789abcdef'
      }
    ]);
  });

  it('tool: the profiles live in $XDG_CONFIG_HOME/antasphere/tools/slideless.json', async () => {
    const env = await tempConfigEnv();
    const dir = join(env.XDG_CONFIG_HOME!, 'slideless');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'config.json'), JSON.stringify(LEGACY, null, 2));
    const h = routedHarness([], env);
    expect(await run(['profiles'], h.io)).toBe(0);
    const saved = await readFile(join(env.XDG_CONFIG_HOME!, 'antasphere', 'tools', 'slideless.json'), 'utf8');
    expect(JSON.parse(saved)).toEqual(LEGACY);
  });

  it('bin: the program is called `slideless`', async () => {
    const h = routedHarness([]);
    expect(await run(['--help'], h.io)).toBe(0);
    expect(h.out().split('\n')[0]).toBe('Usage: slideless [options] [command]');
  });

  it('envPrefix: SLIDELESS_URL and SLIDELESS_API_KEY are the variables that are read', async () => {
    const env = await tempConfigEnv();
    const h = routedHarness([meRoute], {
      ...env,
      SLIDELESS_URL: 'http://from-env',
      SLIDELESS_API_KEY: 'slk_envkey12_0123456789abcdef'
    });
    expect(await run(['whoami'], h.io)).toBe(0);
    expect(h.wire).toEqual([
      {
        method: 'GET',
        origin: 'http://from-env',
        path: '/api/v1/me',
        auth: 'Bearer slk_envkey12_0123456789abcdef'
      }
    ]);
  });

  it('displayName, keyPrefix, envPrefix: the missing-hub-login sentence, whole', async () => {
    const env = await tempConfigEnv();
    const h = routedHarness(
      [{ method: 'GET', path: /\/api\/v1\/instance$/, reply: () => ({ body: CLOUD_INSTANCE }) }],
      env
    );
    expect(await run(['list', '--api-url', 'http://tool'], h.io)).toBe(1);
    expect(h.err()).toBe(
      'Error: This Slideless instance signs in through the Antasphere hub. Run `antasphere login` once, ' +
        'then retry — or pass --api-key <slk_…> / set SLIDELESS_API_KEY.\n'
    );
  });

  it('bin again: the 401 hint names `slideless verify` (M18)', async () => {
    const h = routedHarness([
      {
        method: 'GET',
        path: /\/api\/v1\/me$/,
        reply: () => ({ status: 401, body: { error: { code: 'invalid_api_key', message: 'bad key' } } })
      }
    ]);
    expect(await run(['whoami', '--url', 'http://x', '--api-key', 'slk_k_s'], h.io)).toBe(1);
    expect(h.err()).toBe('Error: bad key (check the key: `slideless verify`)\n');
  });

  it('exportScope: `export --help` names the scope the key needs (PRDCT-2531, verifier F-5)', async () => {
    // Commander prints a subcommand's help and exits the process; `helpInformation()` is the
    // same text without the exit. The description line, whole: the third line of the output.
    const exportCommand = buildProgram(routedHarness([]).io).commands.find((c) => c.name() === 'export')!;
    expect(exportCommand.helpInformation().split('\n').slice(0, 3)).toEqual([
      'Usage: slideless export [options]',
      '',
      'Download the full workspace export as a zip (key needs data:export)'
    ]);
  });
});

describe("the tool's errorHint (F-3)", () => {
  it('a push whose first commit answers 409 version_conflict carries the hint', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'slideless-hint-'));
    await writeFile(join(dir, 'index.html'), '<html>v1</html>');
    const SESSION_ID = '33333333-3333-3333-3333-333333333333';
    const h = routedHarness([
      {
        method: 'POST',
        path: /\/api\/v1\/presentations\/precheck$/,
        reply: () => ({ body: { missing: [] } })
      },
      {
        method: 'POST',
        path: /\/api\/v1\/presentations\/uploads$/,
        reply: () => ({
          status: 201,
          body: {
            uploadSession: {
              id: SESSION_ID,
              presentationId: '11111111-1111-1111-1111-111111111111',
              expiresAt: '2026-01-01T01:00:00.000Z',
              createdAt: '2026-01-01T00:00:00.000Z'
            }
          }
        })
      },
      {
        method: 'POST',
        path: new RegExp(`/api/v1/presentations/uploads/${SESSION_ID}/commit$`),
        reply: () => ({ status: 409, body: { error: { code: 'version_conflict', message: 'conflict' } } })
      }
    ]);
    const code = await run(
      ['push', dir, '--title', 'Deck', '--url', 'http://x', '--api-key', 'slk_k_s'],
      h.io
    );
    expect(code).toBe(1);
    expect(h.err()).toBe('Error: conflict (someone pushed in between — rerun to retry)\n');
  });
});

/** Every top-level command, in the order `--help` and the completion scripts print them. */
const COMMANDS = [
  // chassis: identity and profiles, then the workspace selection
  'auth',
  'login',
  'logout',
  'whoami',
  'verify',
  'use',
  'profiles',
  'config',
  'workspaces',
  'workspace',
  // chassis: the subgroups of the workspace (the tool hangs link/unlink/brand
  // off this same group, which is why it keeps its place here).
  'projects',
  // Slideless: decks, authoring, references, sharing, response files
  'list',
  'get',
  'meta',
  'versions',
  'delete',
  'push',
  'open',
  'agent-doc',
  'pull',
  'pull-annotations',
  'annotation',
  'dev',
  'reference',
  'brand',
  'template',
  'share',
  'unshare',
  'share-email',
  'pin',
  'tokens',
  'views',
  'responses',
  'response',
  'uploads',
  'notify',
  'invite',
  'uninvite',
  'response-files',
  // chassis: the platform substrate, then completion LAST
  'instance',
  'export',
  'files',
  'completion'
];

describe('the order of the top-level commands (F-2)', () => {
  it('the built program registers them in this order', () => {
    const h = routedHarness([]);
    expect(buildProgram(h.io).commands.map((c) => c.name())).toEqual(COMMANDS);
  });

  it('`--help` lists them in this order, `help` last', async () => {
    const h = routedHarness([]);
    expect(await run(['--help'], h.io)).toBe(0);
    const block = h.out().split('Commands:\n')[1]!;
    const names = block
      .split('\n')
      .filter((line) => /^ {2}\S/.test(line))
      .map((line) => line.trim().split(/[ |]/)[0]);
    expect(names).toEqual([...COMMANDS, 'help']);
  });

  it('`completion bash` offers them in this order', async () => {
    const h = routedHarness([]);
    expect(await run(['completion', 'bash'], h.io)).toBe(0);
    expect(h.out()).toContain(`compgen -W "${COMMANDS.join(' ')}" -- "$cur"`);
  });
});
