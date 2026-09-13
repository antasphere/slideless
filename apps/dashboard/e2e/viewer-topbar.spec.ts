import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect, type Page } from '@playwright/test';
import { VIEWER_IFRAME_SANDBOX } from '@slideless/contract';
import { signInAsOwner } from './accounts';

/**
 * PRDCT-2281 — the recipient TOP BAR against the real stack, in a real
 * Chromium: a share link opens with a slim bar over the deck (the title,
 * `v1`, the files to download one by one or all at once), the deck is
 * pushed down and never covered (a `100vh` slide keeps its whole height,
 * reachable by scrolling), the bar collapses to a handle and remembers it
 * across a reload, a click on the bar never reaches the deck's own
 * navigation, deck CSS cannot restyle it (shadow root), a link with
 * downloads off shows the bar without a menu, a `showBar:false` link is
 * bare, an iframe embed is bare, an HTML sub-page opened top-level keeps
 * the bar, and the annotation badge sits below the bar when both mount.
 */

const BAR = '#__slideless_topbar';
const CSV = 'quarter,revenue\nQ3,42\n';
const PDF = '%PDF-1.4 annex for the e2e spec';

/** A deck sized to the viewport, that advances a counter on ANY document click, and tries to restyle every button red. */
const INDEX_HTML = [
  '<!doctype html><html><head><meta charset="utf-8"><title>Topbar E2E Deck</title>',
  // h1 margin 0: a default heading margin collapses through the slide and
  // the body, and would move the slide's top edge on its own.
  '<style>html,body{margin:0}h1{margin:0}#slide{height:100vh;background:#dfe7f5}button{background:#ff0000 !important;color:#ff0000 !important}</style>',
  '</head><body>',
  '<section id="slide"><h1 id="marker">Quarterly review</h1><p><a id="to-page2" href="pages/two.html">Open page two</a></p></section>',
  '<div id="counter">0</div>',
  '<script>',
  '  var n = 0;',
  '  document.addEventListener("click", function () { n++; document.getElementById("counter").textContent = String(n); });',
  '</script>',
  '</body></html>'
].join('\n');
const PAGE_TWO_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title>Page two</title></head><body><h1 id="page2">Page two</h1></body></html>';

const shaOf = (text: string) => createHash('sha256').update(Buffer.from(text)).digest('hex');
const entryOf = (path: string, text: string, contentType: string) => ({
  path,
  sha256: shaOf(text),
  sizeBytes: Buffer.byteLength(text),
  contentType
});

async function uploadAsset(page: Page, text: string, mimeType: string, name: string): Promise<void> {
  const res = await page.request.post('/api/v1/presentations/assets', {
    multipart: { sha256: shaOf(text), file: { name, mimeType, buffer: Buffer.from(text) } }
  });
  expect(res.status()).toBe(201);
}

async function mintLink(page: Page, deckId: string, body: Record<string, unknown>): Promise<string> {
  const token = await page.request.post(`/api/v1/presentations/${deckId}/tokens`, { data: body });
  expect(token.status()).toBe(201);
  return (await token.json()).secret as string;
}

function embeddingPage(stackOrigin: string, secret: string): string {
  return [
    '<!doctype html><html><head><meta charset="utf-8"><title>Customer site</title></head><body>',
    `<iframe id="deck" src="${stackOrigin}/v/${secret}/" sandbox="${VIEWER_IFRAME_SANDBOX}"`,
    ' referrerpolicy="no-referrer" style="width:800px;height:450px;border:0"></iframe>',
    '</body></html>'
  ].join('\n');
}

test('the recipient bar: title, version, downloads, push-down, collapse, isolation, and where it never mounts', async ({
  page,
  browser
}) => {
  await test.step('sign in as the owner', async () => {
    await signInAsOwner(page);
  });

  let deckId = '';
  await test.step('seed the deck: a 100vh slide, a sub-page, two attachments', async () => {
    const reserve = await page.request.post('/api/v1/presentations/uploads');
    expect(reserve.status()).toBe(201);
    const { uploadSession } = await reserve.json();
    await uploadAsset(page, INDEX_HTML, 'text/html', 'index.html');
    await uploadAsset(page, PAGE_TWO_HTML, 'text/html', 'two.html');
    await uploadAsset(page, CSV, 'text/csv', 'figures.csv');
    await uploadAsset(page, PDF, 'application/pdf', 'annex.pdf');
    const commit = await page.request.post(`/api/v1/presentations/uploads/${uploadSession.id}/commit`, {
      data: {
        title: 'Quarterly review',
        entryPath: 'index.html',
        manifest: [
          entryOf('index.html', INDEX_HTML, 'text/html'),
          entryOf('pages/two.html', PAGE_TWO_HTML, 'text/html'),
          entryOf('downloads/figures.csv', CSV, 'text/csv'),
          entryOf('downloads/annex.pdf', PDF, 'application/pdf')
        ]
      }
    });
    expect(commit.status()).toBe(201);
    deckId = (await commit.json()).presentation.id;
  });

  const origin = new URL(page.url()).origin;
  const secret = await mintLink(page, deckId, { name: 'e2e-bar' });
  const noDownloads = await mintLink(page, deckId, { name: 'e2e-bar-no-downloads', canDownload: false });
  const bare = await mintLink(page, deckId, { name: 'e2e-bare', showBar: false });
  const annotator = await mintLink(page, deckId, {
    name: 'e2e-bar-annotator',
    canAnnotate: true,
    badgePosition: 'top-right'
  });

  const recipient = await (await browser.newContext({ viewport: { width: 1000, height: 700 } })).newPage();
  let server: Server | undefined;
  try {
    await test.step('the bar mounts in a shadow root with the title and the version', async () => {
      await recipient.goto(`${origin}/v/${secret}/`);
      await expect(recipient.locator('#marker')).toHaveText('Quarterly review');
      await expect(recipient.locator(BAR)).toHaveCount(1);
      // Playwright pierces open shadow roots: the strip lives inside one.
      await expect(recipient.locator(`${BAR} .bar`)).toBeVisible();
      await expect(recipient.locator(`${BAR} .title strong`)).toHaveText('Quarterly review');
      await expect(recipient.locator(`${BAR} .version`)).toHaveText('v1');
      await expect(recipient.locator(`${BAR} .mark`)).toContainText('Slideless');
      expect(await recipient.locator(BAR).evaluate((el) => el.shadowRoot !== null)).toBe(true);
    });

    await test.step('deck CSS cannot restyle the bar: the download button is not red', async () => {
      const bg = await recipient
        .locator(`${BAR} .dl > button`)
        .evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(bg).not.toBe('rgb(255, 0, 0)');
    });

    await test.step('the deck is pushed down, never covered: the 100vh slide keeps its whole height', async () => {
      const slideTop = await recipient.locator('#slide').evaluate((el) => el.getBoundingClientRect().top);
      const barHeight = await recipient.locator(BAR).evaluate((el) => el.getBoundingClientRect().height);
      expect(barHeight).toBeGreaterThanOrEqual(40);
      expect(slideTop).toBeGreaterThanOrEqual(barHeight);
      const offset = await recipient.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--slideless-topbar').trim()
      );
      expect(offset).toBe(`${barHeight}px`);
      // The bottom of the slide is reachable: scroll to the end, it ends inside the viewport.
      await recipient.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      const bottom = await recipient.locator('#slide').evaluate((el) => el.getBoundingClientRect().bottom);
      const innerHeight = await recipient.evaluate(() => window.innerHeight);
      expect(bottom).toBeLessThanOrEqual(innerHeight + 1);
      const slideHeight = await recipient
        .locator('#slide')
        .evaluate((el) => el.getBoundingClientRect().height);
      expect(Math.round(slideHeight)).toBe(innerHeight);
      await recipient.evaluate(() => window.scrollTo(0, 0));
    });

    await test.step('the download menu lists each file with its size and the whole set as a zip', async () => {
      await expect(recipient.locator('#counter')).toHaveText('0');
      await recipient.locator(`${BAR} .dl > button`).click();
      const items = recipient.locator(`${BAR} .menu a`);
      await expect(items).toHaveCount(3);
      // Manifest order: the files as the deck lists them.
      await expect(items.nth(0)).toContainText('figures.csv');
      await expect(items.nth(0).locator('.size')).toHaveText(`${Buffer.byteLength(CSV)} B`);
      await expect(items.nth(1)).toContainText('annex.pdf');
      await expect(items.nth(1).locator('.size')).toHaveText(`${Buffer.byteLength(PDF)} B`);
      await expect(items.nth(2)).toContainText('Download all (2 files)');
      // Opening the menu was a click on the bar: the deck's own click counter never moved.
      await expect(recipient.locator('#counter')).toHaveText('0');
    });

    await test.step('download one file: the bytes match', async () => {
      const [download] = await Promise.all([
        recipient.waitForEvent('download'),
        recipient.locator(`${BAR} .menu a`, { hasText: 'figures.csv' }).click()
      ]);
      expect(download.suggestedFilename()).toBe('figures.csv');
      const path = await download.path();
      expect(path).toBeTruthy();
      expect((await readFile(path!)).toString()).toBe(CSV);
    });

    await test.step('download all: a zip named after the deck and its version', async () => {
      await recipient.locator(`${BAR} .dl > button`).click();
      const [download] = await Promise.all([
        recipient.waitForEvent('download'),
        recipient.locator(`${BAR} .menu a`, { hasText: 'Download all' }).click()
      ]);
      expect(download.suggestedFilename()).toMatch(/\.zip$/);
      expect(download.suggestedFilename()).toContain('v1');
      const path = await download.path();
      expect(path).toBeTruthy();
      const bytes = await readFile(path!);
      expect(bytes.subarray(0, 2).toString()).toBe('PK');
      expect(bytes.includes(Buffer.from('figures.csv'))).toBe(true);
      expect(bytes.includes(Buffer.from('annex.pdf'))).toBe(true);
    });

    await test.step('the deck still takes its own clicks', async () => {
      await recipient.locator('#marker').click();
      await expect(recipient.locator('#counter')).toHaveText('1');
    });

    await test.step('collapse to a handle, remembered across a reload; expand again', async () => {
      await recipient.locator(`${BAR} .hide`).click();
      await expect(recipient.locator(BAR)).toHaveAttribute('data-collapsed', '');
      await expect(recipient.locator(`${BAR} .bar`)).toBeHidden();
      await expect(recipient.locator(`${BAR} .handle`)).toBeVisible();
      const slideTop = await recipient.locator('#slide').evaluate((el) => el.getBoundingClientRect().top);
      expect(slideTop).toBe(0);
      expect(
        await recipient.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue('--slideless-topbar').trim()
        )
      ).toBe('0px');

      await recipient.reload();
      await expect(recipient.locator('#marker')).toHaveText('Quarterly review');
      await expect(recipient.locator(BAR)).toHaveAttribute('data-collapsed', '');

      await recipient.locator(`${BAR} .handle`).click();
      await expect(recipient.locator(BAR)).not.toHaveAttribute('data-collapsed', '');
      await expect(recipient.locator(`${BAR} .bar`)).toBeVisible();
    });

    await test.step('an HTML sub-page opened top-level keeps the bar', async () => {
      await recipient.locator('#to-page2').click();
      await expect(recipient.locator('#page2')).toHaveText('Page two');
      await expect(recipient.locator(`${BAR} .bar`)).toBeVisible();
      await expect(recipient.locator(`${BAR} .title strong`)).toHaveText('Quarterly review');
    });

    await test.step('a link with downloads off: the bar without a menu', async () => {
      await recipient.goto(`${origin}/v/${noDownloads}/`);
      await expect(recipient.locator(`${BAR} .bar`)).toBeVisible();
      await expect(recipient.locator(`${BAR} .version`)).toHaveText('v1');
      await expect(recipient.locator(`${BAR} .dl > button`)).toBeHidden();
    });

    await test.step('a showBar:false link is bare', async () => {
      await recipient.goto(`${origin}/v/${bare}/`);
      await expect(recipient.locator('#marker')).toHaveText('Quarterly review');
      await expect(recipient.locator(BAR)).toHaveCount(0);
      const slideTop = await recipient.locator('#slide').evaluate((el) => el.getBoundingClientRect().top);
      expect(slideTop).toBe(0);
    });

    await test.step('the annotation badge sits below the bar when both mount', async () => {
      await recipient.goto(`${origin}/v/${annotator}/`);
      await expect(recipient.locator(`${BAR} .bar`)).toBeVisible();
      await expect(recipient.locator('#__sl-badge')).toBeVisible();
      const bar = await recipient.locator(BAR).boundingBox();
      const badge = await recipient.locator('#__sl-badge').boundingBox();
      expect(bar && badge && badge.y >= bar.y + bar.height).toBe(true);
    });

    await test.step('an iframe embed stays bare', async () => {
      server = createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(embeddingPage(origin, secret));
      });
      await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
      const embedOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      await recipient.goto(`${embedOrigin}/`);
      const frame = recipient.frameLocator('#deck');
      await expect(frame.locator('#marker')).toHaveText('Quarterly review');
      await expect(frame.locator(BAR)).toHaveCount(0);
      const slideTop = await frame.locator('#slide').evaluate((el) => el.getBoundingClientRect().top);
      expect(slideTop).toBe(0);
    });
  } finally {
    await recipient.context().close();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await page.request.delete(`/api/v1/presentations/${deckId}`);
  }
});
