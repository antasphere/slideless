import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
