import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { serve, type ServerType } from '@hono/node-server';
import AdmZip from 'adm-zip';
import { createServer } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '@antasphere/slideless';
import type { CliIo } from '@antasphere/slideless';
import {
  createDatabase,
  createTestApp,
  extractCookie,
  readJson,
  startPostgres,
  type TestApp
} from './helpers.js';

/**
 * GDPR export (M5), the CLI leg: the `slideless export` command against a
 * real listening server. Split out of gdpr.test.ts when that file became part
 * of the chassis suite (`packages/chassis-server/test/integration`): the CLI is
 * the Slideless product's, so this `it` stays with the app. Same fixtures the
 * original ran on: an owner, one live blob, one soft-deleted file, and an
 * owner-minted key pinned to the workspace carrying data:export only.
 */

const OWNER = { email: 'owner@gdpr.test', name: 'GDPR Owner', password: 'gdpr-owner-password-12' };
const BLOB_BYTES = 'gdpr export blob payload — byte-identical round trip expected';

let container: StartedPostgreSqlContainer;
let app: TestApp;
let server: ServerType;
let base: string;
let ownerCookie: string;
let workspaceId: string;
let exportKey: string; // owner-minted, data:export only

const json = (body: unknown, extraHeaders: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...extraHeaders },
  body: JSON.stringify(body)
});

async function upload(cookie: string, name: string, text: string): Promise<string> {
  const res = await app.app.request(`/api/v1/files?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', cookie },
    body: text
  });
  expect(res.status).toBe(201);
  return (await readJson(res)).file.id as string;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      if (address === null || typeof address === 'string') return reject(new Error('no port'));
      srv.close(() => resolve(address.port));
    });
  });
}

beforeAll(async () => {
  container = await startPostgres();
  const connectionString = await createDatabase(container, 'gdpr_cli');
  app = await createTestApp(connectionString);
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = serve({ fetch: app.app.fetch, port, hostname: '127.0.0.1' });

  await app.app.request(
    '/api/v1/setup',
    json({ setupToken: 'integration-test-setup-token', instanceName: 'GDPR', owner: OWNER })
  );
  const signIn = await app.app.request(
    '/api/v1/auth/sign-in/email',
    json({ email: OWNER.email, password: OWNER.password }, { 'x-forwarded-for': '10.0.0.1' })
  );
  ownerCookie = extractCookie(signIn);
  const me = await readJson(await app.app.request('/api/v1/me', { headers: { cookie: ownerCookie } }));
  workspaceId = me.workspace.id;

  await upload(ownerCookie, 'export-blob.bin', BLOB_BYTES);
  const trashedFileId = await upload(ownerCookie, 'trashed.txt', 'to be soft-deleted');
  await app.app.request(`/api/v1/files/${trashedFileId}`, {
    method: 'DELETE',
    headers: { cookie: ownerCookie }
  });

  // PINNED to the workspace, as in gdpr.test.ts.
  const res = await app.app.request('/api/v1/api-keys', {
    ...json({ name: 'export-only', scopes: ['data:export'], workspaceId }),
    headers: { 'content-type': 'application/json', cookie: ownerCookie }
  });
  expect(res.status).toBe(201);
  exportKey = (await readJson(res)).key as string;
}, 240_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await app?.stop();
  await container?.stop();
});

describe('CLI export against a live server', () => {
  it('slideless export -o <path> writes a valid zip', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gdpr-cli-'));
    const out = join(dir, 'bundle.zip');
    const outLines: string[] = [];
    const errLines: string[] = [];
    const io: CliIo = {
      env: { SLIDELESS_URL: base, SLIDELESS_API_KEY: exportKey },
      out: { write: (s) => outLines.push(s) },
      err: { write: (s) => errLines.push(s) }
    };
    const code = await run(['export', '-o', out], io);
    expect(errLines.join('')).toBe('');
    expect(code).toBe(0);

    const zip = new AdmZip(out);
    const names = zip.getEntries().map((e) => e.entryName);
    expect(names).toContain('manifest.json');
    expect(names).toContain('files.json');
    const manifest = JSON.parse(zip.readAsText('manifest.json'));
    expect(manifest.workspaceId).toBe(workspaceId);
  }, 60_000);
});
