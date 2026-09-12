import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect, type Page } from '@playwright/test';
import { VIEWER_IFRAME_SANDBOX } from '@slideless/contract';
import { OWNER } from './accounts';

/**
 * PRDCT-2268 — a window a deck OPENS runs as a normal top-level page, while
 * the deck itself stays in the ADR 012 opaque origin.
 *
 * Reported on an Exos client-demo page hosted on Slideless: its « Ouvrir »
 * buttons (`window.open` with a window name, plus `target="_blank"` links)
 * opened the application under test at the right https URL, and it never
 * booted — `document.cookie` threw "The document is sandboxed and lacks the
 * 'allow-same-origin' flag" and every fetch was refused from `origin null`.
 * Without `allow-popups-to-escape-sandbox` the opened window inherits the
 * opener's sandbox, whatever its address.
 *
 * Both entrances are proved here, in a real Chromium, against the real
 * stack: the share link opened top-level (the CSP `sandbox` header on the
 * viewer's own responses) and the official embed iframe (the `sandbox`
 * attribute). In each: the DECK's origin is still `null` and its cookie read
 * still throws; the window it opens has the app origin, reads cookies, and
 * completes a same-origin fetch — the three things the client demo needed.
 */

const shaOf = (text: string) => createHash('sha256').update(Buffer.from(text)).digest('hex');

/** A deck with the two escape gestures the client-demo page uses. */
function deckHtml(appOrigin: string): string {
  return [
    '<!doctype html><html><head><meta charset="utf-8"><title>Popup E2E Deck</title></head><body>',
    '<h1 id="marker">Popup deck</h1>',
    `<a id="link" href="${appOrigin}/login" target="_blank" rel="noopener">Open (link)</a>`,
    `<button id="button" type="button">Open (window)</button>`,
    '<script>',
    `document.getElementById('button').addEventListener('click', function () {`,
    `  window.open('${appOrigin}/login', 'sl-e2e-probe', 'width=400,height=800');`,
    '});',
    '</script>',
    '</body></html>'
  ].join('\n');
}

function embeddingPage(stackOrigin: string, secret: string): string {
  return [
    '<!doctype html><html><head><meta charset="utf-8"><title>Customer site</title></head><body>',
    `<iframe id="deck" src="${stackOrigin}/v/${secret}/" sandbox="${VIEWER_IFRAME_SANDBOX}"`,
    ' referrerpolicy="no-referrer" allow="fullscreen" style="width:800px;height:450px;border:0"></iframe>',
    '</body></html>'
  ].join('\n');
}

/** What a document can do for itself: its origin, whether cookies are readable, whether a same-origin fetch completes. */
type Posture = { origin: string; cookieReadable: boolean; fetchStatus: number | string };

const probe = async (target: { evaluate: Page['evaluate'] }, url: string): Promise<Posture> =>
  target.evaluate(async (u) => {
    let cookieReadable = true;
    try {
      void document.cookie;
    } catch {
      cookieReadable = false;
    }
    let fetchStatus: number | string;
    try {
      fetchStatus = (await fetch(u, { credentials: 'same-origin' })).status;
    } catch (e) {
      fetchStatus = e instanceof Error ? e.name : String(e);
    }
    return { origin: window.origin, cookieReadable, fetchStatus };
  }, url);

async function seedDeckAndLink(page: Page, appOrigin: string): Promise<{ deckId: string; secret: string }> {
  const html = deckHtml(appOrigin);
  const reserve = await page.request.post('/api/v1/presentations/uploads');
  expect(reserve.status()).toBe(201);
  const { uploadSession } = await reserve.json();
  const upload = await page.request.post('/api/v1/presentations/assets', {
    multipart: {
      sha256: shaOf(html),
      file: { name: 'index.html', mimeType: 'text/html', buffer: Buffer.from(html) }
    }
  });
  expect(upload.status()).toBe(201);
  const commit = await page.request.post(`/api/v1/presentations/uploads/${uploadSession.id}/commit`, {
    data: {
      title: 'Popup E2E Deck',
      entryPath: 'index.html',
      manifest: [
        {
          path: 'index.html',
          sha256: shaOf(html),
          sizeBytes: Buffer.byteLength(html),
          contentType: 'text/html'
        }
      ]
    }
  });
  expect(commit.status()).toBe(201);
  const deckId = (await commit.json()).presentation.id as string;
  const token = await page.request.post(`/api/v1/presentations/${deckId}/tokens`, {
    data: { name: 'e2e-popups' }
  });
  expect(token.status()).toBe(201);
  return { deckId, secret: (await token.json()).secret as string };
}

test('share link: the deck stays sandboxed, the windows it opens run on the app origin', async ({
  page,
  browser
}) => {
  await test.step('sign in as the owner', async () => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(OWNER.email);
    await page.getByLabel('Password').fill(OWNER.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible({ timeout: 20_000 });
  });

  const appOrigin = new URL(page.url()).origin;
  const { deckId, secret } = await seedDeckAndLink(page, appOrigin);

  const visitor = await (await browser.newContext()).newPage();
  try {
    await test.step('the deck itself runs in the opaque origin (ADR 012 holds)', async () => {
      const res = await visitor.goto(`/v/${secret}/`);
      expect(res?.headers()['content-security-policy']).toContain('allow-popups-to-escape-sandbox');
      expect(res?.headers()['content-security-policy']).not.toContain('allow-same-origin');
      await expect(visitor.locator('#marker')).toHaveText('Popup deck');
      const deck = await probe(visitor, `${appOrigin}/readyz`);
      expect(deck.origin).toBe('null');
      expect(deck.cookieReadable).toBe(false);
      // A fetch from origin null to the app is refused (CORS) — the client demo's second error.
      expect(deck.fetchStatus).not.toBe(200);
    });

    await test.step('a target=_blank link opens a normal page', async () => {
      const [popup] = await Promise.all([visitor.waitForEvent('popup'), visitor.locator('#link').click()]);
      await popup.waitForLoadState('domcontentloaded');
      const opened = await probe(popup, `${appOrigin}/readyz`);
      expect(opened.origin).toBe(appOrigin);
      expect(opened.cookieReadable).toBe(true);
      expect(opened.fetchStatus).toBe(200);
      await popup.close();
    });

    await test.step('window.open with a window name opens a normal page', async () => {
      const [popup] = await Promise.all([visitor.waitForEvent('popup'), visitor.locator('#button').click()]);
      await popup.waitForLoadState('domcontentloaded');
      const opened = await probe(popup, `${appOrigin}/readyz`);
      expect(opened.origin).toBe(appOrigin);
      expect(opened.cookieReadable).toBe(true);
      expect(opened.fetchStatus).toBe(200);
      await popup.close();
    });
  } finally {
    await visitor.context().close();
    await page.request.delete(`/api/v1/presentations/${deckId}`);
  }
});

test('embed iframe: the framed deck stays sandboxed, the windows it opens run on the app origin', async ({
  page,
  browser
}) => {
  await test.step('sign in as the owner', async () => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(OWNER.email);
    await page.getByLabel('Password').fill(OWNER.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible({ timeout: 20_000 });
  });

  const appOrigin = new URL(page.url()).origin;
  const { deckId, secret } = await seedDeckAndLink(page, appOrigin);

  let server: Server | undefined;
  const visitor = await (await browser.newContext()).newPage();
  try {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(embeddingPage(appOrigin, secret));
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const embedOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect(embedOrigin).not.toBe(appOrigin);

    await visitor.goto(`${embedOrigin}/`);
    const frame = visitor.frameLocator('#deck');
    await expect(frame.locator('#marker')).toHaveText('Popup deck');

    await test.step('the framed deck runs in the opaque origin', async () => {
      const inner = visitor.frames().find((f) => f.url().includes('/v/'));
      expect(inner).toBeTruthy();
      const deck = await probe(inner!, `${appOrigin}/readyz`);
      expect(deck.origin).toBe('null');
      expect(deck.cookieReadable).toBe(false);
    });

    await test.step('a target=_blank link inside the frame opens a normal page', async () => {
      const [popup] = await Promise.all([visitor.waitForEvent('popup'), frame.locator('#link').click()]);
      await popup.waitForLoadState('domcontentloaded');
      const opened = await probe(popup, `${appOrigin}/readyz`);
      expect(opened.origin).toBe(appOrigin);
      expect(opened.cookieReadable).toBe(true);
      expect(opened.fetchStatus).toBe(200);
      await popup.close();
    });

    await test.step('window.open inside the frame opens a normal page', async () => {
      const [popup] = await Promise.all([visitor.waitForEvent('popup'), frame.locator('#button').click()]);
      await popup.waitForLoadState('domcontentloaded');
      const opened = await probe(popup, `${appOrigin}/readyz`);
      expect(opened.origin).toBe(appOrigin);
      expect(opened.cookieReadable).toBe(true);
      expect(opened.fetchStatus).toBe(200);
      await popup.close();
    });
  } finally {
    await visitor.context().close();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await page.request.delete(`/api/v1/presentations/${deckId}`);
  }
});
