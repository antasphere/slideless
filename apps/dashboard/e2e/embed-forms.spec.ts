import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect } from '@playwright/test';
import { OWNER } from './accounts';

/**
 * ADR 022 §2 — a deck form submits from INSIDE an official embed, proven
 * from a genuinely different origin (the embed.spec.ts second-origin
 * harness: a throwaway local http server = its own origin, loading
 * /embed.js from the stack).
 *
 *  - the forms runtime injects into the frame navigation (the deliberate
 *    split from the annotation overlay, which stays document-only) and
 *    wires the submit — a native submit inside the sandbox would
 *    garbage-navigate;
 *  - the recorded row carries source 'embed' and the
 *    `data-slideless-placement` label of the embedding div;
 *  - the confirmation card renders inside the frame with the personal
 *    edit link.
 */

const DECK_HTML = [
  '<!doctype html><html><head><meta charset="utf-8"><title>Embed Forms E2E Deck</title></head><body>',
  '<h1>Embedded RSVP</h1>',
  '<form data-slideless-form="rsvp">',
  '  <input id="f-name" name="name" placeholder="Your name">',
  '  <button id="f-send" type="submit">Send</button>',
  '</form>',
  '</body></html>'
].join('\n');

const shaOf = (text: string) => createHash('sha256').update(Buffer.from(text)).digest('hex');

function embeddingPage(stackOrigin: string, secret: string): string {
  return [
    '<!doctype html><html><head><meta charset="utf-8"><title>Customer site</title></head><body>',
    '<h1>A customer page embedding a deck with a form</h1>',
    `<div id="good" data-slideless-embed="${stackOrigin}/v/${secret}"`,
    ' data-slideless-placement="e2e-form-embed"></div>',
    `<script src="${stackOrigin}/embed.js" async></script>`,
    '</body></html>'
  ].join('\n');
}

test('embedded form: submits cross-origin from the iframe; the row records source embed + placement', async ({
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
  let secret = '';
  await test.step('seed the form deck + a share link via the API', async () => {
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
        title: 'Embed Forms E2E Deck',
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

    const token = await page.request.post(`/api/v1/presentations/${deckId}/tokens`, {
      data: { name: 'e2e-embed-form' }
    });
    expect(token.status()).toBe(201);
    secret = (await token.json()).secret;
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
    await test.step('the deck + its form render inside the embed iframe', async () => {
      await visitor.goto(`${embedOrigin}/`);
      const frame = visitor.frameLocator('#good iframe');
      await expect(frame.locator('form[data-slideless-form="rsvp"]')).toBeVisible();
    });

    await test.step('submitting inside the frame swaps to the confirmation card (no navigation)', async () => {
      const frame = visitor.frameLocator('#good iframe');
      await frame.locator('#f-name').fill('Embedded Visitor');
      await frame.locator('#f-send').click();
      const card = frame.locator('.sl-forms-card');
      await expect(card).toBeVisible();
      await expect(card.locator('.sl-forms-link')).toContainText(`/v/${secret}/#slr=`);
      // The frame is still the deck document — the runtime intercepted the
      // native submit that would have garbage-navigated the sandbox.
      await expect(frame.locator('h1')).toHaveText('Embedded RSVP');
      await expect(frame.locator('form[data-slideless-form="rsvp"]')).toBeHidden();
    });

    await test.step("the row records source 'embed' + the placement label", async () => {
      const listed = await page.request.get(`/api/v1/presentations/${deckId}/responses`);
      expect(listed.status()).toBe(200);
      const { responses } = await listed.json();
      expect(responses).toHaveLength(1);
      expect(responses[0]).toMatchObject({
        formName: 'rsvp',
        source: 'embed',
        placement: 'e2e-form-embed',
        respondentUserId: null, // cross-site frame: no session, no identity
        payload: { name: 'Embedded Visitor' }
      });

      const summary = await page.request.get(`/api/v1/presentations/${deckId}/responses/summary`);
      const body = await summary.json();
      expect(body.total).toBe(1);
      expect(body.buckets[0]).toMatchObject({
        formName: 'rsvp',
        source: 'embed',
        placement: 'e2e-form-embed',
        count: 1
      });
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
