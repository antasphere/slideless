import { describe, expect, it } from 'vitest';
import { run } from '../src/index.js';
import { loadConfig, saveConfig } from '../src/config.js';
import { DECK, routedHarness, tempConfigEnv, type Route } from './harness.js';

/**
 * Profile resolution + the OTP auth pair, against a routed fake fetch and an
 * isolated XDG_CONFIG_HOME. The real end-to-end (Mailpit OTP) runs in the
 * server integration suite and the E2E gate.
 */

const ME = {
  user: { id: 'u1', name: 'Ada', email: 'ada@x.co' },
  workspace: { id: 'w1', name: 'Acme' },
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

describe('auth login flow', () => {
  it('login-request POSTs /cli/auth/request with the email', async () => {
    const env = await tempConfigEnv();
    const h = routedHarness(
      [{ method: 'POST', path: /\/api\/v1\/cli\/auth\/request$/, reply: () => ({ body: { sent: true } }) }],
      env
    );
    const code = await run(
      ['auth', 'login-request', '--email', 'ada@x.co', '--api-url', 'http://inst'],
      h.io
    );
    expect(h.err()).toBe('');
    expect(code).toBe(0);
    expect(h.calls[0]).toMatchObject({
      method: 'POST',
      path: '/api/v1/cli/auth/request',
      body: { email: 'ada@x.co' }
    });
    expect(h.out()).toContain('login-complete');
  });

  it('login-complete stores the minted key as the active profile (0600 config)', async () => {
    const env = await tempConfigEnv();
    const h = routedHarness(
      [
        {
          method: 'POST',
          path: /\/api\/v1\/cli\/auth\/complete$/,
          reply: ({ body }) => {
            expect(body).toMatchObject({ email: 'ada@x.co', otp: '123456' });
            return { status: 201, body: MINTED };
          }
        }
      ],
      env
    );
    const code = await run(
      ['auth', 'login-complete', '--email', 'ada@x.co', '--code', '123456', '--api-url', 'http://inst'],
      h.io
    );
    expect(h.err()).toBe('');
    expect(code).toBe(0);
    const config = loadConfig(env);
    expect(config.activeProfile).toBe('default');
    expect(config.profiles.default).toEqual({ apiKey: MINTED.key, baseUrl: 'http://inst' });
    // The full key is never echoed, only its redacted form.
    expect(h.out()).not.toContain(MINTED.key);
    expect(h.out()).toContain('slk_abcdefgh_');
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
    expect(h.out()).toContain('http://saved');
  });

  it('flags beat env beats profile for the base URL', async () => {
    const env = await tempConfigEnv();
    saveConfig(env, {
      activeProfile: 'p',
      profiles: { p: { apiKey: 'slk_k_s', baseUrl: 'http://profile' } }
    });
    const h = routedHarness([meRoute], { ...env, SLIDELESS_URL: 'http://env' });
    await run(['whoami'], h.io);
    expect(h.out()).toContain('http://env');

    const h2 = routedHarness([meRoute], { ...env, SLIDELESS_URL: 'http://env' });
    await run(['whoami', '--api-url', 'http://flag'], h2.io);
    expect(h2.out()).toContain('http://flag');
  });

  it('--profile selects a named profile; unknown profiles error', async () => {
    const env = await tempConfigEnv();
    saveConfig(env, {
      activeProfile: 'a',
      profiles: {
        a: { apiKey: 'slk_a_a', baseUrl: 'http://a' },
        b: { apiKey: 'slk_b_b', baseUrl: 'http://b' }
      }
    });
    const h = routedHarness([meRoute], env);
    await run(['whoami', '--profile', 'b'], h.io);
    expect(h.out()).toContain('http://b');

    const h2 = routedHarness([], env);
    const code = await run(['whoami', '--profile', 'nope'], h2.io);
    expect(code).toBe(1);
    expect(h2.err()).toContain('Unknown profile');
  });

  it('errors without any instance configured', async () => {
    const env = await tempConfigEnv();
    const h = routedHarness([], env);
    const code = await run(['list'], h.io);
    expect(code).toBe(1);
    expect(h.err()).toContain('No instance configured');
    expect(h.calls).toHaveLength(0);
  });

  it('login verifies a pasted key before saving it', async () => {
    const env = await tempConfigEnv();
    const h = routedHarness([meRoute], env);
    const code = await run(
      ['login', '--api-key', 'slk_paste_key', '--api-url', 'http://inst', '--profile', 'pasted'],
      h.io
    );
    expect(h.err()).toBe('');
    expect(code).toBe(0);
    const config = loadConfig(env);
    expect(config.activeProfile).toBe('pasted');
    expect(config.profiles.pasted).toEqual({ apiKey: 'slk_paste_key', baseUrl: 'http://inst' });
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
    expect(loadConfig(env).activeProfile).toBe('b');

    const h2 = routedHarness([], env);
    expect(await run(['profiles'], h2.io)).toBe(0);
    expect(h2.out()).toContain('http://a');
    expect(h2.out()).toContain('http://b');
    // Keys never appear in full.
    expect(h2.out()).not.toContain('slk_a_verylongkeyvalue123');

    const h3 = routedHarness([], env);
    expect(await run(['logout'], h3.io)).toBe(0);
    expect(loadConfig(env).profiles.b?.apiKey).toBeUndefined();
    expect(loadConfig(env).profiles.b?.baseUrl).toBe('http://b');
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
    expect(h.out()).toContain('config.json');

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
          reply: () => ({ status: 401, body: { error: { code: 'invalid_api_key', message: 'API key not recognized' } } })
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
            body: { shareToken: { ...TOKEN, versionMode: 'pinned', pinnedVersion: 2 }, secret: 's', url: 'http://x/v/s' }
          };
        }
      }
    ]);
    expect(
      await run(
        ['share', DECK.id, '--to-version', '2', '--url', 'http://x', '--api-key', 'slk_k_s'],
        h.io
      )
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
                  shareTokens: [TOKEN, { ...TOKEN, id: '77777777-7777-7777-7777-777777777777', revokedAt: '2026-07-01T00:00:00.000Z' }],
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
