import { describe, expect, it } from 'vitest';
import * as routes from '@slideless/contract/routes';
import { PlatformClient } from '../src/index.js';

/**
 * SDK ↔ contract drift guard. Request/response SHAPES already fail typecheck
 * (the SDK annotates every method with contract types). This closes the only
 * remaining gap: the method + path string literals inside each SDK method.
 *
 * It walks every route contract, invokes the mapped SDK method against a
 * recording fake fetch, and asserts the method + path the SDK actually hits
 * equals the contract's. Adding a contract route without an SDK method — or
 * typoing an existing path — fails this test by name.
 *
 * Better Auth wrapper methods (session/signInEmail/signOut) call /auth/* and
 * are intentionally NOT in the contract; they are excluded below.
 */

const SAMPLE_ID = '11111111-1111-1111-1111-111111111111';
const SAMPLE_TOKEN = 'x'.repeat(24);

/** contract route → an SDK call. Keyed by `METHOD path` (contract shape). */
const INVOKERS: Record<string, (c: PlatformClient) => Promise<unknown>> = {
  'GET /instance': (c) => c.instance(),
  'POST /setup': (c) =>
    c.setup({
      instanceName: 'X',
      owner: { email: 'a@b.co', name: 'A', password: 'x'.repeat(12) }
    }),
  'GET /me': (c) => c.me(),
  'GET /members': (c) => c.members(),
  'PATCH /members/{id}': (c) => c.updateMember(SAMPLE_ID, { role: 'admin' }),
  'DELETE /members/{id}': (c) => c.deleteMember(SAMPLE_ID),
  'POST /members/{id}/reset-link': (c) => c.createMemberResetLink(SAMPLE_ID),
  'POST /members/{id}/change-email-link': (c) =>
    c.createMemberChangeEmailLink(SAMPLE_ID, { newEmail: 'a@b.co' }),
  'GET /api-keys': (c) => c.apiKeys(),
  'POST /api-keys': (c) => c.createApiKey({ name: 'k', scopes: ['presentations:read'] }),
  'DELETE /api-keys/{id}': (c) => c.revokeApiKey(SAMPLE_ID),
  'GET /invitations': (c) => c.invitations(),
  'POST /invitations': (c) => c.createInvitation({ email: 'a@b.co', role: 'member' }),
  'DELETE /invitations/{id}': (c) => c.revokeInvitation(SAMPLE_ID),
  'GET /invitations/lookup': (c) => c.lookupInvitation(SAMPLE_TOKEN),
  'POST /invitations/accept': (c) => c.acceptInvitation({ token: SAMPLE_TOKEN }),
  'POST /admin/break-glass/claim-ownership': (c) => c.breakGlassClaimOwnership(),
  'POST /admin/break-glass/reset-2fa': (c) => c.breakGlassResetTwoFactor({ userId: SAMPLE_ID }),
  'GET /audit': (c) => c.audit(),
  'GET /workspace/export': (c) => c.downloadExport(),
  'GET /files': (c) => c.files(),
  'GET /files/{id}': (c) => c.file(SAMPLE_ID),
  'POST /files': (c) => c.uploadFile('n.txt', new Uint8Array([1])),
  'DELETE /files/{id}': (c) => c.deleteFile(SAMPLE_ID)
};

interface ContractRoute {
  method: string;
  path: string;
}

function contractRoutes(): Array<{ key: string; method: string; path: string }> {
  return Object.values(routes as Record<string, unknown>)
    .filter((r): r is ContractRoute => {
      const o = r as Partial<ContractRoute>;
      return typeof o?.method === 'string' && typeof o?.path === 'string';
    })
    .map((r) => ({
      key: `${r.method.toUpperCase()} ${r.path}`,
      method: r.method.toUpperCase(),
      path: r.path
    }));
}

/** Records the (method, pathname) of the single request an SDK call makes. */
function recordingClient(): { client: PlatformClient; calls: Array<{ method: string; path: string }> } {
  const calls: Array<{ method: string; path: string }> = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString(), 'http://x');
    calls.push({ method: (init?.method ?? 'GET').toUpperCase(), path: url.pathname });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  return { client: new PlatformClient({ fetch }), calls };
}

/** `/members/{id}` with the sample id substituted, to compare against the SDK's real path. */
function expectedPath(contractPath: string): string {
  return `/api/v1${contractPath.replace('{id}', SAMPLE_ID)}`;
}

describe('SDK route coverage (contract drift guard)', () => {
  const all = contractRoutes();

  it('maps every contract route to an SDK method', () => {
    const missing = all.filter((r) => !(r.key in INVOKERS)).map((r) => r.key);
    expect(missing, `contract routes without an SDK method: ${missing.join(', ')}`).toEqual([]);
  });

  it('has no stale mappings (every mapping targets a real contract route)', () => {
    const keys = new Set(all.map((r) => r.key));
    const stale = Object.keys(INVOKERS).filter((k) => !keys.has(k));
    expect(stale, `INVOKERS entries with no matching contract route: ${stale.join(', ')}`).toEqual([]);
  });

  for (const route of contractRoutes()) {
    it(`${route.key} hits the right method + path`, async () => {
      const invoke = INVOKERS[route.key];
      if (!invoke) return; // coverage asserted separately
      const { client, calls } = recordingClient();
      await invoke(client);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.method).toBe(route.method);
      expect(calls[0]!.path).toBe(expectedPath(route.path));
    });
  }
});
