import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect } from '@playwright/test';
import { VIEWER_IFRAME_SANDBOX } from '@slideless/contract';
import { OWNER } from './accounts';

/**
 * PRDCT-1312 — the official embed loader against the real stack, from a
 * genuinely DIFFERENT origin: a throwaway local http server (its own port =
 * its own origin) serves a customer-style page that loads /embed.js from
 * the stack. Proves the whole promise end-to-end:
 *
 *  - the loader turns `div[data-slideless-embed]` into the exact ADR 012
 *    Surface D iframe (sandbox attrs from the contract constant);
 *  - the deck renders inside it, cross-origin;
 *  - embeds are view-only — no annotation overlay even for a can-annotate
 *    token (the ADR 020 iframe gate);
 *  - an invalid URL leaves its div untouched; re-running the script never
 *    double-mounts;
 *  - the `data-slideless-placement` label lands on the recorded view event.
 */

const MARKER = 'Embedded deck marker for the e2e spec.';
const DECK_HTML = [
  '<!doctype html><html><head><meta charset="utf-8"><title>Embed E2E Deck</title></head><body>',
  `<h1 id="marker">${MARKER}</h1>`,
  '</body></html>'
].join('\n');

const shaOf = (text: string) => createHash('sha256').update(Buffer.from(text)).digest('hex');

function embeddingPage(stackOrigin: string, secret: string): string {
  return [
    '<!doctype html><html><head><meta charset="utf-8"><title>Customer site</title></head><body>',
    '<h1>A customer page embedding a deck</h1>',
    // Valid embed: NO trailing slash (the loader must normalize), a
    // placement label, and a non-default aspect ratio.
    `<div id="good" data-slideless-embed="${stackOrigin}/v/${secret}"`,
    ' data-slideless-placement="e2e-embed" data-aspect-ratio="4/3"></div>',
    // Invalid embed: not a viewer path — must be left untouched.
    `<div id="bad" data-slideless-embed="${stackOrigin}/api/v1/me">untouched</div>`,
    `<script src="${stackOrigin}/embed.js" async></script>`,
    '</body></html>'
  ].join('\n');
}

test('official embed: cross-origin loader mounts the Surface D iframe, deck renders, placement lands', async ({
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

  let deckId = '';
  let tokenId = '';
  let secret = '';
  await test.step('seed a deck + a CAN-ANNOTATE link via the API', async () => {
    const reserve = await page.request.post('/api/v1/presentations/uploads');
    expect(reserve.status()).toBe(201);
    const { uploadSession } = await reserve.json();
    const upload = await page.request.post('/api/v1/presentations/assets', {
      multipart: {
        sha256: shaOf(DECK_HTML),
        file: { name: 'index.html', mimeType: 'text/html', buffer: Buffer.from(DECK_HTML) }
      }
    });
    expect(upload.status()).toBe(201);
    const commit = await page.request.post(`/api/v1/presentations/uploads/${uploadSession.id}/commit`, {
      data: {
        title: 'Embed E2E Deck',
        entryPath: 'index.html',
        manifest: [
          {
            path: 'index.html',
            sha256: shaOf(DECK_HTML),
            sizeBytes: Buffer.byteLength(DECK_HTML),
            contentType: 'text/html'
          }
        ]
      }
    });
    expect(commit.status()).toBe(201);
    deckId = (await commit.json()).presentation.id;

    // canAnnotate on purpose: the strongest proof that embeds stay
    // view-only is a link that WOULD get the overlay as a top-level page.
    const token = await page.request.post(`/api/v1/presentations/${deckId}/tokens`, {
      data: { name: 'e2e-embed', canAnnotate: true }
    });
    expect(token.status()).toBe(201);
    const created = await token.json();
    tokenId = created.shareToken.id;
    secret = created.secret;
  });

  const stackOrigin = new URL(page.url()).origin;

  // The SECOND origin: a throwaway local server — different port, therefore
  // a different origin from the stack in every browser's eyes.
  let server: Server | undefined;
  let embedOrigin = '';
  await test.step('serve a customer page from its own origin', async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(embeddingPage(stackOrigin, secret));
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    embedOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect(embedOrigin).not.toBe(stackOrigin);
  });

  const visitor = await (await browser.newContext()).newPage();
  try {
    await test.step('the loader mounts the exact Surface D iframe', async () => {
      await visitor.goto(`${embedOrigin}/`);
      const frame = visitor.locator('#good iframe');
      await expect(frame).toHaveCount(1);
      await expect(frame).toHaveAttribute('sandbox', VIEWER_IFRAME_SANDBOX);
      await expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer');
      await expect(frame).toHaveAttribute('allow', 'fullscreen');
      // Normalized trailing slash + the placement label as ?p=.
      await expect(frame).toHaveAttribute('src', `${stackOrigin}/v/${secret}/?p=e2e-embed`);
      const ratio = await frame.evaluate((el) => (el as HTMLElement).style.aspectRatio);
      expect(ratio.replace(/\s/g, '')).toBe('4/3');
    });

    await test.step('the deck renders inside; the overlay never mounts in an embed', async () => {
      const inner = visitor.frameLocator('#good iframe');
      await expect(inner.locator('#marker')).toHaveText(MARKER);
      // Can-annotate link, but iframe = sub-resource → view-only (ADR 020).
      await expect(inner.locator('#__slideless_annotate')).toHaveCount(0);
      await expect(inner.locator('#__sl-badge')).toHaveCount(0);
    });

    await test.step('the invalid div is left untouched', async () => {
      await expect(visitor.locator('#bad iframe')).toHaveCount(0);
      await expect(visitor.locator('#bad')).toHaveText('untouched');
    });

    await test.step('re-running the loader never double-mounts', async () => {
      await visitor.evaluate((origin) => {
        return new Promise<void>((resolve, reject) => {
          const s = document.createElement('script');
          s.src = `${origin}/embed.js`;
          s.onload = () => resolve();
          s.onerror = () => reject(new Error('embed.js reload failed'));
          document.body.appendChild(s);
        });
      }, stackOrigin);
      await expect(visitor.locator('#good iframe')).toHaveCount(1);
    });

    await test.step('the placement label landed on the recorded view event', async () => {
      const views = await page.request.get(
        `/api/v1/presentations/${deckId}/tokens/${tokenId}/views`
      );
      expect(views.status()).toBe(200);
      const body = await views.json();
      expect(body.views.length).toBeGreaterThanOrEqual(1);
      expect(body.views[0].placement).toBe('e2e-embed');
      // Surface D sends no referrer — placement is the attribution channel.
      expect(body.views[0].referrerHost).toBeNull();
    });
  } finally {
    await visitor.context().close();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  }

  await test.step('clean up: delete the deck', async () => {
    const del = await page.request.delete(`/api/v1/presentations/${deckId}`);
    expect(del.status()).toBe(200);
  });
});
