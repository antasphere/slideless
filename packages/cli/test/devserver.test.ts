import { mkdir, mkdtemp, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VIEWER_IFRAME_SANDBOX } from '@slideless/contract';
import { DEV_SANDBOX_CSP, startDevServer } from '../src/devserver.js';
import type { DevServer } from '../src/devserver.js';

let server: DevServer;
let dir: string;
let store: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'slideless-dev-'));
  store = await mkdtemp(join(tmpdir(), 'slideless-dev-store-'));
  await writeFile(join(dir, 'index.html'), '<html><body>DEV DECK</body></html>');
  await mkdir(join(dir, 'assets'), { recursive: true });
  await writeFile(join(dir, 'assets', 'style.css'), 'body{color:red}');
  server = await startDevServer({ root: dir, entryPath: 'index.html', port: 0, store, cliVersion: '9.9.9' });
});

afterAll(async () => {
  await server?.close();
});

describe('slideless dev server', () => {
  it('serves the deck files with the exact viewer sandbox headers', async () => {
    const res = await fetch(`${server.url}index.html`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toBe(DEV_SANDBOX_CSP);
    // PRDCT-2268: mirrors the public viewer — opened windows escape, the deck does not.
    // Lockstep with the contract's iframe list (the third copy of the one list).
    expect(DEV_SANDBOX_CSP).toBe(`sandbox ${VIEWER_IFRAME_SANDBOX}`);
    expect(DEV_SANDBOX_CSP).toContain('allow-popups-to-escape-sandbox');
    expect(DEV_SANDBOX_CSP).not.toContain('allow-same-origin');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('cache-control')).toBe('no-store');
    // The deck is served as written: the reload lives in the wrapper now.
    expect(await res.text()).toBe('<html><body>DEV DECK</body></html>');
  });

  it('serves / as the wrapper: the deck in a sandboxed frame, the reload stream, its own nonce policy', async () => {
    const res = await fetch(server.url);
    expect(res.status).toBe(200);
    const csp = res.headers.get('content-security-policy') ?? '';
    // The wrapper is the one same-origin document: no sandbox, a nonce'd script only.
    expect(csp).not.toContain('sandbox');
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-src 'self'");
    const html = await res.text();
    expect(html).toContain(`<iframe id="deck" title="Deck" sandbox="${VIEWER_IFRAME_SANDBOX}"`);
    expect(html).not.toContain('allow-same-origin');
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(html).toContain("new EventSource('/__slideless/reload')");
    expect(html).toContain('"/index.html"');
    // A fresh nonce per answer.
    const again = (await fetch(server.url)).headers.get('content-security-policy');
    expect(again).not.toBe(csp);
  });

  it('serves assets by relative path with their content type', async () => {
    const res = await fetch(`${server.url}assets/style.css`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/css');
    expect(res.headers.get('content-security-policy')).toBe(DEV_SANDBOX_CSP);
    expect(await res.text()).toBe('body{color:red}');
  });

  it('404s missing files, unknown reserved routes, and blocks traversal out of the root', async () => {
    expect((await fetch(`${server.url}nope.js`)).status).toBe(404);
    expect((await fetch(`${server.url}..%2f..%2fetc%2fpasswd`)).status).toBe(404);
    expect((await fetch(`${server.url}assets/../../secret`)).status).toBe(404);
    expect((await fetch(`${server.url}__slideless/nothing`)).status).toBe(404);
  });

  it('refuses writes on the content routes', async () => {
    expect((await fetch(`${server.url}index.html`, { method: 'POST' })).status).toBe(405);
  });
});

describe('slideless dev server: local versions', () => {
  const snap = (init: RequestInit = {}) =>
    fetch(`${server.url}__slideless/snapshot`, {
      method: 'POST',
      headers: { 'x-slideless': 'snapshot' },
      ...init
    });

  it('lists no versions before the first snapshot, and says the CLI version', async () => {
    const body = (await (await fetch(`${server.url}__slideless/versions`)).json()) as Record<string, unknown>;
    expect(body).toEqual({ cli: '9.9.9', entry: 'index.html', versions: [] });
  });

  it('refuses a snapshot without its header, from another origin, or by GET', async () => {
    expect((await fetch(`${server.url}__slideless/snapshot`, { method: 'POST' })).status).toBe(403);
    expect((await snap({ headers: { 'x-slideless': 'other' } })).status).toBe(403);
    expect(
      (await snap({ headers: { 'x-slideless': 'snapshot', origin: 'http://attacker.example' } })).status
    ).toBe(403);
    // The sandboxed deck sends `Origin: null`: refused too.
    expect((await snap({ headers: { 'x-slideless': 'snapshot', origin: 'null' } })).status).toBe(403);
    expect((await fetch(`${server.url}__slideless/snapshot`)).status).toBe(405);
    expect(await readdir(store)).not.toContain('folders');
  });

  it('takes a version, answers the same one when nothing changed, and a new one after a change', async () => {
    const first = await snap({
      headers: { 'x-slideless': 'snapshot', origin: server.url.replace(/\/$/, '') }
    });
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({
      version: 1,
      created: true,
      entryPath: 'index.html',
      fileCount: 2
    });

    const same = await snap();
    expect(same.status).toBe(200);
    expect(await same.json()).toMatchObject({ version: 1, created: false });

    await writeFile(join(dir, 'index.html'), '<html><body>DEV DECK TWO</body></html>');
    const second = await snap();
    expect(second.status).toBe(201);
    expect(await second.json()).toMatchObject({ version: 2, created: true });

    const list = (await (await fetch(`${server.url}__slideless/versions`)).json()) as {
      versions: Array<Record<string, unknown>>;
    };
    expect(list.versions.map((v) => v.version)).toEqual([1, 2]);
    // No absolute path of the machine in the listing.
    expect(list.versions[0]).not.toHaveProperty('root');
    expect(list.versions[0]).not.toHaveProperty('manifest');
  });

  it('serves a version from its own files, not from the working folder, under the sandbox', async () => {
    const v1 = await fetch(`${server.url}__slideless/v/1/index.html`);
    expect(v1.status).toBe(200);
    expect(v1.headers.get('content-security-policy')).toBe(DEV_SANDBOX_CSP);
    expect(v1.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await v1.text()).toBe('<html><body>DEV DECK</body></html>');

    const v2 = await fetch(`${server.url}__slideless/v/2/`);
    expect(await v2.text()).toBe('<html><body>DEV DECK TWO</body></html>');

    const css = await fetch(`${server.url}__slideless/v/1/assets/style.css`);
    expect(css.headers.get('content-type')).toBe('text/css');
    expect(await css.text()).toBe('body{color:red}');
  });

  it('404s a version or a path the store does not hold', async () => {
    expect((await fetch(`${server.url}__slideless/v/99/index.html`)).status).toBe(404);
    expect((await fetch(`${server.url}__slideless/v/1/nope.html`)).status).toBe(404);
    expect((await fetch(`${server.url}__slideless/v/0/index.html`)).status).toBe(404);
    expect((await fetch(`${server.url}__slideless/v/1/../../../etc/passwd`)).status).toBe(404);
  });

  it('pushes `reload` on a file change and `versions` on a new version', async () => {
    const events: string[] = [];
    const ctrl = new AbortController();
    const res = await fetch(`${server.url}__slideless/reload`, { signal: ctrl.signal });
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const pump = (async () => {
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        for (const m of buf.matchAll(/event: (\w+)/g)) events.push(m[1]!);
        buf = buf.slice(buf.lastIndexOf('\n') + 1);
      }
    })();
    await new Promise((r) => setTimeout(r, 100));
    await writeFile(join(dir, 'assets', 'style.css'), 'body{color:blue}');
    await waitFor(() => events.includes('reload'));
    await snap();
    await waitFor(() => events.includes('versions'));
    ctrl.abort();
    await pump;
  });

  it('ignores changes under a dot-prefixed path', async () => {
    const events: string[] = [];
    const ctrl = new AbortController();
    const res = await fetch(`${server.url}__slideless/reload`, { signal: ctrl.signal });
    const reader = res.body!.getReader();
    const pump = (async () => {
      for (;;) {
        const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
        if (done) return;
        for (const m of new TextDecoder().decode(value).matchAll(/event: (\w+)/g)) events.push(m[1]!);
      }
    })();
    // Let any late event of the earlier writes land first (macOS delivers some late).
    await new Promise((r) => setTimeout(r, 800));
    events.length = 0;
    await mkdir(join(dir, '.git'), { recursive: true });
    await writeFile(join(dir, '.git', 'HEAD'), 'ref: refs/heads/dev');
    await new Promise((r) => setTimeout(r, 400));
    expect(events).not.toContain('reload');
    ctrl.abort();
    await pump;
  });

  it('keeps previewing with versions off when the store is inside the folder, and says why', async () => {
    const deck = await mkdtemp(join(tmpdir(), 'slideless-dev-inside-'));
    await writeFile(join(deck, 'index.html'), '<p>x</p>');
    const inside = await startDevServer({
      root: deck,
      entryPath: 'index.html',
      port: 0,
      store: join(deck, 'versions')
    });
    try {
      expect(inside.store).toBeNull();
      expect(inside.storeError).toMatch(/inside the folder/);
      expect((await fetch(`${inside.url}index.html`)).status).toBe(200);
      const list = (await (await fetch(`${inside.url}__slideless/versions`)).json()) as Record<
        string,
        unknown
      >;
      expect(list.error).toMatch(/inside the folder/);
      const res = await fetch(`${inside.url}__slideless/snapshot`, {
        method: 'POST',
        headers: { 'x-slideless': 'snapshot' }
      });
      expect(res.status).toBe(409);
    } finally {
      await inside.close();
    }
  });
});

async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out waiting for the event');
    await new Promise((r) => setTimeout(r, 25));
  }
}

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
    secure = await startDevServer({
      root: secureDir,
      entryPath: 'index.html',
      port: 0,
      store: await mkdtemp(join(tmpdir(), 'slideless-dev-sec-store-'))
    });
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
    const res = await fetch(`${secure.url}index.html`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('DECK');
  });

  it('refuses a request whose Host is not the bound address (DNS rebinding)', async () => {
    // `fetch` refuses to set Host (forbidden header), so this goes raw.
    expect(await rawStatus(secure.port, 'deck.attacker.example')).toBe(403);
    expect(await rawStatus(secure.port, `127.0.0.1:${secure.port + 1}`)).toBe(403);
    expect(await rawStatus(secure.port, 'deck.attacker.example', '/__slideless/versions')).toBe(403);
  });

  it('accepts the loopback aliases of the bound address', async () => {
    expect(await rawStatus(secure.port, `localhost:${secure.port}`)).toBe(200);
    expect(await rawStatus(secure.port, `127.0.0.1:${secure.port}`)).toBe(200);
  });
});

/** GET a path with an arbitrary Host header — `fetch` will not send one. */
function rawStatus(port: number, host: string, path = '/'): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, headers: { host } }, (res) => {
      res.resume();
      res.on('end', () => resolvePromise(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end();
  });
}
