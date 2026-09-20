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
 * entry appears, disappears or moves, whoever caused it.
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
});
