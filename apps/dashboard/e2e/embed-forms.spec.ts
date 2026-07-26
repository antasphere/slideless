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
 *    edit link;
 *  - PRDCT-1332: the loader STRIPS any fragment the embedding page put in
 *    `data-slideless-embed`. It validates `url.pathname` and used to
 *    forward `url.href` whole, so a site could mount
 *    `.../v/{secret}/#slr=<its own response's edit secret>` and harvest
 *    whatever a visitor typed — their answers overwrote the framer's row,
 *    which the framer then read back. The sandbox held throughout; this is
 *    a fragment-channel attack, not an origin break.
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

/**
 * `fragment` is the hostile half: whatever the embedding SITE appends to
 * the deck URL it hands the loader. Empty on the honest first render.
 */
function embeddingPage(stackOrigin: string, secret: string, fragment = ''): string {
  return [
    '<!doctype html><html><head><meta charset="utf-8"><title>Customer site</title></head><body>',
    '<h1>A customer page embedding a deck with a form</h1>',
    `<div id="good" data-slideless-embed="${stackOrigin}/v/${secret}${fragment}"`,
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
  // Mutated below so the SAME origin can re-render itself hostile.
  let plantedFragment = '';
  await test.step('serve a customer page from its own origin', async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(embeddingPage(stackOrigin, secret, plantedFragment));
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

    await test.step('PRDCT-1332: the loader strips a planted #slr= and the harvest fails', async () => {
      // The framer now owns a response (the one just submitted from their
      // own page) and re-serves themselves with its secret in the fragment.
      const frame = visitor.frameLocator('#good iframe');
      const link = (await frame.locator('.sl-forms-link').textContent()) ?? '';
      const framerSecret = link.split('#slr=')[1] ?? '';
      expect(framerSecret).not.toBe('');
      plantedFragment = `/#slr=${framerSecret}`;

      const mark = await (await browser.newContext()).newPage();
      try {
        await mark.goto(`${embedOrigin}/`);
        // Half 1 — embed.ts: the mounted frame's src carries NO fragment.
        const src = await mark.locator('#good iframe').getAttribute('src');
        expect(src).not.toContain('#');
        expect(src).not.toContain(framerSecret);

        // Half 2 — end to end: the visitor's answers become their OWN row.
        const marked = mark.frameLocator('#good iframe');
        await expect(marked.locator('form[data-slideless-form="rsvp"]')).toBeVisible();
        // Nothing was adopted, so no resume prompt and no prefill either.
        await expect(marked.locator('[data-slideless-resume="rsvp"]')).toHaveCount(0);
        await expect(marked.locator('#f-name')).toHaveValue('');
        await marked.locator('#f-name').fill('Real Subscriber');
        await marked.locator('#f-send').click();
        await expect(marked.locator('[data-slideless-card="rsvp"]')).toBeVisible();

        const listed = await page.request.get(`/api/v1/presentations/${deckId}/responses`);
        const { responses } = await listed.json();
        expect(responses).toHaveLength(2); // a new row, not an overwrite
        const framerRow = responses.find(
          (r: { payload: Record<string, string> }) => r.payload['name'] === 'Embedded Visitor'
        );
        expect(framerRow).toBeDefined(); // the framer's row is untouched
        expect(
          responses.some((r: { payload: Record<string, string> }) => r.payload['name'] === 'Real Subscriber')
        ).toBe(true);
      } finally {
        await mark.context().close();
      }
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
