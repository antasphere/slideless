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
const SAMPLE_CHILD_ID = '22222222-2222-2222-2222-222222222222';
const SAMPLE_TOKEN = 'x'.repeat(24);
const SAMPLE_SHA256 = 'a'.repeat(64);
const SAMPLE_VERSION = 3;
const SAMPLE_MANIFEST = [
  { path: 'index.html', sha256: SAMPLE_SHA256, sizeBytes: 1, contentType: 'text/html' }
];

/** contract route → an SDK call. Keyed by `METHOD path` (contract shape). */
const INVOKERS: Record<string, (c: PlatformClient) => Promise<unknown>> = {
  'GET /instance': (c) => c.instance(),
  'POST /setup': (c) =>
    c.setup({
      instanceName: 'X',
      owner: { email: 'a@b.co', name: 'A', password: 'x'.repeat(12) }
    }),
  'GET /me': (c) => c.me(),
  'POST /cli/auth/request': (c) => c.cliAuthRequest({ email: 'a@b.co' }),
  'POST /cli/auth/complete': (c) => c.cliAuthComplete({ email: 'a@b.co', otp: '123456' }),
  'DELETE /cli/auth/key': (c) => c.cliAuthRevoke(),
  'POST /sso/cli-connect': (c) => c.ssoCliConnect({ token: SAMPLE_TOKEN }),
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
  'DELETE /files/{id}': (c) => c.deleteFile(SAMPLE_ID),
  'GET /presentations': (c) => c.presentations(),
  'GET /presentations/{id}': (c) => c.presentation(SAMPLE_ID),
  'DELETE /presentations/{id}': (c) => c.deletePresentation(SAMPLE_ID),
  'POST /presentations/uploads': (c) => c.createUploadSession(),
  'POST /presentations/precheck': (c) => c.precheckAssets([SAMPLE_SHA256]),
  'POST /presentations/assets': (c) => c.uploadAsset(SAMPLE_SHA256, new Uint8Array([1])),
  'POST /presentations/uploads/{id}/commit': (c) =>
    c.commitUploadSession(SAMPLE_ID, {
      title: 'T',
      kind: 'presentation',
      interactive: false,
      entryPath: 'index.html',
      manifest: SAMPLE_MANIFEST
    }),
  'POST /presentations/{id}/versions': (c) =>
    c.commitVersion(SAMPLE_ID, {
      expectedBaseVersion: 1,
      entryPath: 'index.html',
      manifest: SAMPLE_MANIFEST
    }),
  'GET /presentations/{id}/versions': (c) => c.presentationVersions(SAMPLE_ID),
  'GET /presentations/{id}/versions/{version}': (c) => c.presentationVersion(SAMPLE_ID, SAMPLE_VERSION),
  'GET /presentations/{id}/assets/{sha256}': (c) => c.downloadPresentationAsset(SAMPLE_ID, SAMPLE_SHA256),
  'GET /presentations/{id}/tokens': (c) => c.shareTokens(SAMPLE_ID),
  'POST /presentations/{id}/tokens': (c) => c.createShareToken(SAMPLE_ID, { name: 'Alice' }),
  'POST /presentations/{id}/preview-token': (c) => c.createPreviewToken(SAMPLE_ID),
  'PATCH /presentations/{id}/tokens/{tokenId}': (c) =>
    c.updateShareToken(SAMPLE_ID, SAMPLE_CHILD_ID, { canAnnotate: true }),
  'DELETE /presentations/{id}/tokens/{tokenId}': (c) => c.revokeShareToken(SAMPLE_ID, SAMPLE_CHILD_ID),
  'POST /presentations/{id}/tokens/{tokenId}/send': (c) =>
    c.sendShareToken(SAMPLE_ID, SAMPLE_CHILD_ID, { email: 'a@b.co' }),
  'GET /presentations/{id}/collaborators': (c) => c.collaborators(SAMPLE_ID),
  'POST /presentations/{id}/collaborators': (c) => c.inviteCollaborator(SAMPLE_ID, { email: 'a@b.co' }),
  'DELETE /presentations/{id}/collaborators/{collaboratorId}': (c) =>
    c.removeCollaborator(SAMPLE_ID, SAMPLE_CHILD_ID),
  'GET /collaborators/lookup': (c) => c.lookupCollaboratorInvite(SAMPLE_TOKEN),
  'POST /collaborators/claim': (c) => c.claimCollaboratorInvite({ token: SAMPLE_TOKEN }),
  'GET /presentations/{id}/annotations': (c) => c.annotations(SAMPLE_ID),
  'POST /presentations/{id}/annotations': (c) =>
    c.createAnnotation(SAMPLE_ID, { version: 1, selection: { slide: 1 }, body: 'n' }),
  'PATCH /presentations/{id}/annotations/{annotationId}': (c) =>
    c.updateAnnotation(SAMPLE_ID, SAMPLE_CHILD_ID, { status: 'resolved' }),
  'DELETE /presentations/{id}/annotations/{annotationId}': (c) =>
    c.deleteAnnotation(SAMPLE_ID, SAMPLE_CHILD_ID),
  'GET /annotations': (c) => c.annotationInbox()
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

/** The contract path with every param substituted, to compare against the SDK's real path. */
function expectedPath(contractPath: string): string {
  return `/api/v1${contractPath
    .replace('{id}', SAMPLE_ID)
    .replace(/\{(tokenId|collaboratorId|annotationId)\}/, SAMPLE_CHILD_ID)
    .replace('{version}', String(SAMPLE_VERSION))
    .replace('{sha256}', SAMPLE_SHA256)}`;
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
