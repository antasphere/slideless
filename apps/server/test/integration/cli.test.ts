import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { serve, type ServerType } from '@hono/node-server';
import { createServer } from 'node:net';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '@slideless/cli';
import type { CliIo } from '@slideless/cli';
import {
  createDatabase,
  createTestApp,
  extractCookie,
  readJson,
  startPostgres,
  type TestApp
} from './helpers.js';

/**
 * The CLI driven against a REAL listening server (it dials a URL). Proves the
 * agent-facing path end to end: whoami + a files upload/download round-trip
 * with a minted key, and a clean scope error on a read-only key.
 */

const OWNER = { email: 'owner@cli.test', name: 'CLI Owner', password: 'cli-owner-password-123' };

let container: StartedPostgreSqlContainer;
let app: TestApp;
let server: ServerType;
let base: string;
let ownerCookie: string;
let writeKey: string;
let readKey: string;

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

/** Run the CLI in-process, capturing stdout/stderr and the exit code. */
async function cli(args: string[], apiKey?: string): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    env: { SLIDELESS_URL: base, ...(apiKey ? { SLIDELESS_API_KEY: apiKey } : {}) },
    out: { write: (s) => out.push(s) },
    err: { write: (s) => err.push(s) }
  };
  const code = await run(args, io);
  return { code, out: out.join(''), err: err.join('') };
}

beforeAll(async () => {
  container = await startPostgres();
  const dbUrl = await createDatabase(container, 'cli');
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  app = await createTestApp(dbUrl, { PUBLIC_BASE_URL: base });
  server = serve({ fetch: app.app.fetch, port, hostname: '127.0.0.1' });

  await fetch(`${base}/api/v1/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instanceName: 'CLI Instance', owner: OWNER })
  });
  const signIn = await fetch(`${base}/api/v1/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: OWNER.email, password: OWNER.password })
  });
  ownerCookie = extractCookie(signIn);

  const mint = async (scopes: string[]) =>
    readJson(
      await fetch(`${base}/api/v1/api-keys`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: ownerCookie },
        body: JSON.stringify({ name: `cli-${scopes.join('-')}`, scopes })
      })
    );
  writeKey = (await mint(['presentations:read', 'presentations:write'])).key;
  readKey = (await mint(['presentations:read'])).key;
}, 240_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await app?.stop();
  await container?.stop();
});

describe('slideless CLI against a live instance', () => {
  it('instance discovery works without a key', async () => {
    const { code, out } = await cli(['instance']);
    expect(code).toBe(0);
    expect(out).toContain('CLI Instance');
  });

  it('whoami resolves the key identity', async () => {
    const { code, out } = await cli(['whoami'], writeKey);
    expect(code).toBe(0);
    expect(out).toContain('owner@cli.test');
    expect(out).toContain('api_key');
    // The keys minted in beforeAll carry no TTL.
    expect(out).toContain('key expires: never');
  });

  it('whoami shows the expiry of a TTL key', async () => {
    const minted = await readJson(
      await fetch(`${base}/api/v1/api-keys`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: ownerCookie },
        body: JSON.stringify({ name: 'cli-ttl', scopes: ['presentations:read'], expiresInDays: 30 })
      })
    );
    const { code, out } = await cli(['whoami'], minted.key);
    expect(code).toBe(0);
    expect(out).toContain(`key expires: ${minted.apiKey.expiresAt}`);
  });

  it('uploads, lists, downloads, and deletes a file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cli-test-'));
    const src = join(dir, 'hello.txt');
    await writeFile(src, 'hello from the cli');

    const uploaded = await cli(['files', 'upload', src, '--content-type', 'text/plain'], writeKey);
    expect(uploaded.code).toBe(0);
    const id = /id: (\S+)/.exec(uploaded.out)?.[1];
    expect(id).toBeTruthy();

    const list = await cli(['files', 'list', '--json'], writeKey);
    expect(list.code).toBe(0);
    expect(list.out).toContain(id!);

    const dest = join(dir, 'out.txt');
    const dl = await cli(['files', 'download', id!, '--out', dest], writeKey);
    expect(dl.code).toBe(0);
    expect(await readFile(dest, 'utf8')).toBe('hello from the cli');

    const rm = await cli(['files', 'rm', id!], writeKey);
    expect(rm.code).toBe(0);
  });

  it('gives a read-only key a clean scope error on upload', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cli-test-'));
    const src = join(dir, 'blocked.txt');
    await writeFile(src, 'nope');
    const { code, err } = await cli(['files', 'upload', src], readKey);
    expect(code).toBe(1);
    expect(err.toLowerCase()).toContain('not allowed');
  });
});
