import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HUB_TOOL, saveConfig as saveCoreConfig } from '@antasphere/cli-core';
import { run } from '../src/index.js';
import { saveConfig } from '../src/cli.js';
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
    centralAccountId: null as string | null,
    look: { theme: null, pattern: null, field: null, grain: null },
    suspended: false,
    default: true
  },
  {
    id: NORD,
    name: 'Atelier Nord',
    role: 'member',
    hubOrigin: false,
    centralAccountId: null as string | null,
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

/** A saved profile on the instance (nothing else is saved: a selection is per command). */
async function profileEnv(baseUrl = URL): Promise<Record<string, string>> {
  const env = await tempConfigEnv();
  saveConfig(env, { activeProfile: 'work', profiles: { work: { apiKey: KEY, baseUrl } } });
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

  it('the flag wins over the variable', async () => {
    const env = { ...(await profileEnv()), SLIDELESS_WORKSPACE: ACME };
    const viaEnv = routedHarness(instance(), env);
    expect(await run(['list', '--json'], viaEnv.io)).toBe(0);
    expect(titles(viaEnv.out())).toEqual(['Acme pitch']);

    const viaFlag = routedHarness(instance(), env);
    expect(await run(['list', '--json', '--workspace', NORD], viaFlag.io)).toBe(0);
    expect(titles(viaFlag.out())).toEqual(['Nord roadmap', 'Nord budget']);
  });

  it("the profile's key never travels to another instance named by --api-url", async () => {
    // A profile IS an instance: --api-url http://other selects the profile of
    // THAT instance (none saved: one made in memory, with no key), so the
    // saved key stays home and the probe finds a self-hosted instance.
    const h = routedHarness(instance(), await profileEnv());
    expect(await run(['list', '--json', '--api-url', 'http://other'], h.io)).toBe(1);
    expect(h.wire).toEqual([
      { method: 'GET', origin: 'http://other', path: '/api/v1/instance', auth: undefined }
    ]);
    expect(h.err()).toBe(
      'Error: An API key is required. Sign in (`slideless login`), pass --api-key, or set SLIDELESS_API_KEY.\n'
    );
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
    const env = await profileEnv();
    const h = routedHarness(routes, env);
    expect(
      await run(
        ['files', 'download', 'f1', '--workspace', NORD, '--out', join(env.XDG_CONFIG_HOME!, 'a.txt')],
        h.io
      )
    ).toBe(0);
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
    const h = routedHarness(instance(), { ...(await profileEnv()), SLIDELESS_WORKSPACE: NORD });
    expect(await run(['list', '--workspace', ' '], h.io)).toBe(1);
    expect(h.err()).toContain('--workspace needs a workspace id or name');
    expect(h.wire).toEqual([]);
  });

  it("an id that is not yours: the server's 401 becomes a sentence that clears the key", async () => {
    const h = routedHarness(instance(), await profileEnv());
    expect(await run(['list', '--workspace', ELSEWHERE], h.io)).toBe(1);
    expect(h.err()).toBe(
      `Error: The workspace "${ELSEWHERE}" (selected by the --workspace flag) is not one of yours on ${URL}; ` +
        `the API key itself works. Yours:\n  ${ACME}  owner   Acme\n  ${NORD}  member  Atelier Nord\n`
    );
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
    const h = routedHarness([missing], await profileEnv());
    expect(await run(['get', DECK.id, '--workspace', NORD], h.io)).toBe(1);
    expect(h.err()).toBe(
      `Error: Presentation not found (looked in the workspace "${NORD}", selected by the --workspace flag)\n`
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
    ['the --org flag', ['--org', NORD], {}, undefined, 'the --org flag', 'flag', 'Atelier Nord'],
    [
      'the org variable',
      [],
      { SLIDELESS_ORG: 'atelier nord' },
      undefined,
      'SLIDELESS_ORG',
      'env',
      'Atelier Nord'
    ],
    ['nothing', [], {}, undefined, "the server's default (nothing selected)", 'default', 'Acme']
  ] as const)('chosen by %s', async (_label, args, extraEnv, _saved, words, source, name) => {
    const env = { ...(await profileEnv()), ...extraEnv };
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
    const h = routedHarness(instance(), await profileEnv());
    expect(await run(['workspaces', '--workspace', NORD], h.io)).toBe(0);
    expect(h.out()).toBe(
      `  ${ACME}  owner   Acme  (default)\n` +
        `* ${NORD}  member  Atelier Nord\n` +
        '\n* = the workspace the commands run in, chosen by the --workspace flag\n' +
        '(default) = what a request naming no workspace resolves to\n'
    );
  });

  it('with nothing selected, the mark is on the workspace the server resolved', async () => {
    const h = routedHarness(instance(), await profileEnv());
    expect(await run(['workspaces'], h.io)).toBe(0);
    expect(h.out().split('\n')[0]).toBe(`* ${ACME}  owner   Acme  (default)`);
    expect(h.out()).toContain(
      '* = the workspace the commands run in, chosen by the server (nothing is selected; --org or --workspace selects one per command)\n'
    );
  });

  it('--json carries the memberships, the selected id and the source', async () => {
    const h = routedHarness(instance(), { ...(await profileEnv()), SLIDELESS_WORKSPACE: 'atelier nord' });
    expect(await run(['workspaces', '--json'], h.io)).toBe(0);
    expect(JSON.parse(h.out())).toEqual({ workspaces: WORKSPACES, selectedWorkspaceId: NORD, source: 'env' });
  });

  it('never sends the selection, so it still answers when the selection is stale, and says so', async () => {
    const h = routedHarness(instance(), { ...(await profileEnv()), SLIDELESS_WORKSPACE: ELSEWHERE });
    expect(await run(['workspaces'], h.io)).toBe(0);
    expect(h.wire).toEqual([{ method: 'GET', origin: URL, path: '/api/v1/me', auth: `Bearer ${KEY}` }]);
    expect(h.err()).toBe(
      `Warning: "${ELSEWHERE}" (selected by SLIDELESS_WORKSPACE) names none of these workspaces, ` +
        'so commands that use it are refused.\n'
    );
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

  it('G6: a selection with whitespace around it is sent trimmed', async () => {
    const h = routedHarness(instance(), { ...(await profileEnv()), SLIDELESS_WORKSPACE: `  ${NORD}\n` });
    expect(await run(['list', '--json'], h.io)).toBe(0);
    expect(h.wire[0]?.workspace).toBe(NORD);
  });

  it('G7: an id typed in capitals still matches the membership', async () => {
    const routes: Route[] = [
      ...instance(),
      {
        method: 'PUT',
        path: /^\/api\/v1\/me\/default-workspace$/,
        reply: ({ body }) => ({ body: { defaultWorkspaceId: (body as { workspaceId: string }).workspaceId } })
      }
    ];
    const h = routedHarness(routes, await profileEnv());
    expect(await run(['workspace', 'default', NORD.toUpperCase(), '--json'], h.io)).toBe(0);
    expect(JSON.parse(h.out()).defaultWorkspaceId).toBe(NORD);
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

/**
 * `slideless workspace default` (PRDCT-2815): the SERVER's default for the
 * person, not the profile's selection. The fake answers PUT
 * /me/default-workspace like the self-hosted handler (200 with the id, 404
 * for a workspace not the person's), or with the refusal a test hands it.
 */
describe('slideless workspace default', () => {
  const HUB_URL = 'https://account.antasphere.test/orgs';

  function withDefault(
    refusal?: ReturnType<typeof refuse> & { body: { error: { details?: unknown } } }
  ): Route[] {
    return [
      ...instance(),
      {
        method: 'PUT',
        path: /^\/api\/v1\/me\/default-workspace$/,
        reply: ({ headers, body }) => {
          const resolved = resolveWorkspace(headers);
          if (!('id' in resolved)) return resolved;
          if (refusal) return refusal;
          const id = (body as { workspaceId: string | null }).workspaceId;
          if (id !== null && !WORKSPACES.some((w) => w.id === id)) {
            return refuse(404, 'not_found', 'Workspace not found');
          }
          return { body: { defaultWorkspaceId: id } };
        }
      }
    ];
  }

  const puts = (h: ReturnType<typeof routedHarness>) =>
    h.wire.filter((c) => c.method === 'PUT' && c.path === '/api/v1/me/default-workspace');

  it('by name: resolves it against /me and sends the id', async () => {
    const h = routedHarness(withDefault(), await profileEnv());
    expect(await run(['workspace', 'default', 'atelier nord'], h.io)).toBe(0);
    expect(h.out()).toBe(
      `"Atelier Nord" (${NORD}) is now your default workspace: a command naming none runs in it.\n`
    );
    expect(h.err()).toBe('');
    expect(h.wire.map((c) => [c.method, c.path])).toEqual([
      ['GET', '/api/v1/me'],
      ['PUT', '/api/v1/me/default-workspace']
    ]);
    expect(puts(h)[0]?.body).toEqual({ workspaceId: NORD });
  });

  it('by id', async () => {
    const h = routedHarness(withDefault(), await profileEnv());
    expect(await run(['workspace', 'default', NORD], h.io)).toBe(0);
    expect(h.out()).toContain(`"Atelier Nord" (${NORD}) is now your default workspace`);
    expect(puts(h)[0]?.body).toEqual({ workspaceId: NORD });
  });

  it('--clear sends null and says the first-joined workspace answers', async () => {
    const h = routedHarness(withDefault(), await profileEnv());
    expect(await run(['workspace', 'default', '--clear'], h.io)).toBe(0);
    expect(h.out()).toBe(
      'No default workspace is chosen: a command naming none runs in the workspace you joined first.\n'
    );
    expect(puts(h)).toHaveLength(1);
    expect(puts(h)[0]?.body).toEqual({ workspaceId: null });
  });

  it('--json with a workspace: the id and the workspace', async () => {
    const h = routedHarness(withDefault(), await profileEnv());
    expect(await run(['workspace', 'default', 'Atelier Nord', '--json'], h.io)).toBe(0);
    expect(JSON.parse(h.out())).toEqual({
      defaultWorkspaceId: NORD,
      workspace: { id: NORD, name: 'Atelier Nord', role: 'member' }
    });
  });

  it('--json with --clear: a null id and no workspace', async () => {
    const h = routedHarness(withDefault(), await profileEnv());
    expect(await run(['workspace', 'default', '--clear', '--json'], h.io)).toBe(0);
    expect(JSON.parse(h.out())).toEqual({ defaultWorkspaceId: null });
  });

  it('needs exactly one of a workspace or --clear', async () => {
    const both = routedHarness(withDefault(), await profileEnv());
    expect(await run(['workspace', 'default', NORD, '--clear'], both.io)).toBe(1);
    expect(both.err()).toContain('Pass exactly one of <workspace> (an id or a name) or --clear.');
    const none = routedHarness(withDefault(), await profileEnv());
    expect(await run(['workspace', 'default'], none.io)).toBe(1);
    expect(none.err()).toContain('Pass exactly one of <workspace> (an id or a name) or --clear.');
    expect([...both.wire, ...none.wire]).toEqual([]);
  });

  it('an unknown name lists the candidates and sets nothing', async () => {
    const h = routedHarness(withDefault(), await profileEnv());
    expect(await run(['workspace', 'default', 'Nowhere'], h.io)).toBe(1);
    expect(h.err()).toContain('"Nowhere" is not one of your workspaces');
    expect(h.err()).toContain(`${NORD}  member  Atelier Nord`);
    expect(puts(h)).toEqual([]);
  });

  it('never sends the selection, neither to /me nor with the PUT', async () => {
    const h = routedHarness(withDefault(), await profileEnv());
    expect(await run(['workspace', 'default', 'Acme', '--workspace', NORD], h.io)).toBe(0);
    expect(h.wire).toHaveLength(2);
    expect(h.wire.map((c) => c.workspace)).toEqual([undefined, undefined]);
  });

  it('a selection naming another workspace: a Note on stderr says it wins', async () => {
    const h = routedHarness(withDefault(), { ...(await profileEnv()), SLIDELESS_WORKSPACE: ACME });
    expect(await run(['workspace', 'default', 'Atelier Nord'], h.io)).toBe(0);
    expect(h.err()).toBe(
      'Note: SLIDELESS_WORKSPACE selects another workspace and wins over the default while it is set.\n'
    );
  });

  it('--clear with a selection: a Note on stderr says the selection still wins', async () => {
    const h = routedHarness(withDefault(), await profileEnv());
    expect(await run(['workspace', 'default', '--clear', '--org', ACME], h.io)).toBe(0);
    expect(puts(h)[0]?.body).toEqual({ workspaceId: null });
    expect(h.err()).toBe(
      'Note: the --org flag selects another workspace and wins over the default while it is set.\n'
    );
  });

  it('--clear with no selection: no note', async () => {
    const h = routedHarness(withDefault(), await profileEnv());
    expect(await run(['workspace', 'default', '--clear'], h.io)).toBe(0);
    expect(puts(h)[0]?.body).toEqual({ workspaceId: null });
    expect(h.err()).toBe('');
  });

  it('a selection naming the same workspace: no note', async () => {
    const h = routedHarness(withDefault(), await profileEnv());
    expect(await run(['workspace', 'default', 'Atelier Nord', '--workspace', 'atelier nord'], h.io)).toBe(0);
    expect(h.err()).toBe('');
  });

  it('403 hub_managed: the account-site sentence with the url, pointing at --org', async () => {
    const refusal = {
      status: 403,
      body: {
        error: {
          code: 'hub_managed',
          message: 'Your default workspace is a setting of your Antasphere account — choose it there',
          details: { manageUrl: HUB_URL }
        }
      }
    };
    const h = routedHarness(withDefault(refusal), await profileEnv());
    expect(await run(['workspace', 'default', 'Atelier Nord'], h.io)).not.toBe(0);
    expect(h.err()).toBe(
      `Error: Your default workspace is a setting of your Antasphere account: choose it on ${HUB_URL}\n` +
        'To run one command elsewhere, pass --org <organization id or name>.\n'
    );
    expect(h.err()).not.toContain('workspace use');
    expect(h.out()).toBe('');
  });

  it('403 key_pinned: its own sentence', async () => {
    const h = routedHarness(
      withDefault(refuse(403, 'key_pinned', 'This key is pinned to one workspace')),
      await profileEnv()
    );
    expect(await run(['workspace', 'default', 'Atelier Nord'], h.io)).not.toBe(0);
    expect(h.err()).toContain(
      'This key is pinned to one workspace and cannot change your default workspace. Use a key that is not pinned.'
    );
    expect(h.out()).toBe('');
  });
});

/**
 * PRDCT-2947: `--org` names an organization the Antasphere way, by the hub
 * organization id the account site shows, or by its name. The fake answers
 * like the cloud instance: a hub-origin workspace carries its
 * `centralAccountId`, and `x-workspace-id` takes either the local id or the
 * hub organization id (the server maps the latter itself).
 */
describe('--org names a hub organization', () => {
  const ORG_ACME = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const ORG_NORD = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const HUB_ROWS = [
    { ...WORKSPACES[0]!, hubOrigin: true, centralAccountId: ORG_ACME },
    { ...WORKSPACES[1]!, hubOrigin: true, centralAccountId: ORG_NORD }
  ];

  function hubInstance(): Route[] {
    const toLocal = (headers: Headers): Headers => {
      const requested = headers.get('x-workspace-id');
      const row = HUB_ROWS.find((w) => w.centralAccountId === requested);
      const mapped = new Headers(headers);
      if (row) mapped.set('x-workspace-id', row.id);
      return mapped;
    };
    return instance(HUB_ROWS).map((r) => ({
      ...r,
      reply: (call: Parameters<Route['reply']>[0]) => r.reply({ ...call, headers: toLocal(call.headers) })
    }));
  }

  it('by its hub id: sent as it is, with no extra request', async () => {
    const h = routedHarness(hubInstance(), await profileEnv());
    expect(await run(['list', '--json', '--org', ORG_NORD], h.io)).toBe(0);
    expect(titles(h.out())).toEqual(['Nord roadmap', 'Nord budget']);
    expect(h.wire).toEqual([
      {
        method: 'GET',
        origin: URL,
        path: '/api/v1/presentations',
        auth: `Bearer ${KEY}`,
        workspace: ORG_NORD
      }
    ]);
  });

  it('by its name: one /me, then the LOCAL id of the row', async () => {
    const h = routedHarness(hubInstance(), await profileEnv());
    expect(await run(['list', '--json', '--org', 'ATELIER NORD'], h.io)).toBe(0);
    expect(titles(h.out())).toEqual(['Nord roadmap', 'Nord budget']);
    expect(h.wire.map((c) => [c.path, c.workspace])).toEqual([
      ['/api/v1/me', undefined],
      ['/api/v1/presentations', NORD]
    ]);
  });

  it('SLIDELESS_ORG does the same', async () => {
    const h = routedHarness(hubInstance(), { ...(await profileEnv()), SLIDELESS_ORG: ORG_NORD });
    expect(await run(['list', '--json'], h.io)).toBe(0);
    expect(h.wire[0]?.workspace).toBe(ORG_NORD);
  });

  it('--org and --workspace at once is a usage error, nothing sent', async () => {
    const h = routedHarness(hubInstance(), await profileEnv());
    expect(await run(['list', '--org', ORG_NORD, '--workspace', NORD], h.io)).toBe(1);
    expect(h.err()).toBe('Error: Pass --org or --workspace, not both.\n');
    expect(h.wire).toEqual([]);
  });

  it('SLIDELESS_ORG and SLIDELESS_WORKSPACE at once is a usage error, nothing sent', async () => {
    const h = routedHarness(hubInstance(), {
      ...(await profileEnv()),
      SLIDELESS_ORG: ORG_NORD,
      SLIDELESS_WORKSPACE: NORD
    });
    expect(await run(['list'], h.io)).toBe(1);
    expect(h.err()).toBe('Error: Set SLIDELESS_ORG or SLIDELESS_WORKSPACE, not both.\n');
    expect(h.wire).toEqual([]);
  });

  it('an organization that is not yours: the 401 says organization, names --org, lists yours with their ids', async () => {
    const h = routedHarness(hubInstance(), await profileEnv());
    expect(await run(['list', '--org', ELSEWHERE], h.io)).toBe(1);
    expect(h.err()).toBe(
      `Error: The organization "${ELSEWHERE}" (selected by the --org flag) is not one of yours on ${URL}; ` +
        'the API key itself works. Yours:\n' +
        `  ${ACME}  owner   Acme  (organization ${ORG_ACME})\n` +
        `  ${NORD}  member  Atelier Nord  (organization ${ORG_NORD})\n`
    );
  });

  it('the 404 hint names the organization that was asked', async () => {
    const routes: Route[] = [
      ...hubInstance(),
      {
        method: 'GET',
        path: /^\/api\/v1\/presentations\/[^/]+$/,
        reply: () => refuse(404, 'not_found', 'Presentation not found')
      }
    ];
    const h = routedHarness(routes, await profileEnv());
    expect(await run(['get', DECK.id, '--org', 'Atelier Nord'], h.io)).toBe(1);
    expect(h.err()).toBe(
      'Error: Presentation not found (looked in the organization "Atelier Nord", selected by the --org flag)\n'
    );
  });

  it('`workspaces` prints each organization id and the legend line for it', async () => {
    const h = routedHarness(hubInstance(), await profileEnv());
    expect(await run(['workspaces', '--org', ORG_NORD], h.io)).toBe(0);
    expect(h.out()).toBe(
      `  ${ACME}  owner   Acme  (default)  organization ${ORG_ACME}\n` +
        `* ${NORD}  member  Atelier Nord  organization ${ORG_NORD}\n` +
        '\n* = the workspace the commands run in, chosen by the --org flag\n' +
        '(default) = what a request naming no workspace resolves to\n' +
        'organization = the Antasphere id --org takes (or its name)\n'
    );
  });

  it('`workspaces` prints no (default) line when no row is the default, no organization line without ids', async () => {
    const rows = WORKSPACES.map((w) => ({ ...w, default: false }));
    const h = routedHarness(instance(rows), await profileEnv());
    expect(await run(['workspaces'], h.io)).toBe(0);
    expect(h.out()).not.toContain('(default) =');
    expect(h.out()).not.toContain('organization =');
  });

  it('whoami prints the organization line for a row that has one, and none otherwise', async () => {
    const h = routedHarness(hubInstance(), await profileEnv());
    expect(await run(['whoami', '--org', ORG_NORD], h.io)).toBe(0);
    expect(h.out()).toContain(
      `  workspace: Atelier Nord (${NORD})\n  organization: ${ORG_NORD}\n  chosen by: the --org flag\n`
    );

    const plain = routedHarness(instance(), await profileEnv());
    expect(await run(['whoami'], plain.io)).toBe(0);
    expect(plain.out()).not.toContain('organization:');
  });
});
