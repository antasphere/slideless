import { createHash } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { OWNER } from './accounts';

/**
 * The viewer annotation overlay, end-to-end against the real stack (this
 * project `dependencies: ['smoke']`, so the owner exists). Covers the three
 * Linear tasks the overlay rework shipped:
 *
 *  - PRDCT-1241: interacting with the overlay NEVER navigates the deck (the
 *    fixture advances slides on any document click — the original repro);
 *  - PRDCT-1242: the anchor is FROZEN when the composer opens — a second
 *    selection made while typing must not replace the saved quote;
 *  - PRDCT-1296: anchors resolve back (pins, jump-to with flash), annotate
 *    mode places point/region pins, and the overlay survives navigation to
 *    a sub-page of a multi-page deck (and stays out of nested iframes).
 */

const QUOTE = 'Select this distinctive sentence for a note.';
const DECOY = 'Decoy navigation text that must never become the anchor.';

const INDEX_HTML = [
  '<!doctype html><html><head><meta charset="utf-8"><title>E2E Viewer Deck</title></head><body>',
  `<section data-slide="1"><h1>Slide one</h1><p id="p1">${QUOTE}</p></section>`,
  '<section data-slide="2" hidden><h1>Slide two</h1></section>',
  '<section data-slide="3" hidden><h1>Slide three</h1></section>',
  `<p id="decoy">${DECOY}</p>`,
  '<div id="counter">1</div>',
  '<a id="to-page2" href="guide/page2.html">Open the guide</a>',
  '<img id="hero" width="160" height="90" alt="hero"',
  ' src="data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22%20width=%22160%22%20height=%2290%22%3E%3Crect%20width=%22160%22%20height=%2290%22%20fill=%22%23ddd%22/%3E%3C/svg%3E">',
  '<iframe id="sub" src="guide/page2.html" width="240" height="120"></iframe>',
  '<script>',
  '  var current = 1;',
  '  document.addEventListener("click", function () {',
  '    current = (current % 3) + 1;',
  '    document.querySelectorAll("[data-slide]").forEach(function (s) {',
  '      s.hidden = s.getAttribute("data-slide") !== String(current);',
  '    });',
  '    document.getElementById("counter").textContent = String(current);',
  '  });',
  '</script>',
  '</body></html>'
].join('\n');

const PAGE_TWO_HTML = [
  '<!doctype html><html><head><meta charset="utf-8"><title>Guide</title></head><body>',
  '<h1 id="guide-title">The guide page</h1>',
  '<p id="g1">Guidance paragraph worth annotating on page two.</p>',
  '</body></html>'
].join('\n');

const shaOf = (text: string) => createHash('sha256').update(Buffer.from(text)).digest('hex');
const entryOf = (path: string, text: string) => ({
  path,
  sha256: shaOf(text),
  sizeBytes: Buffer.byteLength(text),
  contentType: 'text/html'
});

async function uploadAsset(page: Page, text: string): Promise<void> {
  const res = await page.request.post('/api/v1/presentations/assets', {
    multipart: {
      sha256: shaOf(text),
      file: { name: shaOf(text), mimeType: 'text/html', buffer: Buffer.from(text) }
    }
  });
  expect(res.status()).toBe(201);
}

/** Programmatic selection + mouseup — deterministic where mouse-drags flake. */
async function selectText(page: Page, selector: string): Promise<void> {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el || !el.firstChild) throw new Error(`no text to select in ${sel}`);
    const range = document.createRange();
    range.selectNodeContents(el.firstChild);
    const selection = window.getSelection();
    if (!selection) throw new Error('no selection API');
    selection.removeAllRanges();
    selection.addRange(range);
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  }, selector);
}

test('viewer overlay: sheet, frozen anchors, pins, annotate mode, multi-page jump', async ({
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
  await test.step('seed a two-page deck + annotator link via the API', async () => {
    const reserve = await page.request.post('/api/v1/presentations/uploads');
    expect(reserve.status()).toBe(201);
    const { uploadSession } = await reserve.json();
    await uploadAsset(page, INDEX_HTML);
    await uploadAsset(page, PAGE_TWO_HTML);
    const commit = await page.request.post(`/api/v1/presentations/uploads/${uploadSession.id}/commit`, {
      data: {
        title: 'E2E Viewer Deck',
        entryPath: 'index.html',
        manifest: [entryOf('index.html', INDEX_HTML), entryOf('guide/page2.html', PAGE_TWO_HTML)]
      }
    });
    expect(commit.status()).toBe(201);
    deckId = (await commit.json()).presentation.id;

    const token = await page.request.post(`/api/v1/presentations/${deckId}/tokens`, {
      data: { name: 'e2e-viewer-annotator', canAnnotate: true }
    });
    expect(token.status()).toBe(201);
    secret = (await token.json()).secret;
  });

  const origin = new URL(page.url()).origin;
  const reviewer = await (await browser.newContext()).newPage();

  await test.step('the overlay mounts on the entry; nested iframes stay overlay-free', async () => {
    await reviewer.goto(`${origin}/v/${secret}/`);
    await expect(reviewer.locator('#__slideless_annotate')).toHaveCount(1);
    await expect(reviewer.locator('#__sl-badge')).toBeVisible();
    // The nested iframe shows deck content but never the overlay (sub-frame
    // participation is deliberately deferred).
    await expect(reviewer.frameLocator('#sub').locator('#guide-title')).toBeVisible();
    await expect(reviewer.frameLocator('#sub').locator('#__slideless_annotate')).toHaveCount(0);
  });

  await test.step('PRDCT-1241: overlay interaction never navigates the deck', async () => {
    await expect(reviewer.locator('#counter')).toHaveText('1');
    await reviewer.locator('#__sl-badge').click(); // open the sheet
    await expect(reviewer.locator('#__sl-sheet')).toHaveClass(/open/);
    await reviewer.locator('#__sl-sheet .__sl-x').click(); // close it again
    await reviewer.locator('#__sl-badge').click(); // and toggle once more
    await reviewer.locator('#__sl-sheet .__sl-x').click();
    // The fixture advances a slide on ANY document click — none of the four
    // overlay clicks may have reached it.
    await expect(reviewer.locator('#counter')).toHaveText('1');
    // A genuine deck click still works (the overlay does not eat the deck).
    await reviewer.locator('h1', { hasText: 'Slide one' }).click();
    await expect(reviewer.locator('#counter')).toHaveText('2');
    // Cycle back to slide 1 — the next step selects #p1, which is hidden on
    // other slides (hidden content stringifies to nothing, so no pill).
    await reviewer.locator('#decoy').click();
    await expect(reviewer.locator('#counter')).toHaveText('3');
    await reviewer.locator('#decoy').click();
    await expect(reviewer.locator('#counter')).toHaveText('1');
  });

  await test.step('PRDCT-1242: the anchor freezes when the composer opens', async () => {
    await selectText(reviewer, '#p1');
    await expect(reviewer.locator('#__sl-add')).toBeVisible();
    await reviewer.locator('#__sl-add').click();
    await expect(reviewer.locator('#__sl-pop')).toBeVisible();
    await expect(reviewer.locator('#__sl-pop .__sl-quote')).toContainText('Select this distinctive');

    // The 1242 repro: while the composer is open, the live selection moves
    // to entirely different text. The frozen snapshot must not follow it.
    await reviewer.evaluate(() => {
      const el = document.querySelector('#decoy');
      if (!el || !el.firstChild) throw new Error('no decoy');
      const range = document.createRange();
      range.selectNodeContents(el.firstChild);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });

    await reviewer.locator('#__sl-pop input').fill('Alice E2E');
    await reviewer.locator('#__sl-pop textarea').fill('Please rephrase this sentence');
    await reviewer.locator('#__sl-pop .__sl-btn-primary').click();
    await expect(reviewer.locator('#__sl-pop')).toBeHidden();

    // Owner-side proof: the saved quote is the FROZEN selection, not the decoy.
    const listed = await page.request.get(`/api/v1/presentations/${deckId}/annotations`);
    expect(listed.status()).toBe(200);
    const { annotations } = await listed.json();
    const note = annotations.find(
      (a: { body: string }) => a.body === 'Please rephrase this sentence'
    );
    expect(note).toBeDefined();
    expect(note.authorName).toBe('Alice E2E');
    expect(note.selection).toMatchObject({
      v: 2,
      type: 'text',
      page: 'index.html',
      quote: QUOTE,
      selector: '#p1'
    });
    expect(note.selection.container).toMatchObject({ kind: 'slide', index: 1 });
  });

  await test.step('the saved note renders a numbered pin that jumps and flashes', async () => {
    await expect(reviewer.locator('.__sl-pin')).toHaveCount(1);
    await reviewer.locator('.__sl-pin').click();
    await expect(reviewer.locator('#__sl-sheet')).toHaveClass(/open/);
    await expect(reviewer.locator('.__sl-item')).toHaveCount(1);
    await expect(reviewer.locator('#p1.__sl-anno-flash')).toHaveCount(1);
    await reviewer.locator('#__sl-sheet .__sl-x').click();
  });

  await test.step('annotate mode: a point pin on the image, deck frozen while active', async () => {
    const counterBefore = await reviewer.locator('#counter').textContent();
    await reviewer.locator('#__sl-badge').click();
    await reviewer.locator('#__sl-mode').click(); // enter annotate mode
    await expect(reviewer.locator('#__sl-layer')).toHaveClass(/on/);
    await expect(reviewer.locator('#__sl-banner')).toBeVisible();

    const hero = reviewer.locator('#hero');
    await hero.click({ force: true }); // lands on the capture layer above it
    await expect(reviewer.locator('#__sl-pop')).toBeVisible();
    await expect(reviewer.locator('#__sl-pop .__sl-cap')).toContainText('pin');
    await reviewer.locator('#__sl-pop textarea').fill('Swap this hero image');
    await reviewer.locator('#__sl-pop .__sl-btn-primary').click();
    await expect(reviewer.locator('#__sl-pop')).toBeHidden();

    await reviewer.locator('#__sl-banner .__sl-btn').click(); // Done — exit mode
    await expect(reviewer.locator('#__sl-layer')).not.toHaveClass(/on/);
    // The capture layer swallowed the pin click: the deck never advanced.
    await expect(reviewer.locator('#counter')).toHaveText(counterBefore ?? '1');
    await expect(reviewer.locator('.__sl-pin')).toHaveCount(2);

    const listed = await page.request.get(`/api/v1/presentations/${deckId}/annotations`);
    const { annotations } = await listed.json();
    const pin = annotations.find((a: { body: string }) => a.body === 'Swap this hero image');
    expect(pin.selection).toMatchObject({ v: 2, type: 'point', page: 'index.html', selector: '#hero' });
    expect(pin.selection.point.nx).toBeGreaterThanOrEqual(0);
    expect(pin.selection.point.nx).toBeLessThanOrEqual(1);
  });

  await test.step('the overlay survives navigation to a sub-page (multi-page deck)', async () => {
    await reviewer.goto(`${origin}/v/${secret}/guide/page2.html`);
    await expect(reviewer.locator('#__slideless_annotate')).toHaveCount(1);
    await selectText(reviewer, '#g1');
    await reviewer.locator('#__sl-add').click();
    await reviewer.locator('#__sl-pop textarea').fill('Tighten the guidance wording');
    await reviewer.locator('#__sl-pop .__sl-btn-primary').click();
    await expect(reviewer.locator('#__sl-pop')).toBeHidden();
    await expect(reviewer.locator('.__sl-pin')).toHaveCount(1); // page-scoped pins
  });

  await test.step('cross-page jump-to: a note made on page two resolves from the entry', async () => {
    await reviewer.goto(`${origin}/v/${secret}/`);
    await reviewer.locator('#__sl-badge').click();
    await expect(reviewer.locator('.__sl-item')).toHaveCount(3);
    const remote = reviewer
      .locator('.__sl-item')
      .filter({ hasText: 'Tighten the guidance wording' });
    await expect(remote.locator('.__sl-where')).toContainText('guide/page2.html');
    await remote.click();
    await reviewer.waitForURL(/guide\/page2\.html/);
    // The destination overlay resolves the hash-carried note: flash lands.
    await expect(reviewer.locator('#g1.__sl-anno-flash')).toHaveCount(1, { timeout: 5_000 });
  });

  await test.step('owner resolves a note; the reviewer sees it move to Done', async () => {
    const listed = await page.request.get(`/api/v1/presentations/${deckId}/annotations`);
    const { annotations } = await listed.json();
    const note = annotations.find(
      (a: { body: string }) => a.body === 'Please rephrase this sentence'
    );
    const patch = await page.request.patch(
      `/api/v1/presentations/${deckId}/annotations/${note.id}`,
      { data: { status: 'resolved' } }
    );
    expect(patch.status()).toBe(200);

    await reviewer.goto(`${origin}/v/${secret}/`);
    await reviewer.locator('#__sl-badge').click();
    await expect(reviewer.locator('#__sl-tabs .__sl-tab').nth(1)).toContainText('(1)');
    await reviewer.locator('#__sl-tabs .__sl-tab').nth(1).click();
    await expect(
      reviewer.locator('.__sl-item').filter({ hasText: 'Please rephrase this sentence' })
    ).toBeVisible();
    await expect(reviewer.locator('.__sl-item .__sl-meta').first()).toContainText('resolved');
  });

  await test.step('agent paths stay byte-exact: ?raw carries no overlay', async () => {
    const raw = await reviewer.request.get(`${origin}/v/${secret}?raw`, {
      headers: { accept: 'text/html' }
    });
    expect(raw.status()).toBe(200);
    expect(await raw.text()).not.toContain('data-slideless-annotate');
  });

  await test.step('clean up: delete the deck', async () => {
    await reviewer.context().close();
    const del = await page.request.delete(`/api/v1/presentations/${deckId}`);
    expect(del.status()).toBe(200);
  });
});
