import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HUB_TOOL, saveConfig as saveCoreConfig } from '@antasphere/cli-core';
import { run } from '../src/index.js';
import { loadConfig, saveConfig } from '../src/cli.js';
import { DECK, routedHarness, tempConfigEnv, type Route } from './harness.js';

/**
 * PRDCT-2419 through the CLI harness: one person in two workspaces, a fake
 * instance that answers like the real one — the deck list and `/me` follow
 * the `x-workspace-id` header, a workspace that is not the person's answers
 * 401 `invalid_api_key` (resolve-membership.ts: no oracle), and a pinned key
 * answers 403 `workspace_mismatch` to any other workspace.
 */

const URL = 'http://x';
const ACME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NORD = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ELSEWHERE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const KEY = 'slk_free_secret';
const PINNED_KEY = 'slk_pinned_secret';

const WORKSPACES = [
  {
    id: ACME,
    name: 'Acme',
    role: 'owner',
    hubOrigin: false,
    look: { theme: null, pattern: null, field: null, grain: null },
    suspended: false,
    default: true
  },
  {
    id: NORD,
    name: 'Atelier Nord',
    role: 'member',
    hubOrigin: false,
    look: { theme: null, pattern: null, field: null, grain: null },
    suspended: false,
    default: false
  }
];
const DECKS: Record<string, unknown[]> = {
  [ACME]: [{ ...DECK, id: '11111111-1111-1111-1111-111111111111', title: 'Acme pitch' }],
  [NORD]: [
    { ...DECK, id: '22222222-2222-2222-2222-222222222222', title: 'Nord roadmap' },
    { ...DECK, id: '33333333-3333-3333-3333-333333333333', title: 'Nord budget' }
  ]
};

const refuse = (status: number, code: string, message: string) => ({
  status,
  body: { error: { code, message } }
});

/** The server's selection rule, as auth-context.ts + resolve-membership.ts apply it. */
function resolveWorkspace(headers: Headers): { id: string } | ReturnType<typeof refuse> {
  const key = headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (key !== KEY && key !== PINNED_KEY) return refuse(401, 'invalid_api_key', 'API key not recognized');
  const requested = headers.get('x-workspace-id');
  if (key === PINNED_KEY) {
    if (requested && requested !== ACME) {
      return refuse(403, 'workspace_mismatch', 'This credential is pinned to a different workspace');
    }
    return { id: ACME };
  }
  if (!requested) return { id: ACME };
  if (!WORKSPACES.some((w) => w.id === requested)) {
    return refuse(401, 'invalid_api_key', 'API key not recognized');
  }
  return { id: requested };
}

function instance(workspaces = WORKSPACES): Route[] {
  return [
    {
      method: 'GET',
      path: /^\/api\/v1\/me$/,
      reply: ({ headers }) => {
        const resolved = resolveWorkspace(headers);
        if (!('id' in resolved)) return resolved;
        const active = workspaces.find((w) => w.id === resolved.id)!;
        return {
          body: {
            user: { id: 'u1', name: 'Ada', email: 'ada@x.co' },
            workspace: { id: active.id, name: active.name, hubOrigin: false, look: active.look },
            role: active.role,
            origin: 'local',
            via: 'api_key',
            scopes: ['presentations:read', 'presentations:write'],
            apiKeyExpiresAt: null,
            workspaces,
            activeWorkspaceId: active.id,
            hubManageUrl: null,
            canCreateWorkspace: false
          }
        };
      }
    },
    {
      method: 'GET',
      path: /^\/api\/v1\/presentations$/,
      reply: ({ headers }) => {
        const resolved = resolveWorkspace(headers);
        if (!('id' in resolved)) return resolved;
        return { body: { presentations: DECKS[resolved.id], nextCursor: null } };
      }
    }
  ];
}

/** A saved profile on the instance, optionally with a saved selection. */
async function profileEnv(activeWorkspaceId?: string, baseUrl = URL): Promise<Record<string, string>> {
  const env = await tempConfigEnv();
  saveConfig(env, {
    activeProfile: 'work',
    profiles: { work: { apiKey: KEY, baseUrl, ...(activeWorkspaceId ? { activeWorkspaceId } : {}) } }
  });
  return env;
}

const titles = (out: string) =>
  (JSON.parse(out) as { presentations: { title: string }[] }).presentations.map((p) => p.title);

describe('a person in two workspaces lists two deck sets', () => {
  it('with nothing selected, no header is sent and the server default answers', async () => {
    const h = routedHarness(instance(), await profileEnv());
    expect(await run(['list', '--json'], h.io)).toBe(0);
    expect(titles(h.out())).toEqual(['Acme pitch']);
    expect(h.wire).toEqual([
      { method: 'GET', origin: URL, path: '/api/v1/presentations', auth: `Bearer ${KEY}` }
    ]);
  });

  it('--workspace <id> sends the id as it is, with no extra request', async () => {
    const h = routedHarness(instance(), await profileEnv());
    expect(await run(['list', '--json', '--workspace', NORD], h.io)).toBe(0);
    expect(titles(h.out())).toEqual(['Nord roadmap', 'Nord budget']);
    expect(h.wire).toEqual([
      { method: 'GET', origin: URL, path: '/api/v1/presentations', auth: `Bearer ${KEY}`, workspace: NORD }
    ]);
  });

  it('--workspace <name> looks the id up in /me first, without regard to case', async () => {
    const h = routedHarness(instance(), await profileEnv());
    expect(await run(['--workspace', 'atelier nord', 'list', '--json'], h.io)).toBe(0);
    expect(titles(h.out())).toEqual(['Nord roadmap', 'Nord budget']);
    expect(h.wire.map((c) => [c.path, c.workspace])).toEqual([
      ['/api/v1/me', undefined],
      ['/api/v1/presentations', NORD]
    ]);
  });

  it('SLIDELESS_WORKSPACE selects it', async () => {
    const h = routedHarness(instance(), { ...(await profileEnv()), SLIDELESS_WORKSPACE: NORD });
    expect(await run(['list', '--json'], h.io)).toBe(0);
    expect(titles(h.out())).toEqual(['Nord roadmap', 'Nord budget']);
  });

  it('the profile field selects it', async () => {
    const h = routedHarness(instance(), await profileEnv(NORD));
    expect(await run(['list', '--json'], h.io)).toBe(0);
    expect(titles(h.out())).toEqual(['Nord roadmap', 'Nord budget']);
  });

  it('the flag wins over the variable, and the variable over the profile', async () => {
    const env = { ...(await profileEnv(NORD)), SLIDELESS_WORKSPACE: ACME };
    const viaEnv = routedHarness(instance(), env);
    expect(await run(['list', '--json'], viaEnv.io)).toBe(0);
    expect(titles(viaEnv.out())).toEqual(['Acme pitch']);

    const viaFlag = routedHarness(instance(), env);
    expect(await run(['list', '--json', '--workspace', NORD], viaFlag.io)).toBe(0);
    expect(titles(viaFlag.out())).toEqual(['Nord roadmap', 'Nord budget']);
  });

  it('the profile field is ignored when the request goes to another instance', async () => {
    const h = routedHarness(instance(), await profileEnv(NORD));
    expect(await run(['list', '--json', '--api-url', 'http://other'], h.io)).toBe(0);
    expect(h.wire).toEqual([
      { method: 'GET', origin: 'http://other', path: '/api/v1/presentations', auth: `Bearer ${KEY}` }
    ]);
  });

  it('files download, which bypasses the SDK client, carries the selection too', async () => {
    const routes: Route[] = [
      {
        method: 'GET',
        path: /^\/api\/v1\/files\/f1$/,
        reply: () => ({ body: { id: 'f1', originalName: 'a.txt', sizeBytes: 2, contentType: 'text/plain' } })
      },
      { method: 'GET', path: /^\/api\/v1\/files\/f1\/content$/, reply: () => ({ raw: new Response('hi') }) }
    ];
    const env = await profileEnv(NORD);
    const h = routedHarness(routes, env);
    expect(await run(['files', 'download', 'f1', '--out', join(env.XDG_CONFIG_HOME!, 'a.txt')], h.io)).toBe(
      0
    );
    expect(h.wire.map((c) => [c.path, c.workspace])).toEqual([
      ['/api/v1/files/f1', NORD],
      ['/api/v1/files/f1/content', NORD]
    ]);
  });
});

describe('a selection that names nothing usable', () => {
  it('an unknown name errors before any command request, and lists the candidates', async () => {
    const h = routedHarness(instance(), await profileEnv());
    expect(await run(['list', '--workspace', 'Nowhere'], h.io)).toBe(1);
    expect(h.err()).toContain('"Nowhere" is not one of your workspaces');
    expect(h.err()).toContain(`${NORD}  member  Atelier Nord`);
    expect(h.wire.map((c) => c.path)).toEqual(['/api/v1/me']);
  });

  it('an ambiguous name errors and lists the two', async () => {
    const twins = [...WORKSPACES, { ...WORKSPACES[1]!, id: ELSEWHERE, name: 'ATELIER NORD' }];
    const h = routedHarness(instance(twins), await profileEnv());
    expect(await run(['list', '--workspace', 'Atelier Nord'], h.io)).toBe(1);
    expect(h.err()).toContain('Several of your workspaces are named "Atelier Nord"');
    expect(h.err()).toContain(NORD);
    expect(h.err()).toContain(ELSEWHERE);
    expect(h.err()).not.toContain(ACME);
  });

  it('an empty --workspace is a usage error and sends nothing', async () => {
    const h = routedHarness(instance(), await profileEnv(NORD));
    expect(await run(['list', '--workspace', ' '], h.io)).toBe(1);
    expect(h.err()).toContain('--workspace needs a workspace id or name');
    expect(h.wire).toEqual([]);
  });

  it("an id that is not yours: the server's 401 becomes a sentence that clears the key", async () => {
    const h = routedHarness(instance(), await profileEnv(ELSEWHERE));
    expect(await run(['list'], h.io)).toBe(1);
    expect(h.err()).toContain(
      `The workspace "${ELSEWHERE}" (selected by profile "work") is not one of yours`
    );
    expect(h.err()).toContain('the API key itself works');
    expect(h.err()).toContain('slideless workspace use --clear');
    expect(h.err()).not.toContain('check the key');
    // The probe is /me WITHOUT the selection.
    expect(h.wire.map((c) => [c.path, c.workspace])).toEqual([
      ['/api/v1/presentations', ELSEWHERE],
      ['/api/v1/me', undefined]
    ]);
  });

  it('a key that really is bad keeps the plain 401, selection or not', async () => {
    const h = routedHarness(instance(), await profileEnv());
    expect(await run(['list', '--api-key', 'slk_wrong_key', '--workspace', NORD], h.io)).toBe(1);
    expect(h.err()).toContain('API key not recognized');
    expect(h.err()).toContain('check the key');
    expect(h.err()).not.toContain('is not one of yours');
  });

  it('a 401 with nothing selected is never probed', async () => {
    const h = routedHarness(instance(), await profileEnv());
    expect(await run(['list', '--api-key', 'slk_wrong_key'], h.io)).toBe(1);
    expect(h.wire.map((c) => c.path)).toEqual(['/api/v1/presentations']);
  });

  it('a pinned key selecting another workspace: the 403 becomes a sentence naming the pin', async () => {
    const h = routedHarness(instance(), await profileEnv());
    expect(await run(['list', '--api-key', PINNED_KEY, '--workspace', 'Atelier Nord'], h.io)).toBe(1);
    expect(h.err()).toContain(`This API key is pinned to the workspace "Acme" (${ACME})`);
    expect(h.err()).toContain(`the --workspace flag selects "Atelier Nord" (${NORD})`);
    expect(h.err()).not.toContain('not allowed to do that');
  });

  it('a pinned key selecting its own workspace works', async () => {
    const h = routedHarness(instance(), await profileEnv());
    expect(await run(['list', '--json', '--api-key', PINNED_KEY, '--workspace', 'acme'], h.io)).toBe(0);
    expect(titles(h.out())).toEqual(['Acme pitch']);
  });
});

describe('a deck id asked of another workspace', () => {
  const missing: Route = {
    method: 'GET',
    path: /^\/api\/v1\/presentations\/[^/]+$/,
    reply: () => refuse(404, 'not_found', 'Presentation not found')
  };

  it('the 404 names the workspace that was asked, and what selected it', async () => {
    const h = routedHarness([missing], await profileEnv(NORD));
    expect(await run(['get', DECK.id], h.io)).toBe(1);
    expect(h.err()).toBe(
      `Error: Presentation not found (looked in the workspace "${NORD}", selected by profile "work")\n`
    );
  });

  it('with nothing selected the 404 is the plain one', async () => {
    const h = routedHarness([missing], await profileEnv());
    expect(await run(['get', DECK.id], h.io)).toBe(1);
    expect(h.err()).toBe('Error: Presentation not found\n');
  });
});

describe('whoami shows the workspace the command ran in, and what chose it', () => {
  it.each([
    ['the flag', ['--workspace', NORD], {}, undefined, 'the --workspace flag', 'flag', 'Atelier Nord'],
    [
      'the variable',
      [],
      { SLIDELESS_WORKSPACE: 'Atelier Nord' },
      undefined,
      'SLIDELESS_WORKSPACE',
      'env',
      'Atelier Nord'
    ],
    ['the profile', [], {}, NORD, 'profile "work"', 'profile', 'Atelier Nord'],
    ['nothing', [], {}, undefined, "the server's default", 'default', 'Acme']
  ] as const)('chosen by %s', async (_label, args, extraEnv, saved, words, source, name) => {
    const env = { ...(await profileEnv(saved)), ...extraEnv };
    const human = routedHarness(instance(), env);
    expect(await run(['whoami', ...args], human.io)).toBe(0);
    expect(human.out()).toContain(`workspace: ${name} (${name === 'Acme' ? ACME : NORD})`);
    expect(human.out()).toContain(`chosen by: ${words}`);

    const json = routedHarness(instance(), env);
    expect(await run(['whoami', '--json', ...args], json.io)).toBe(0);
    const parsed = JSON.parse(json.out()) as {
      workspaceSource: string;
      activeWorkspaceId: string;
      user: unknown;
    };
    expect(parsed.workspaceSource).toBe(source);
    expect(parsed.activeWorkspaceId).toBe(name === 'Acme' ? ACME : NORD);
    expect(parsed.user).toEqual({ id: 'u1', name: 'Ada', email: 'ada@x.co' });
  });
});

describe('slideless workspaces', () => {
  it('lists id, role and name, the default mark and the selected mark', async () => {
    const h = routedHarness(instance(), await profileEnv(NORD));
    expect(await run(['workspaces'], h.io)).toBe(0);
    const lines = h.out().split('\n');
    expect(lines[0]).toBe(`  ${ACME}  owner   Acme  (default)`);
    expect(lines[1]).toBe(`* ${NORD}  member  Atelier Nord`);
    expect(h.out()).toContain('chosen by profile "work"');
  });

  it('with nothing selected, the mark is on the workspace the server resolved', async () => {
    const h = routedHarness(instance(), await profileEnv());
    expect(await run(['workspaces'], h.io)).toBe(0);
    expect(h.out().split('\n')[0]).toBe(`* ${ACME}  owner   Acme  (default)`);
    expect(h.out()).toContain('chosen by the server');
  });

  it('--json carries the memberships, the selected id and the source', async () => {
    const h = routedHarness(instance(), { ...(await profileEnv()), SLIDELESS_WORKSPACE: 'atelier nord' });
    expect(await run(['workspaces', '--json'], h.io)).toBe(0);
    expect(JSON.parse(h.out())).toEqual({ workspaces: WORKSPACES, selectedWorkspaceId: NORD, source: 'env' });
  });

  it('never sends the selection, so it still answers when the selection is stale, and says so', async () => {
    const h = routedHarness(instance(), await profileEnv(ELSEWHERE));
    expect(await run(['workspaces'], h.io)).toBe(0);
    expect(h.wire).toEqual([{ method: 'GET', origin: URL, path: '/api/v1/me', auth: `Bearer ${KEY}` }]);
    expect(h.err()).toContain(`"${ELSEWHERE}" (selected by profile "work") names none of these workspaces`);
    expect(
      h
        .out()
        .split('\n')
        .filter((line) => /^\* [0-9a-f]/.test(line))
    ).toEqual([]);
    expect(h.out()).toContain('none is marked');
  });

  it('marks a suspended workspace', async () => {
    const list = [WORKSPACES[0]!, { ...WORKSPACES[1]!, suspended: true }];
    const h = routedHarness(instance(list), await profileEnv());
    expect(await run(['workspaces'], h.io)).toBe(0);
    expect(h.out()).toContain('Atelier Nord  [suspended]');
  });

  it('strips terminal control sequences from a workspace name somebody else chose', async () => {
    const list = [WORKSPACES[0]!, { ...WORKSPACES[1]!, name: 'Nord\u001b[2K\u001b]52;c;eA==\u0007' }];
    const h = routedHarness(instance(list), await profileEnv());
    expect(await run(['workspaces'], h.io)).toBe(0);
    expect(h.out()).not.toContain('\u001b');
    expect(h.out()).toContain('member  Nord\n');
  });
});

describe('slideless workspace use', () => {
  it('saves the ID on the profile from a name, and later commands run there', async () => {
    const env = await profileEnv();
    const h = routedHarness(instance(), env);
    expect(await run(['workspace', 'use', 'atelier nord'], h.io)).toBe(0);
    expect(h.out()).toContain(`Profile "work" now runs in "Atelier Nord" (${NORD})`);
    expect(loadConfig(env).profiles.work).toEqual({ apiKey: KEY, baseUrl: URL, activeWorkspaceId: NORD });

    const after = routedHarness(instance(), env);
    expect(await run(['list', '--json'], after.io)).toBe(0);
    expect(titles(after.out())).toEqual(['Nord roadmap', 'Nord budget']);
  });

  it('keeps the config file private (0600)', async () => {
    const env = await profileEnv();
    expect(await run(['workspace', 'use', NORD], routedHarness(instance(), env).io)).toBe(0);
    const file = join(env.XDG_CONFIG_HOME!, 'antasphere', 'tools', 'slideless.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8')).profiles.work.activeWorkspaceId).toBe(NORD);
  });

  it('--json answers the profile, the id and the workspace', async () => {
    const h = routedHarness(instance(), await profileEnv());
    expect(await run(['workspace', 'use', NORD, '--json'], h.io)).toBe(0);
    expect(JSON.parse(h.out())).toEqual({
      profile: 'work',
      activeWorkspaceId: NORD,
      workspace: { id: NORD, name: 'Atelier Nord', role: 'member' }
    });
  });

  it('refuses a workspace that is not yours and writes nothing', async () => {
    const env = await profileEnv(ACME);
    const h = routedHarness(instance(), env);
    expect(await run(['workspace', 'use', ELSEWHERE], h.io)).toBe(1);
    expect(h.err()).toContain('is not one of your workspaces');
    expect(loadConfig(env).profiles.work?.activeWorkspaceId).toBe(ACME);
  });

  it('replaces a stale selection: the saved one is never sent while choosing', async () => {
    const env = await profileEnv(ELSEWHERE);
    const h = routedHarness(instance(), env);
    expect(await run(['workspace', 'use', 'Acme'], h.io)).toBe(0);
    expect(h.wire.map((c) => c.workspace)).toEqual([undefined]);
    expect(loadConfig(env).profiles.work?.activeWorkspaceId).toBe(ACME);
  });

  it('--clear removes the field without a request', async () => {
    const env = await profileEnv(NORD);
    const h = routedHarness(instance(), env);
    expect(await run(['workspace', 'use', '--clear'], h.io)).toBe(0);
    expect(h.wire).toEqual([]);
    expect(loadConfig(env).profiles.work).toEqual({ apiKey: KEY, baseUrl: URL });
    expect(h.out()).toContain('selects no workspace');
  });

  it('writes the profile --profile names, not the active one', async () => {
    const env = await profileEnv();
    const config = loadConfig(env);
    config.profiles.other = { apiKey: KEY, baseUrl: URL };
    saveConfig(env, config);
    expect(
      await run(['workspace', 'use', NORD, '--profile', 'other'], routedHarness(instance(), env).io)
    ).toBe(0);
    expect(loadConfig(env).profiles.other?.activeWorkspaceId).toBe(NORD);
    expect(loadConfig(env).profiles.work?.activeWorkspaceId).toBeUndefined();
  });

  it('needs exactly one of a workspace or --clear', async () => {
    const both = routedHarness(instance(), await profileEnv());
    expect(await run(['workspace', 'use', NORD, '--clear'], both.io)).toBe(1);
    const none = routedHarness(instance(), await profileEnv());
    expect(await run(['workspace', 'use'], none.io)).toBe(1);
    expect(none.err()).toContain('exactly one of');
    expect([...both.wire, ...none.wire]).toEqual([]);
  });

  it('needs a profile to write to', async () => {
    const h = routedHarness(instance(), {
      ...(await tempConfigEnv()),
      SLIDELESS_URL: URL,
      SLIDELESS_API_KEY: KEY
    });
    expect(await run(['workspace', 'use', NORD], h.io)).toBe(1);
    expect(h.err()).toContain('No profile to save the selection on');
  });

  it('refuses to save an id looked up on another instance than the profile names', async () => {
    const env = await profileEnv();
    const h = routedHarness(instance(), env);
    expect(await run(['workspace', 'use', NORD, '--api-url', 'http://other'], h.io)).toBe(1);
    expect(h.err()).toContain('A workspace belongs to one instance');
    expect(h.wire).toEqual([]);
    expect(loadConfig(env).profiles.work?.activeWorkspaceId).toBeUndefined();
  });

  it('says so when SLIDELESS_WORKSPACE still wins over what was just saved', async () => {
    const h = routedHarness(instance(), { ...(await profileEnv()), SLIDELESS_WORKSPACE: ACME });
    expect(await run(['workspace', 'use', NORD], h.io)).toBe(0);
    expect(h.err()).toContain('SLIDELESS_WORKSPACE is set and wins over the profile');
  });
});

describe('the selection goes with the identity', () => {
  it('logout removes it', async () => {
    const env = await profileEnv(NORD);
    expect(await run(['logout'], routedHarness(instance(), env).io)).toBe(0);
    expect(loadConfig(env).profiles.work).toEqual({ baseUrl: URL });
  });

  it('a login on the same instance keeps it; a login that moves the profile drops it', async () => {
    const env = await profileEnv(NORD);
    expect(
      await run(['login', '--api-key', KEY, '--profile', 'work'], routedHarness(instance(), env).io)
    ).toBe(0);
    expect(loadConfig(env).profiles.work?.activeWorkspaceId).toBe(NORD);

    const moved = routedHarness(instance(), env);
    expect(
      await run(['login', '--api-key', KEY, '--profile', 'work', '--api-url', 'http://other/'], moved.io)
    ).toBe(0);
    expect(loadConfig(env).profiles.work).toEqual({ apiKey: KEY, baseUrl: 'http://other' });
  });

  it('config show prints the saved selection', async () => {
    const h = routedHarness(instance(), await profileEnv(NORD));
    expect(await run(['config', 'show', '--json'], h.io)).toBe(0);
    expect(
      (JSON.parse(h.out()) as { profiles: Record<string, { activeWorkspaceId: string | null }> }).profiles
        .work!.activeWorkspaceId
    ).toBe(NORD);
  });
});

/**
 * The gaps the verifier's mutation battery found on 19 September 2026
 * (verifier-1.md in the workstream bundle): behaviours that were right but
 * that no test pinned. One test each.
 */
describe('pinned after the verifier round', () => {
  it('G3: on the connect path, the name lookup carries the MINTED key, never goes out bare', async () => {
    const env = await tempConfigEnv();
    const SLK = 'slk_minted12_0123456789abcdefghijklmnopqrstuvwxyz';
    saveCoreConfig(env, HUB_TOOL, {
      activeProfile: 'default',
      profiles: {
        default: { apiKey: 'ant_hubkey12_secretsecretsecret1234', baseUrl: 'http://hub', email: 'ada@x.co' }
      }
    });
    saveConfig(env, { activeProfile: 'work', profiles: { work: { baseUrl: URL } } });
    const routes: Route[] = [
      {
        method: 'GET',
        path: /\/api\/v1\/instance$/,
        reply: () => ({
          body: {
            name: 'Cloud',
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
          }
        })
      },
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
        reply: () => ({
          status: 201,
          body: {
            key: SLK,
            apiKey: {
              id: 'k1',
              name: 'connect',
              keyId: 'minted12',
              scopes: [],
              createdBy: 'u1',
              createdAt: 'x',
              lastUsedAt: null,
              revokedAt: null,
              expiresAt: null
            },
            user: { id: 'u1', email: 'ada@x.co', name: 'Ada' },
            workspaceId: null
          }
        })
      },
      {
        method: 'GET',
        path: /^\/api\/v1\/me$/,
        reply: ({ headers }) =>
          headers.get('authorization') === `Bearer ${SLK}`
            ? {
                body: {
                  user: { id: 'u1', name: 'Ada', email: 'ada@x.co' },
                  workspaces: WORKSPACES,
                  activeWorkspaceId: ACME
                }
              }
            : refuse(401, 'invalid_api_key', 'API key not recognized')
      },
      {
        method: 'GET',
        path: /^\/api\/v1\/presentations$/,
        reply: () => ({ body: { presentations: [], nextCursor: null } })
      }
    ];
    const h = routedHarness(routes, env);
    expect(await run(['list', '--workspace', 'atelier nord'], h.io)).toBe(0);
    const me = h.wire.find((c) => c.path === '/api/v1/me');
    expect(me?.auth).toBe(`Bearer ${SLK}`);
    expect(h.wire.at(-1)).toMatchObject({
      path: '/api/v1/presentations',
      auth: `Bearer ${SLK}`,
      workspace: NORD
    });
  });

  it('G1: workspace use re-reads the config before writing, so a key cached meanwhile survives', async () => {
    const env = await profileEnv();
    const routes = instance().map((r) =>
      r.path.test('/api/v1/me')
        ? {
            ...r,
            reply: (call: Parameters<Route['reply']>[0]) => {
              // Something else wrote the profile between the read and the save.
              const config = loadConfig(env);
              config.profiles.work = {
                ...config.profiles.work,
                connectKeys: { hub: { apiKey: 'slk_cached_key' } }
              };
              saveConfig(env, config);
              return r.reply(call);
            }
          }
        : r
    );
    expect(await run(['workspace', 'use', NORD], routedHarness(routes, env).io)).toBe(0);
    expect(loadConfig(env).profiles.work).toEqual({
      apiKey: KEY,
      baseUrl: URL,
      connectKeys: { hub: { apiKey: 'slk_cached_key' } },
      activeWorkspaceId: NORD
    });
  });

  it('G5: the hub-connect logout drops the selection too', async () => {
    const env = await tempConfigEnv();
    saveConfig(env, {
      activeProfile: 'work',
      profiles: { work: { baseUrl: URL, connectKeys: { hub: { apiKey: KEY } }, activeWorkspaceId: NORD } }
    });
    const revoke: Route = {
      method: 'DELETE',
      path: /\/api\/v1\/cli\/auth\/key$/,
      reply: () => ({ body: { revoked: true } })
    };
    expect(await run(['logout'], routedHarness([revoke], env).io)).toBe(0);
    expect(loadConfig(env).profiles.work).toEqual({ baseUrl: URL });
  });

  it('G2: workspace use says so when the chosen workspace is suspended', async () => {
    const list = [WORKSPACES[0]!, { ...WORKSPACES[1]!, suspended: true }];
    const h = routedHarness(instance(list), await profileEnv());
    expect(await run(['workspace', 'use', NORD], h.io)).toBe(0);
    expect(h.out()).toContain('This workspace is suspended: requests into it are refused.');
  });

  it('G4: the stale-selection warning points at --clear for a profile selection only', async () => {
    const viaProfile = routedHarness(instance(), await profileEnv(ELSEWHERE));
    expect(await run(['workspaces'], viaProfile.io)).toBe(0);
    expect(viaProfile.err()).toContain('Drop it with `slideless workspace use --clear`.');
    const viaEnv = routedHarness(instance(), { ...(await profileEnv()), SLIDELESS_WORKSPACE: ELSEWHERE });
    expect(await run(['workspaces'], viaEnv.io)).toBe(0);
    expect(viaEnv.err()).toContain('names none of these workspaces');
    expect(viaEnv.err()).not.toContain('--clear');
  });

  it('G6: a saved selection with whitespace around it is sent trimmed', async () => {
    const h = routedHarness(instance(), await profileEnv(`  ${NORD}\n`));
    expect(await run(['list', '--json'], h.io)).toBe(0);
    expect(h.wire[0]?.workspace).toBe(NORD);
  });

  it('G7: an id typed in capitals still matches the membership', async () => {
    const h = routedHarness(instance(), await profileEnv());
    expect(await run(['workspace', 'use', NORD.toUpperCase(), '--json'], h.io)).toBe(0);
    expect(JSON.parse(h.out()).activeWorkspaceId).toBe(NORD);
  });

  it('G9: the 404 hint echoes what the person typed, not the resolved id', async () => {
    const routes: Route[] = [
      ...instance(),
      {
        method: 'GET',
        path: /^\/api\/v1\/presentations\/[^/]+$/,
        reply: () => refuse(404, 'not_found', 'Presentation not found')
      }
    ];
    const h = routedHarness(routes, await profileEnv());
    expect(await run(['get', DECK.id, '--workspace', 'Atelier Nord'], h.io)).toBe(1);
    expect(h.err()).toContain('looked in the workspace "Atelier Nord", selected by the --workspace flag');
  });
});
