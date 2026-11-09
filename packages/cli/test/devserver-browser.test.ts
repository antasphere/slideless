import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDevServer, type DevServer } from '../src/devserver.js';

/**
 * The dev server in a REAL browser (PRDCT-4070, PRDCT-4260). The unit suite
 * proves the routes; only a browser proves what a person sees: the frame
 * reloads on a file change (the reload the command promised and no browser
 * ever delivered while the deck itself held the stream), the version bar
 * switches between the live folder and the versions, and the sandboxed deck
 * cannot drive the bar's routes.
 *
 * Chromium comes from playwright-core's own install (CI installs the headless
 * shell before the unit job). Without it the cases are skipped with a
 * warning on a laptop, and FAIL on CI, so the proof can never go quietly
 * missing where it counts.
 */

function headlessShellBeside(fullChrome: string): string | null {
  const m = /^(.*[/\\]ms-playwright)[/\\]chromium-(\d+)[/\\]/.exec(fullChrome);
  if (!m) return null;
  const root = join(m[1]!, `chromium_headless_shell-${m[2]}`);
  if (!existsSync(root)) return null;
  for (const dir of readdirSync(root)) {
    for (const name of ['chrome-headless-shell', 'headless_shell']) {
      const candidate = join(root, dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function findChromium(): string | null {
  const fromEnv = process.env.SLIDELESS_TEST_CHROMIUM;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  try {
    const bundled = chromium.executablePath();
    if (bundled && existsSync(bundled)) return bundled;
    // The CI job installs only the headless shell.
    const shell = headlessShellBeside(bundled);
    if (shell) return shell;
    const m = /^(.*[/\\]ms-playwright)[/\\]/.exec(bundled);
    if (m && existsSync(m[1]!)) {
      for (const dir of readdirSync(m[1]!)
        .filter((d) => d.startsWith('chromium_headless_shell-'))
        .sort()
        .reverse()) {
        for (const sub of readdirSync(join(m[1]!, dir))) {
          for (const name of ['chrome-headless-shell', 'headless_shell']) {
            const candidate = join(m[1]!, dir, sub, name);
            if (existsSync(candidate)) return candidate;
          }
        }
      }
    }
  } catch {
    // playwright-core throws when it has no browser for this platform.
  }
  return null;
}

const CHROMIUM = findChromium();
if (!CHROMIUM) {
  if (process.env.CI) {
    throw new Error(
      'devserver-browser.test.ts: no Chromium on CI — the browser proof of the dev server cannot run'
    );
  }
  console.warn(
    'devserver-browser.test.ts: no Chromium (set SLIDELESS_TEST_CHROMIUM or run `npx playwright-core install chromium-headless-shell`) — the browser cases are skipped'
  );
}

describe.skipIf(!CHROMIUM)('slideless dev in a real browser', () => {
  let browser: Browser;
  let page: Page;
  let server: DevServer;
  let dir: string;
  let store: string;
  const cspErrors: string[] = [];

  const deckText = () => page.frameLocator('#deck').locator('#t');
  const write = (text: string) =>
    writeFile(join(dir, 'index.html'), `<!doctype html><h1 id="t">${text}</h1>`);

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'slideless-dev-browser-'));
    store = await mkdtemp(join(tmpdir(), 'slideless-dev-browser-store-'));
    await write('one');
    server = await startDevServer({ root: dir, entryPath: 'index.html', port: 0, store });
    browser = await chromium.launch({ executablePath: CHROMIUM!, headless: true });
    page = await browser.newPage();
    page.on('console', (msg) => {
      if (/Content Security Policy|CORS/i.test(msg.text())) cspErrors.push(msg.text());
    });
    await page.goto(server.url);
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it('shows the live folder and reloads the frame when a file changes', async () => {
    await expect.poll(() => deckText().textContent(), { timeout: 5000 }).toBe('one');
    await write('two');
    await expect.poll(() => deckText().textContent(), { timeout: 5000 }).toBe('two');
    await write('three');
    await expect.poll(() => deckText().textContent(), { timeout: 5000 }).toBe('three');
  });

  it('saves a version from the bar and pins the frame to it', async () => {
    await page.getByRole('button', { name: 'Save version' }).click();
    await expect.poll(() => page.locator('#status').textContent(), { timeout: 5000 }).toBe('Saved as v1');
    await expect
      .poll(async () => page.locator('#sel option').allTextContents())
      .toContainEqual(expect.stringMatching(/^v1 · /));

    await write('four');
    await expect.poll(() => deckText().textContent(), { timeout: 5000 }).toBe('four');

    await page.locator('#sel').selectOption('1');
    await expect.poll(() => deckText().textContent(), { timeout: 5000 }).toBe('three');
    expect(new URL(page.url()).searchParams.get('v')).toBe('1');

    // A change in the folder does not move a pinned version.
    await write('five');
    await new Promise((r) => setTimeout(r, 600));
    expect(await deckText().textContent()).toBe('three');

    await page.getByRole('button', { name: 'Back to live' }).click();
    await expect.poll(() => deckText().textContent(), { timeout: 5000 }).toBe('five');
  });

  it('follows the latest version when the host saves one', async () => {
    await page.locator('#sel').selectOption('latest');
    await expect.poll(() => deckText().textContent(), { timeout: 5000 }).toBe('three');
    // The host (Clave at the end of an agent's turn) saves through the route.
    const res = await fetch(`${server.url}__slideless/snapshot`, {
      method: 'POST',
      headers: { 'x-slideless': 'snapshot' }
    });
    expect(await res.json()).toMatchObject({ version: 2, created: true });
    await expect.poll(() => deckText().textContent(), { timeout: 5000 }).toBe('five');
  });

  it('keeps the deck in its sandbox: it can neither reach the bar nor save a version', async () => {
    await page.locator('#sel').selectOption('live');
    await writeFile(
      join(dir, 'index.html'),
      `<!doctype html><h1 id="t">probe</h1><p id="parent"></p><p id="post"></p>
<script>
  try { parent.document.title; document.getElementById('parent').textContent = 'reached'; }
  catch { document.getElementById('parent').textContent = 'blocked'; }
  fetch('/__slideless/snapshot', { method: 'POST', headers: { 'x-slideless': 'snapshot' } })
    .then((r) => { document.getElementById('post').textContent = 'answered ' + r.status; })
    .catch(() => { document.getElementById('post').textContent = 'blocked'; });
</script>`
    );
    const frame = page.frameLocator('#deck');
    await expect.poll(() => frame.locator('#parent').textContent(), { timeout: 5000 }).toBe('blocked');
    await expect.poll(() => frame.locator('#post').textContent(), { timeout: 5000 }).toBe('blocked');
    const versions = (await (await fetch(`${server.url}__slideless/versions`)).json()) as {
      versions: Array<{ version: number }>;
    };
    expect(versions.versions.map((v) => v.version)).toEqual([1, 2]);
  });

  it('opens on the version a link names: ?v=1, ?v=latest, and live for a version that does not exist', async () => {
    const deep = await browser.newPage();
    try {
      await deep.goto(`${server.url}?v=1`);
      await expect
        .poll(() => deep.frameLocator('#deck').locator('#t').textContent(), { timeout: 5000 })
        .toBe('three');
      expect(await deep.locator('#sel').inputValue()).toBe('1');
      await deep.goto(`${server.url}?v=latest`);
      await expect
        .poll(() => deep.frameLocator('#deck').locator('#t').textContent(), { timeout: 5000 })
        .toBe('five');
      expect(await deep.locator('#sel').inputValue()).toBe('latest');
      await deep.goto(`${server.url}?v=99`);
      await expect.poll(() => deep.locator('#sel').inputValue(), { timeout: 5000 }).toBe('live');
      await expect
        .poll(() => deep.frameLocator('#deck').locator('#t').textContent(), { timeout: 5000 })
        .toBe('probe');
      expect(new URL(deep.url()).searchParams.get('v')).toBeNull();
    } finally {
      await deep.close();
    }
  });

  it('on ?v=latest with no version yet, follows the live folder, then moves to the first version saved', async () => {
    const fresh = await mkdtemp(join(tmpdir(), 'slideless-dev-browser-latest-'));
    const freshStore = await mkdtemp(join(tmpdir(), 'slideless-dev-browser-latest-store-'));
    const put = (text: string) =>
      writeFile(join(fresh, 'index.html'), `<!doctype html><h1 id="t">${text}</h1>`);
    await put('a');
    const other = await startDevServer({ root: fresh, entryPath: 'index.html', port: 0, store: freshStore });
    const tab = await browser.newPage();
    const text = () => tab.frameLocator('#deck').locator('#t').textContent();
    try {
      await tab.goto(`${other.url}?v=latest`);
      await expect.poll(text, { timeout: 5000 }).toBe('a');
      expect(await tab.locator('#sel').inputValue()).toBe('latest');
      await put('b');
      await expect.poll(text, { timeout: 5000 }).toBe('b');
      await other.snapshot();
      await put('c');
      await new Promise((r) => setTimeout(r, 800));
      expect(await text()).toBe('b');
      expect(await tab.locator('#sel').inputValue()).toBe('latest');
    } finally {
      await tab.close();
      await other.close();
    }
  });

  it('hides the bar on ?bar=0 and raises no policy error in the console', async () => {
    await page.goto(`${server.url}?bar=0`);
    await expect.poll(() => page.locator('#bar').isHidden(), { timeout: 5000 }).toBe(true);
    await expect.poll(() => deckText().textContent(), { timeout: 5000 }).toBe('probe');
    // The sandboxed probe's own refused POST is the one expected CORS line.
    expect(cspErrors.filter((e) => !/__slideless\/snapshot/.test(e))).toEqual([]);
  });
});
