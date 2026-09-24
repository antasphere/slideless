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
 * the bar, the annotation badge sits below the bar when both mount, and
 * the Export PDF action (PRDCT-2668) shows on a default link and not on a
 * `canExportPdf:false` one.
 */

const BAR = '#__slideless_topbar';
const CSV = 'quarter,revenue\nQ3,42\n';
const PDF = '%PDF-1.4 annex for the e2e spec';
/** An attachment whose name carries a space, an ampersand, a hash, a percent and an accent (round 2, F7). */
const ODD_NAME = 'sub dir/an&nex #1 100%-été.txt';
const ODD = 'odd name, plain bytes\n';

/** A deck sized to the viewport, that advances a counter on ANY document click, and tries to restyle every button red. */
const INDEX_HTML = [
  '<!doctype html><html><head><meta charset="utf-8"><title>Topbar E2E Deck</title>',
  // h1 margin 0: a default heading margin collapses through the slide and
  // the body, and would move the slide's top edge on its own. The last two
  // rules aim at the bar's HOST (round 2, F2): a slide-per-div deck rule
  // and a direct hit on its id, both !important.
  '<style>html,body{margin:0}h1{margin:0}#slide{height:100vh;background:#dfe7f5}button{background:#ff0000 !important;color:#ff0000 !important}',
  'body>div{position:relative !important;height:100vh !important}#__slideless_topbar{display:none !important;top:300px !important}</style>',
  '</head><body>',
  '<section id="slide"><h1 id="marker">Quarterly review</h1><p><a id="to-page2" href="pages/two.html">Open page two</a></p></section>',
  '<div id="counter">0</div>',
  '<script>',
  '  var n = 0;',
  '  document.addEventListener("click", function () { n++; document.getElementById("counter").textContent = String(n); });',
  '</script>',
  '</body></html>'
].join('\n');
// Page two carries a <base href> to another host (round 2, F3): the bar's
// links must still point at the deck's own origin.
const PAGE_TWO_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title>Page two</title><base href="http://127.0.0.1:9/assets/"></head><body><h1 id="page2">Page two</h1></body></html>';
/** The mixed shape of round 2, F1: a 100% body that hides overflow, holding a 100vh slide with a footer at its bottom. */
const CLIP_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title>Clip deck</title>' +
  '<style>html,body{margin:0;height:100%;overflow:hidden}h1{margin:0}#slide{height:100vh;position:relative;background:#fee}#foot{position:absolute;bottom:0;left:0;right:0;height:30px;background:#0f8}</style>' +
  '</head><body><section id="slide"><h1 id="marker">Clip deck</h1><div id="foot">FOOTER</div></section></body></html>';
/** The 100%-chain shape (round 2, F8): the slide must fit exactly under the bar. */
const PCT_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title>Pct deck</title>' +
  '<style>html,body{margin:0;height:100%}h1{margin:0}#slide{height:100%;background:#eef}</style>' +
  '</head><body><section id="slide"><h1 id="marker">Pct deck</h1></section></body></html>';

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

/** Seed a one-page deck and return its id. */
async function seedDeck(page: Page, title: string, html: string): Promise<string> {
  const reserve = await page.request.post('/api/v1/presentations/uploads');
  expect(reserve.status()).toBe(201);
  const { uploadSession } = await reserve.json();
  await uploadAsset(page, html, 'text/html', 'index.html');
  const commit = await page.request.post(`/api/v1/presentations/uploads/${uploadSession.id}/commit`, {
    data: { title, entryPath: 'index.html', manifest: [entryOf('index.html', html, 'text/html')] }
  });
  expect(commit.status()).toBe(201);
  return (await commit.json()).presentation.id as string;
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
    await uploadAsset(page, ODD, 'text/plain', 'odd.txt');
    const commit = await page.request.post(`/api/v1/presentations/uploads/${uploadSession.id}/commit`, {
      data: {
        title: 'Quarterly review',
        entryPath: 'index.html',
        manifest: [
          entryOf('index.html', INDEX_HTML, 'text/html'),
          entryOf('pages/two.html', PAGE_TWO_HTML, 'text/html'),
          entryOf('downloads/figures.csv', CSV, 'text/csv'),
          entryOf('downloads/annex.pdf', PDF, 'application/pdf'),
          entryOf(`downloads/${ODD_NAME}`, ODD, 'text/plain')
        ]
      }
    });
    expect(commit.status()).toBe(201);
    deckId = (await commit.json()).presentation.id;
  });

  const origin = new URL(page.url()).origin;
  const clipDeckId = await seedDeck(page, 'Clip deck', CLIP_HTML);
  const pctDeckId = await seedDeck(page, 'Pct deck', PCT_HTML);
  const clip = await mintLink(page, clipDeckId, { name: 'e2e-clip' });
  const pct = await mintLink(page, pctDeckId, { name: 'e2e-pct' });
  const secret = await mintLink(page, deckId, { name: 'e2e-bar' });
  const noDownloads = await mintLink(page, deckId, { name: 'e2e-bar-no-downloads', canDownload: false });
  const bare = await mintLink(page, deckId, { name: 'e2e-bare', showBar: false });
  const noPdf = await mintLink(page, deckId, { name: 'e2e-bar-no-pdf', canExportPdf: false });
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
      // PRDCT-2308: the Antasphere mark, inline, in the bar's own colour; no word.
      const mark = recipient.locator(`${BAR} .mark`);
      await expect(mark).toHaveAttribute('aria-label', 'Antasphere');
      await expect(mark.locator('svg path')).toHaveCount(1);
      expect((await mark.textContent())?.trim()).toBe('');
      expect(await mark.locator('svg').getAttribute('viewBox')).toBe('0 0 512 512');
      const markFill = await mark.locator('svg').evaluate((el) => ({
        fill: el.getAttribute('fill'),
        color: getComputedStyle(el).color,
        bar: getComputedStyle(el.getRootNode().host as HTMLElement).color
      }));
      expect(markFill.fill).toBe('currentColor');
      expect(markFill.color).toBe(markFill.bar);
      expect(await mark.locator('svg').evaluate((el) => el.getBoundingClientRect().width)).toBe(18);
      expect(await recipient.locator(BAR).evaluate((el) => el.shadowRoot !== null)).toBe(true);
    });

    await test.step('deck CSS cannot move or hide the host either: fixed at the top, 44px, visible', async () => {
      const box = await recipient.locator(BAR).boundingBox();
      expect(box).not.toBeNull();
      expect(box!.y).toBe(0);
      expect(Math.round(box!.height)).toBe(44);
      const host = await recipient.locator(BAR).evaluate((el) => {
        const cs = getComputedStyle(el);
        return { position: cs.position, display: cs.display, top: cs.top };
      });
      expect(host).toEqual({ position: 'fixed', display: 'block', top: '0px' });
    });

    await test.step('deck CSS cannot restyle the bar: the download button is not red, and it is not orange either', async () => {
      const bg = await recipient
        .locator(`${BAR} .dl > button`)
        .evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(bg).not.toBe('rgb(255, 0, 0)');
      // PRDCT-2308: the bar's neutral tone, never the accent (the old #f5b301).
      expect(bg).not.toBe('rgb(245, 179, 1)');
      // The dashboard's outline button: the plate (tokens.css --plate-strong), light and dark.
      expect(['rgba(251, 249, 243, 0.82)', 'rgba(40, 34, 28, 0.84)']).toContain(bg);
    });

    await test.step('the download menu opens with the product’s one motion and rests where the dashboard’s popovers do', async () => {
      const menu = recipient.locator(`${BAR} .menu`);
      const motion = await menu.evaluate((el) => {
        const cs = getComputedStyle(el);
        return {
          duration: cs.transitionDuration,
          easing: cs.transitionTimingFunction,
          visibility: cs.visibility
        };
      });
      expect(motion.visibility).toBe('hidden');
      expect(motion.duration.split(', ')[0]).toBe('0.16s');
      // The easing carries commas of its own: match its start, not a split.
      expect(motion.easing.startsWith('cubic-bezier(0.2, 0, 0, 1)')).toBe(true);
      await recipient.locator(`${BAR} .dl > button`).click();
      await expect(menu).toBeVisible();
      await expect.poll(() => menu.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
      expect(await menu.evaluate((el) => getComputedStyle(el).transform)).toBe('none');
      await recipient.keyboard.press('Escape');
      await expect(menu).toBeHidden();
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
      // The body is the scroll container under the bar (the window never scrolls).
      await recipient.evaluate(() => document.body.scrollTo(0, document.body.scrollHeight));
      const bottom = await recipient.locator('#slide').evaluate((el) => el.getBoundingClientRect().bottom);
      const innerHeight = await recipient.evaluate(() => window.innerHeight);
      expect(bottom).toBeLessThanOrEqual(innerHeight + 1);
      const slideHeight = await recipient
        .locator('#slide')
        .evaluate((el) => el.getBoundingClientRect().height);
      expect(Math.round(slideHeight)).toBe(innerHeight);
      await recipient.evaluate(() => document.body.scrollTo(0, 0));
    });

    await test.step('the download menu lists each file with its size and the whole set as a zip', async () => {
      await expect(recipient.locator('#counter')).toHaveText('0');
      await recipient.locator(`${BAR} .dl > button`).click();
      const items = recipient.locator(`${BAR} .menu a`);
      await expect(items).toHaveCount(4);
      // Manifest order: the files as the deck lists them.
      await expect(items.nth(0)).toContainText('figures.csv');
      await expect(items.nth(0).locator('.size')).toHaveText(`${Buffer.byteLength(CSV)} B`);
      await expect(items.nth(1)).toContainText('annex.pdf');
      await expect(items.nth(1).locator('.size')).toHaveText(`${Buffer.byteLength(PDF)} B`);
      await expect(items.nth(2)).toContainText(ODD_NAME);
      await expect(items.nth(3)).toContainText('Download all (3 files)');
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

    await test.step('an odd attachment name downloads byte-exact through the menu', async () => {
      await recipient.locator(`${BAR} .dl > button`).click();
      const [download] = await Promise.all([
        recipient.waitForEvent('download'),
        recipient.locator(`${BAR} .menu a`, { hasText: 'an&nex' }).click()
      ]);
      expect(download.suggestedFilename()).toBe('an&nex #1 100%-été.txt');
      const path = await download.path();
      expect((await readFile(path!)).toString()).toBe(ODD);
    });

    await test.step('the menu on the keyboard: arrows move, Esc closes it, Esc again collapses the bar', async () => {
      await recipient.locator(`${BAR} .dl > button`).click();
      const focused = () =>
        recipient
          .locator(BAR)
          .evaluate((el) => (el.shadowRoot!.activeElement as HTMLElement | null)?.textContent ?? '');
      expect(await focused()).toContain('figures.csv');
      await recipient.keyboard.press('ArrowDown');
      expect(await focused()).toContain('annex.pdf');
      await recipient.keyboard.press('ArrowUp');
      expect(await focused()).toContain('figures.csv');
      await recipient.keyboard.press('Escape');
      await expect(recipient.locator(`${BAR} .dl`)).not.toHaveAttribute('data-open', '');
      expect(await focused()).toContain('Download');
      await recipient.keyboard.press('Escape');
      await expect(recipient.locator(BAR)).toHaveAttribute('data-collapsed', '');
      await recipient.locator(`${BAR} .handle`).click();
      await expect(recipient.locator(BAR)).not.toHaveAttribute('data-collapsed', '');
    });

    await test.step('Esc on the deck is the deck’s: the bar stays', async () => {
      await recipient.locator('#marker').click();
      await recipient.keyboard.press('Escape');
      await expect(recipient.locator(BAR)).not.toHaveAttribute('data-collapsed', '');
    });

    await test.step('a press on the deck closes the menu', async () => {
      await recipient.locator(`${BAR} .dl > button`).click();
      await expect(recipient.locator(`${BAR} .dl`)).toHaveAttribute('data-open', '');
      await recipient.mouse.move(500, 400);
      await recipient.mouse.down();
      await recipient.mouse.up();
      await expect(recipient.locator(`${BAR} .dl`)).not.toHaveAttribute('data-open', '');
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
      const before = Number(await recipient.locator('#counter').textContent());
      await recipient.locator('#marker').click();
      await expect(recipient.locator('#counter')).toHaveText(String(before + 1));
    });

    await test.step('the fold slides: the strip moves up with the one motion and rests hidden, the handle fades in after it', async () => {
      const strip = recipient.locator(`${BAR} .bar`);
      const motion = await strip.evaluate((el) => {
        const cs = getComputedStyle(el);
        return {
          duration: cs.transitionDuration.split(', ')[0],
          easingStart: cs.transitionTimingFunction.startsWith('cubic-bezier(0.2, 0, 0, 1)')
        };
      });
      expect(motion).toEqual({ duration: '0.16s', easingStart: true });
      const hostMotion = await recipient
        .locator(BAR)
        .evaluate((el) => getComputedStyle(el).transitionProperty);
      expect(hostMotion).toBe('height');
      await recipient.locator(`${BAR} .hide`).click();
      // Mid-fold the strip is still rendered (visibility is delayed by the
      // motion); at rest it is out of the tree and the host is the handle.
      await expect(recipient.locator(BAR)).toHaveAttribute('data-collapsed', '');
      await expect.poll(() => strip.evaluate((el) => getComputedStyle(el).visibility)).toBe('hidden');
      await expect.poll(() => strip.evaluate((el) => getComputedStyle(el).opacity)).toBe('0');
      await expect
        .poll(() => recipient.locator(BAR).evaluate((el) => el.getBoundingClientRect().height))
        .toBe(10);
      await expect(recipient.locator(`${BAR} .handle`)).toBeVisible();
      await expect
        .poll(() => recipient.locator(`${BAR} .handle`).evaluate((el) => getComputedStyle(el).opacity))
        .toBe('1');
      await recipient.locator(`${BAR} .handle`).click();
      await expect(recipient.locator(BAR)).not.toHaveAttribute('data-collapsed', '');
      await expect(strip).toBeVisible();
      await expect.poll(() => strip.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
      await expect
        .poll(() => recipient.locator(BAR).evaluate((el) => el.getBoundingClientRect().height))
        .toBe(44);
      await expect(recipient.locator(`${BAR} .handle`)).toBeHidden();
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

    await test.step('an HTML sub-page opened top-level keeps the bar; its base href does not steer the links', async () => {
      await recipient.locator('#to-page2').click();
      await expect(recipient.locator('#page2')).toHaveText('Page two');
      await expect(recipient.locator(`${BAR} .bar`)).toBeVisible();
      await expect(recipient.locator(`${BAR} .title strong`)).toHaveText('Quarterly review');
      await expect(recipient.locator(`${BAR} .menu a`).first()).toHaveAttribute(
        'href',
        `${origin}/v/${secret}/downloads/figures.csv`
      );
      await expect(recipient.locator(`${BAR} .menu a`).last()).toHaveAttribute(
        'href',
        `${origin}/v/${secret}/downloads.zip`
      );
    });

    await test.step('a 100% body that hides overflow: the 100vh slide’s footer is one scroll away, never clipped', async () => {
      await recipient.goto(`${origin}/v/${clip}/`);
      await expect(recipient.locator(`${BAR} .bar`)).toBeVisible();
      const before = await recipient.locator('#foot').evaluate((el) => el.getBoundingClientRect().bottom);
      const innerHeight = await recipient.evaluate(() => window.innerHeight);
      expect(before).toBeGreaterThan(innerHeight);
      await recipient.mouse.move(500, 400);
      await recipient.mouse.wheel(0, 500);
      await expect
        .poll(() => recipient.locator('#foot').evaluate((el) => el.getBoundingClientRect().bottom))
        .toBeLessThanOrEqual(innerHeight + 1);
      const hit = await recipient.evaluate(() => {
        const r = document.getElementById('foot')!.getBoundingClientRect();
        return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.id ?? null;
      });
      expect(hit).toBe('foot');
    });

    await test.step('a 100% chain fits exactly under the bar, no scroll', async () => {
      await recipient.goto(`${origin}/v/${pct}/`);
      await expect(recipient.locator(`${BAR} .bar`)).toBeVisible();
      const r = await recipient.evaluate(() => {
        const s = document.getElementById('slide')!.getBoundingClientRect();
        return {
          top: s.top,
          bottom: s.bottom,
          innerHeight: window.innerHeight,
          scrollHeight: document.documentElement.scrollHeight
        };
      });
      expect(r.top).toBe(44);
      expect(Math.round(r.bottom)).toBe(r.innerHeight);
      expect(r.scrollHeight).toBe(r.innerHeight);
    });

    await test.step('a link with downloads off: the bar without a menu', async () => {
      await recipient.goto(`${origin}/v/${noDownloads}/`);
      await expect(recipient.locator(`${BAR} .bar`)).toBeVisible();
      await expect(recipient.locator(`${BAR} .version`)).toHaveText('v1');
      await expect(recipient.locator(`${BAR} .dl > button`)).toBeHidden();
    });

    await test.step('Export PDF (PRDCT-2668): on a default link, off on a canExportPdf:false one', async () => {
      await recipient.goto(`${origin}/v/${secret}/`);
      const pdf = recipient.locator(`${BAR} .bar button`, { hasText: 'Export PDF' });
      await expect(pdf).toBeVisible();
      // The print sheet rides the same flag, one per page.
      await expect(recipient.locator('head style[data-slideless-print]')).toHaveCount(1);
      expect(await recipient.locator('head style[data-slideless-print]').getAttribute('media')).toBe('print');

      await recipient.goto(`${origin}/v/${noPdf}/`);
      await expect(recipient.locator(`${BAR} .bar`)).toBeVisible();
      await expect(recipient.locator(`${BAR} .bar button`, { hasText: 'Export PDF' })).toHaveCount(0);
      await expect(recipient.locator('head style[data-slideless-print]')).toHaveCount(0);
    });

    await test.step('a showBar:false link is bare', async () => {
      await recipient.goto(`${origin}/v/${bare}/`);
      await expect(recipient.locator('#marker')).toHaveText('Quarterly review');
      await expect(recipient.locator(BAR)).toHaveCount(0);
      const slideTop = await recipient.locator('#slide').evaluate((el) => el.getBoundingClientRect().top);
      expect(slideTop).toBe(0);
    });

    await test.step('the annotation controls sit IN the bar when both mount, nothing floats over the deck', async () => {
      await recipient.goto(`${origin}/v/${annotator}/`);
      await expect(recipient.locator(`${BAR} .bar`)).toBeVisible();
      // The bar hosts the two entrances under the overlay's ids (the shadow
      // root is open, so the locator reaches them); the overlay creates no
      // floating button of its own.
      await expect(recipient.locator(`${BAR} #__sl-badge`)).toBeVisible();
      await expect(recipient.locator(`${BAR} #__sl-fab-pin`)).toBeVisible();
      await expect(recipient.locator('#__slideless_annotate #__sl-badge')).toHaveCount(0);
      const bar = await recipient.locator(BAR).boundingBox();
      const badge = await recipient.locator(`${BAR} #__sl-badge`).boundingBox();
      expect(bar && badge && badge.y >= bar.y && badge.y + badge.height <= bar.y + bar.height).toBe(true);
      // The bar's button opens the overlay's panel.
      await recipient.locator(`${BAR} #__sl-badge`).click();
      await expect(recipient.locator('#__sl-sheet')).toHaveClass(/open/);
      await recipient.locator('#__sl-close').click();
      await expect(recipient.locator('#__sl-sheet')).not.toHaveClass(/open/);
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
    await page.request.delete(`/api/v1/presentations/${clipDeckId}`);
    await page.request.delete(`/api/v1/presentations/${pctDeckId}`);
  }
});
