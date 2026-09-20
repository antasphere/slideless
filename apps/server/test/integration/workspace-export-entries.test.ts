import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import AdmZip from 'adm-zip';
import {
  createDatabase,
  createTestApp,
  extractCookie,
  readJson,
  startPostgres,
  type TestApp
} from './helpers.js';

/**
 * The ENTRY LIST of Slideless's workspace export, by literal and in order
 * (PRDCT-2543). The chassis lets a tool add entries to the bundle through an
 * optional slot; Slideless does not fill it, so its bundle is the chassis
 * sections and the live blobs, nothing else. This pin turns red the day an
 * entry appears, disappears or moves, whoever caused it. The second test pins
 * the CONTENTS' shape of each chassis entry: its exact key set, by literal.
 */

const OWNER = { email: 'owner@entries.test', name: 'Entries Owner', password: 'entries-owner-password-1' };

let container: StartedPostgreSqlContainer;
let app: TestApp;
let ownerCookie: string;

const json = (body: unknown, extraHeaders: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...extraHeaders },
  body: JSON.stringify(body)
});

async function upload(name: string, text: string): Promise<string> {
  const res = await app.app.request(`/api/v1/files?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', cookie: ownerCookie },
    body: text
  });
  expect(res.status).toBe(201);
  return (await readJson(res)).file.id as string;
}

beforeAll(async () => {
  container = await startPostgres();
  app = await createTestApp(await createDatabase(container, 'export_entries'));
  await app.app.request(
    '/api/v1/setup',
    json({ setupToken: 'integration-test-setup-token', instanceName: 'Entries', owner: OWNER })
  );
  const signIn = await app.app.request(
    '/api/v1/auth/sign-in/email',
    json({ email: OWNER.email, password: OWNER.password }, { 'x-forwarded-for': '10.9.0.1' })
  );
  ownerCookie = extractCookie(signIn);
}, 240_000);

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

describe('GET /workspace/export, the entry list of the Slideless bundle', () => {
  it('is the chassis sections, then the live blobs, then the skip list: exactly, in this order', async () => {
    const liveId = await upload('kept.bin', 'a blob that stays');
    const trashedId = await upload('trashed.txt', 'a blob that goes');
    const deleted = await app.app.request(`/api/v1/files/${trashedId}`, {
      method: 'DELETE',
      headers: { cookie: ownerCookie }
    });
    expect(deleted.status).toBe(200);

    const res = await app.app.request('/api/v1/workspace/export', {
      headers: { cookie: ownerCookie, 'x-forwarded-for': '10.9.0.1' }
    });
    expect(res.status).toBe(200);
    const zip = new AdmZip(Buffer.from(await res.arrayBuffer()));
    expect(zip.getEntries().map((e) => e.entryName)).toEqual([
      'manifest.json',
      'workspace.json',
      'members.json',
      'invitations.json',
      'api-keys.json',
      'audit-log.ndjson',
      'files.json',
      `files/${liveId}-kept.bin`,
      'skipped-blobs.json'
    ]);
    // The manifest names no entry and counts none: a tool's entries never move it.
    expect(Object.keys(JSON.parse(zip.readAsText('manifest.json')))).toEqual([
      'formatVersion',
      'exportedAt',
      'instance',
      'workspaceId'
    ]);
  });

  it('each chassis entry has exactly these keys: a field that appears or disappears is a change of the bundle', async () => {
    // One row in every section: a pending invitation, a key PINNED to the
    // workspace (the only kind the section lists), the blobs and the audit
    // rows of the writes above.
    const me = await readJson(await app.app.request('/api/v1/me', { headers: { cookie: ownerCookie } }));
    const invited = await app.app.request(
      '/api/v1/invitations',
      json({ email: 'invited@entries.test', role: 'member' }, { cookie: ownerCookie })
    );
    expect(invited.status).toBe(201);
    const minted = await app.app.request(
      '/api/v1/api-keys',
      json(
        { name: 'pinned', scopes: ['presentations:read'], workspaceId: me.workspace.id },
        { cookie: ownerCookie }
      )
    );
    expect(minted.status).toBe(201);

    const res = await app.app.request('/api/v1/workspace/export', {
      headers: { cookie: ownerCookie, 'x-forwarded-for': '10.9.0.1' }
    });
    expect(res.status).toBe(200);
    const zip = new AdmZip(Buffer.from(await res.arrayBuffer()));
    const keysOf = (value: unknown) => Object.keys(value as Record<string, unknown>).sort();
    const firstRow = (entry: string) => {
      const rows = JSON.parse(zip.readAsText(entry)) as unknown[];
      expect(rows.length).toBeGreaterThan(0);
      return rows[0];
    };

    const manifest = JSON.parse(zip.readAsText('manifest.json'));
    expect(keysOf(manifest)).toEqual(['exportedAt', 'formatVersion', 'instance', 'workspaceId']);
    expect(keysOf(manifest.instance)).toEqual(['edition', 'instanceId', 'name', 'version']);
    expect(keysOf(JSON.parse(zip.readAsText('workspace.json')))).toEqual(['createdAt', 'id', 'name']);
    expect(keysOf(firstRow('members.json'))).toEqual([
      'createdAt',
      'email',
      'id',
      'isActive',
      'lastSeenAt',
      'name',
      'role',
      'userId'
    ]);
    const invitation = firstRow('invitations.json');
    expect(keysOf(invitation)).toEqual([
      'acceptedAt',
      'createdAt',
      'email',
      'expiresAt',
      'id',
      'invitedBy',
      'revokedAt',
      'role'
    ]);
    expect(keysOf(invitation)).not.toContain('tokenHash');
    const apiKey = firstRow('api-keys.json');
    expect(keysOf(apiKey)).toEqual([
      'createdAt',
      'createdBy',
      'expiresAt',
      'id',
      'keyId',
      'lastUsedAt',
      'name',
      'revokedAt',
      'scopes'
    ]);
    expect(keysOf(apiKey)).not.toContain('secretHash');
    expect(keysOf(firstRow('files.json'))).toEqual([
      'contentType',
      'createdAt',
      'createdBy',
      'deletedAt',
      'id',
      'originalName',
      'sha256',
      'sizeBytes'
    ]);
    const auditLines = zip.readAsText('audit-log.ndjson').split('\n').filter(Boolean);
    expect(auditLines.length).toBeGreaterThan(0);
    expect(keysOf(JSON.parse(auditLines[0]!))).toEqual([
      'action',
      'actorUserId',
      'actorVia',
      'apiKeyId',
      'createdAt',
      'id',
      'ip',
      'metadata',
      'requestId',
      'resourceId',
      'resourceType',
      'workspaceId'
    ]);
    // No secret anywhere in the JSON sections, whatever the key it would hide under.
    for (const entry of ['invitations.json', 'api-keys.json']) {
      expect(zip.readAsText(entry)).not.toMatch(/tokenHash|secretHash|token_hash|secret_hash/);
    }
  });
});
