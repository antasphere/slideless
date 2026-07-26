import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEV_SANDBOX_CSP, startDevServer } from '../src/devserver.js';
import type { DevServer } from '../src/devserver.js';

let server: DevServer;
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'slideless-dev-'));
  await writeFile(join(dir, 'index.html'), '<html><body>DEV DECK</body></html>');
  await mkdir(join(dir, 'assets'), { recursive: true });
  await writeFile(join(dir, 'assets', 'style.css'), 'body{color:red}');
  server = await startDevServer({ root: dir, entryPath: 'index.html', port: 0 });
});

afterAll(async () => {
  await server?.close();
});

describe('slideless dev server', () => {
  it('serves the entry at / with the exact viewer sandbox headers', async () => {
    const res = await fetch(server.url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toBe(DEV_SANDBOX_CSP);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const html = await res.text();
    expect(html).toContain('DEV DECK');
    // Live-reload client injected into HTML responses.
    expect(html).toContain('/__slideless/reload');
  });

  it('serves assets by relative path with their content type (no injection)', async () => {
    const res = await fetch(`${server.url}assets/style.css`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/css');
    expect(res.headers.get('content-security-policy')).toBe(DEV_SANDBOX_CSP);
    expect(await res.text()).toBe('body{color:red}');
  });

  it('404s missing files and blocks traversal out of the root', async () => {
    expect((await fetch(`${server.url}nope.js`)).status).toBe(404);
    expect((await fetch(`${server.url}..%2f..%2fetc%2fpasswd`)).status).toBe(404);
    expect((await fetch(`${server.url}assets/../../secret`)).status).toBe(404);
  });
});

/**
 * PRDCT-1353 / CLI-2 — the preview server used to be a filesystem-wide read
 * primitive: the traversal guard was purely lexical, so any symlink inside
 * the deck folder served whatever it pointed at, and no Host check meant a
 * DNS-rebinding page could read the answers.
 */
describe('slideless dev server containment', () => {
  let secureDir: string;
  let secure: DevServer;
  let secretPath: string;

  beforeAll(async () => {
    const root = await mkdtemp(join(tmpdir(), 'slideless-dev-sec-'));
    secretPath = join(root, 'secret.txt');
    await writeFile(secretPath, 'TOP SECRET');
    secureDir = join(root, 'deck');
    await mkdir(join(secureDir, 'assets'), { recursive: true });
    await writeFile(join(secureDir, 'index.html'), '<html><body>DECK</body></html>');
    await writeFile(join(secureDir, '.env'), 'API_KEY=leaked');
    await symlink(secretPath, join(secureDir, 'passwd'));
    await symlink('/etc/passwd', join(secureDir, 'etc-passwd'));
    await symlink(root, join(secureDir, 'assets', 'up'));
    secure = await startDevServer({ root: secureDir, entryPath: 'index.html', port: 0 });
  });

  afterAll(async () => {
    await secure?.close();
  });

  it('404s a symlink that points outside the deck folder', async () => {
    const res = await fetch(`${secure.url}passwd`);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('TOP SECRET');
    // The literal case from the audit: a link to /etc/passwd in the deck.
    const real = await fetch(`${secure.url}etc-passwd`);
    expect(real.status).toBe(404);
    expect(await real.text()).not.toContain('root:');
  });

  it('404s a path that traverses through a symlinked sub-directory', async () => {
    const res = await fetch(`${secure.url}assets/up/secret.txt`);
    expect(res.status).toBe(404);
  });

  it('404s dot-prefixed paths outright', async () => {
    expect((await fetch(`${secure.url}.env`)).status).toBe(404);
    expect((await fetch(`${secure.url}.git/config`)).status).toBe(404);
  });

  it('still serves the real deck files', async () => {
    const res = await fetch(secure.url);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('DECK');
  });

  it('refuses a request whose Host is not the bound address (DNS rebinding)', async () => {
    // `fetch` refuses to set Host (forbidden header), so this goes raw.
    expect(await rawStatus(secure.port, 'deck.attacker.example')).toBe(403);
    expect(await rawStatus(secure.port, `127.0.0.1:${secure.port + 1}`)).toBe(403);
  });

  it('accepts the loopback aliases of the bound address', async () => {
    expect(await rawStatus(secure.port, `localhost:${secure.port}`)).toBe(200);
    expect(await rawStatus(secure.port, `127.0.0.1:${secure.port}`)).toBe(200);
  });
});

/** GET / with an arbitrary Host header — `fetch` will not send one. */
function rawStatus(port: number, host: string): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: '/', headers: { host } }, (res) => {
      res.resume();
      res.on('end', () => resolvePromise(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end();
  });
}
