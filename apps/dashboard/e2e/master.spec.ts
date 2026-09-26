import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import { deckMasterPath, VIEWER_IFRAME_SANDBOX } from '@slideless/contract';
import { signInAsOwner } from './accounts';

/**
 * The deck's master page (PRDCT-2279), against the same stack the smoke
 * project set up (this project `dependencies: ['smoke']`, so the owner
 * exists). Opened through the contract's `deckMasterPath` — the same
 * builder the CLI uses after a push — so the route and the constant are
 * proven to agree.
 *
 * The deck is seeded through the API on the owner's session cookie: three
 * versions with a `downloads/` folder (v1 three files, v2 the HTML only,
 * v3 one file replaced and one added), the shape the version history
 * must read back file by file. Then, from the bar: rename, the version
 * history with each version's files, the shown version's files, a share
 * link created and copied, a duplicate that lands on its own page, delete.
 *
 * PRDCT-2308 (the second pass): hovering [[Version history]] opens the
 * versions beside the menu, each with a still thumbnail (the image the
 * server captured at the push, PRDCT-2725, no deck HTML), its files, its views and downloads; the version badge on the right opens
 * the same list on hover and a pick shows that version; [[Show]] in the
 * sheet closes it by itself; the links table copies and opens a link made
 * in this session and shows one check column per capability; the create
 * form's [[Show the bar]] switch, off, yields a bare link (PRDCT-2299).
 */

const TITLE = 'Quarterly review <b>not-bold</b>';
const RENAMED = 'Quarterly review 2026';
const HTML_V1 = '<!doctype html><html><body><h1>Quarterly review v1</h1></body></html>';
const HTML_V2 = '<!doctype html><html><body><h1>Quarterly review v2</h1></body></html>';
const HTML_V3 = '<!doctype html><html><body><h1>Quarterly review v3</h1></body></html>';
const FIGURES = 'quarter,revenue\nQ3,42\n';
const ANNEX_V1 = '%PDF-1.4 annex v1';
const ANNEX_V3 = '%PDF-1.4 annex v3 (replaced)';
const SOURCES = 'PK sources';
const NOTES = '# notes\n';

const shaOf = (text: string) => createHash('sha256').update(Buffer.from(text)).digest('hex');
const entryOf = (path: string, text: string, contentType: string) => ({
  path,
  sha256: shaOf(text),
  sizeBytes: Buffer.byteLength(text),
  contentType
});

const MANIFEST_V1 = [
  entryOf('index.html', HTML_V1, 'text/html'),
  entryOf('downloads/figures.csv', FIGURES, 'text/csv'),
  entryOf('downloads/annex.pdf', ANNEX_V1, 'application/pdf'),
  entryOf('downloads/sources.zip', SOURCES, 'application/zip')
];
const MANIFEST_V2 = [
  entryOf('index.html', HTML_V2, 'text/html'),
  entryOf('downloads/figures.csv', FIGURES, 'text/csv'),
  entryOf('downloads/annex.pdf', ANNEX_V1, 'application/pdf'),
  entryOf('downloads/sources.zip', SOURCES, 'application/zip')
];
const MANIFEST_V3 = [
  entryOf('index.html', HTML_V3, 'text/html'),
  entryOf('downloads/figures.csv', FIGURES, 'text/csv'),
  entryOf('downloads/annex.pdf', ANNEX_V3, 'application/pdf'),
  entryOf('downloads/sources.zip', SOURCES, 'application/zip'),
  entryOf('downloads/notes.md', NOTES, 'text/markdown')
];

async function uploadAsset(page: Page, text: string, mimeType: string): Promise<void> {
  const res = await page.request.post('/api/v1/presentations/assets', {
    multipart: { sha256: shaOf(text), file: { name: shaOf(text), mimeType, buffer: Buffer.from(text) } }
  });
  expect(res.status()).toBe(201);
}

async function seedDeck(page: Page): Promise<string> {
  for (const [text, type] of [
    [HTML_V1, 'text/html'],
    [HTML_V2, 'text/html'],
    [HTML_V3, 'text/html'],
    [FIGURES, 'text/csv'],
    [ANNEX_V1, 'application/pdf'],
    [ANNEX_V3, 'application/pdf'],
    [SOURCES, 'application/zip'],
    [NOTES, 'text/markdown']
  ] as const) {
    await uploadAsset(page, text, type);
  }
  const reserve = await page.request.post('/api/v1/presentations/uploads');
  expect(reserve.status()).toBe(201);
  const { uploadSession } = await reserve.json();
  const commit = await page.request.post(`/api/v1/presentations/uploads/${uploadSession.id}/commit`, {
    data: {
      title: TITLE,
      kind: 'presentation',
      interactive: false,
      entryPath: 'index.html',
      manifest: MANIFEST_V1
    }
  });
  expect(commit.status()).toBe(201);
  const deckId = (await commit.json()).presentation.id as string;
  for (const [base, manifest] of [
    [1, MANIFEST_V2],
    [2, MANIFEST_V3]
  ] as const) {
    const res = await page.request.post(`/api/v1/presentations/${deckId}/versions`, {
      data: { expectedBaseVersion: base, entryPath: 'index.html', manifest }
    });
    expect(res.status()).toBe(201);
  }
  return deckId;
}

/** Open the title menu of the bar. */
async function openTitleMenu(page: Page): Promise<void> {
  await page.getByTestId('master-title').click();
  await expect(page.getByRole('menu')).toBeVisible();
}

test('master page: full-page deck under the bar — rename, version history with files, downloads, share, duplicate, delete', async ({
  page,
  browser
}) => {
  // Copy-to-clipboard is part of the share flow; the browser must allow it.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);

  await test.step('sign in as the owner', async () => {
    await signInAsOwner(page);
  });

  let deckId = '';
  await test.step('seed a three-version deck with a downloads/ folder via the API', async () => {
    deckId = await seedDeck(page);
  });

  await test.step('the master URL (the path the CLI opens) shows the deck full-page under the bar, no sidebar', async () => {
    await page.goto(deckMasterPath(deckId));
    const bar = page.getByTestId('master-bar');
    await expect(bar).toBeVisible();
    // The literal "<b>" text is visible in the title — escaped, never an element.
    await expect(page.getByTestId('master-title')).toContainText(TITLE);
    expect(await bar.locator('b').count()).toBe(0);
    // No dashboard chrome: the sidebar's navigation is absent.
    expect(await page.getByRole('link', { name: 'Decks', exact: true }).count()).toBe(0);
    await expect(page.getByTestId('master-version')).toHaveText('v3');
    await expect(page.getByTestId('master-views')).toContainText('0');

    const iframe = page.getByTestId('deck-preview');
    await expect(iframe).toBeVisible({ timeout: 15_000 });
    expect(await iframe.getAttribute('sandbox')).toBe(VIEWER_IFRAME_SANDBOX); // ADR 012 Surface D
    expect(await iframe.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(await iframe.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(await iframe.getAttribute('src')).toMatch(/\/v\/[A-Za-z0-9_-]{20,}/);
  });

  await test.step('the shown version’s files are one menu: the whole set as a zip, and each file', async () => {
    const downloads = page.getByTestId('master-downloads');
    await expect(downloads).toBeVisible();
    await expect(downloads).toContainText('4');
    await downloads.click();
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitem', { name: 'All files (zip)' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'notes.md' })).toBeVisible();
    // No entry is a plain anchor (PRDCT-2426): an anchor cannot carry the
    // active workspace, so each one fetches through the API client and saves.
    expect(await menu.locator('a[href]').count()).toBe(0);
    const [saved] = await Promise.all([
      page.waitForEvent('download'),
      menu.getByRole('menuitem', { name: 'All files (zip)' }).click()
    ]);
    // The server's own name for the archive: <deck-title-slug>-v<n>.zip.
    expect(saved.suggestedFilename()).toMatch(/-v3\.zip$/);
    const zip = await page.request.get(`/api/v1/presentations/${deckId}/versions/3/downloads.zip`);
    expect(zip.status()).toBe(200);
    expect(zip.headers()['content-type']).toBe('application/zip');
    expect(zip.headers()['content-disposition']).toContain('attachment');
  });

  await test.step('rename from the bar', async () => {
    await openTitleMenu(page);
    await expect(page.getByRole('menu')).toContainText('Artifact by You');
    await page.getByRole('menuitem', { name: 'Rename' }).click();
    const field = page.getByRole('textbox', { name: 'Deck title' });
    await expect(field).toBeVisible();
    await field.fill(RENAMED);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByTestId('master-title')).toContainText(RENAMED);
    const fresh = await page.request.get(`/api/v1/presentations/${deckId}`);
    expect((await fresh.json()).title).toBe(RENAMED);
  });

  await test.step('hovering Version history opens the versions beside the menu, newest first, each with a still thumbnail and its counts', async () => {
    await openTitleMenu(page);
    await page.getByTestId('master-history-trigger').hover();
    const popover = page.getByTestId('master-history-popover');
    await expect(popover).toBeVisible();
    const picks = popover.getByTestId('version-pick');
    await expect(picks).toHaveCount(3);
    await expect(picks.nth(0)).toHaveAttribute('data-version', '3');
    await expect(picks.nth(2)).toHaveAttribute('data-version', '1');
    await expect(picks.nth(0)).toContainText('Current');
    await expect(picks.nth(0)).toContainText('Showing');
    await expect(picks.nth(0)).toContainText('5 files');
    await expect(picks.nth(0)).toContainText('0 views');
    await expect(picks.nth(0)).toContainText('0 downloads');
    // The list has a max height and scrolls: it never grows with the history.
    const overflow = await popover
      .getByTestId('version-list')
      .evaluate((el) => getComputedStyle(el).overflowY);
    expect(overflow).toBe('auto');
    // Each thumbnail is the still image the server captured for that version
    // (PRDCT-2725): an <img> on a blob: URL, never a frame of the deck, taking
    // no pointer events. The capture runs after the push, so the wait covers
    // the loader's retries.
    const box = popover.locator('[data-testid="version-thumb"][data-version="1"]');
    await expect(box).toHaveAttribute('data-loaded', '', { timeout: 30_000 });
    await expect(box.locator('iframe')).toHaveCount(0);
    const thumb = box.locator('img');
    await expect(thumb).toHaveCount(1);
    expect(await thumb.getAttribute('src')).toMatch(/^blob:/);
    expect(await thumb.evaluate((el) => el.naturalWidth)).toBeGreaterThan(0);
    expect(await thumb.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none');
    // The popover carries the product's one motion.
    const motion = await popover.evaluate((el) => ({
      duration: getComputedStyle(el).animationDuration,
      easing: getComputedStyle(el).animationTimingFunction
    }));
    expect(motion).toEqual({ duration: '0.16s', easing: 'cubic-bezier(0.2, 0, 0, 1)' });
    await page.keyboard.press('Escape');
    await expect(popover).toBeHidden();
    await page.keyboard.press('Escape');
  });

  await test.step('hovering the version badge opens the same list; picking v2 shows it and closes the popover', async () => {
    const srcBefore = await page.getByTestId('deck-preview').getAttribute('src');
    await page.getByTestId('master-version').hover();
    const popover = page.getByTestId('master-version-popover');
    await expect(popover).toBeVisible();
    await expect(popover.getByTestId('version-pick')).toHaveCount(3);
    await popover.locator('[data-testid="version-pick"][data-version="2"]').click();
    await expect(popover).toBeHidden();
    await expect(page.getByTestId('master-version')).toHaveText('v2');
    await expect(page.getByTestId('master-downloads')).toContainText('3');
    const iframe = page.getByTestId('deck-preview');
    await expect(iframe).toBeVisible();
    expect(await iframe.getAttribute('src')).not.toBe(srcBefore);
    expect(await iframe.getAttribute('sandbox')).toBe(VIEWER_IFRAME_SANDBOX);
  });

  await test.step('the version history lists each version with its own files and a thumbnail; Show on v1 re-targets the frame and closes the sheet by itself', async () => {
    const srcBefore = await page.getByTestId('deck-preview').getAttribute('src');
    await openTitleMenu(page);
    await page.getByTestId('master-history-trigger').hover();
    await page.getByTestId('master-history-full').click();
    const sheet = page.getByTestId('version-history');
    await expect(sheet).toBeVisible();
    const rows = sheet.getByTestId('version-row');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0).getByTestId('version-thumb')).toHaveAttribute('data-loaded', '', {
      timeout: 30_000
    });
    await expect(rows.nth(0).locator('[data-testid="version-thumb"] img')).toHaveCount(1);
    await expect(rows.nth(0).locator('[data-testid="version-thumb"] iframe')).toHaveCount(0);

    const v3 = sheet.locator('[data-testid="version-row"][data-version="3"]');
    await expect(v3).toContainText('Current');
    await expect(v3).toContainText('0 views');
    const v2 = sheet.locator('[data-testid="version-row"][data-version="2"]');
    await expect(v2).toContainText('Showing');
    await expect(v3.getByRole('button', { name: 'notes.md' })).toBeVisible();
    await expect(v3.getByRole('button', { name: 'annex.pdf' })).toBeVisible();
    await expect(v3.getByTestId('version-files-zip')).toHaveCount(1);
    await expect(v3.getByTestId('version-file')).toHaveCount(4);

    const v1 = sheet.locator('[data-testid="version-row"][data-version="1"]');
    await expect(v1.getByRole('button', { name: 'figures.csv' })).toBeVisible();
    expect(await v1.getByRole('button', { name: 'notes.md' }).count()).toBe(0);
    await expect(v1.getByTestId('version-files-zip')).toHaveCount(1);
    await expect(v1.getByTestId('version-file')).toHaveCount(3);
    // A version's file is THAT version's bytes: v1's annex, not the current one.
    const [annex] = await Promise.all([
      page.waitForEvent('download'),
      v1.getByRole('button', { name: 'annex.pdf' }).click()
    ]);
    expect(annex.suggestedFilename()).toBe('annex.pdf');
    expect(await readFile(await annex.path(), 'utf8')).toBe(ANNEX_V1);

    await v1.getByRole('button', { name: 'Show' }).click();
    // No Escape: the sheet leaves on its own once a version is shown.
    await expect(sheet).toBeHidden();
    await expect(page.getByTestId('master-version')).toHaveText('v1');
    await expect(page.getByTestId('master-downloads')).toContainText('3');
    const iframe = page.getByTestId('deck-preview');
    await expect(iframe).toBeVisible();
    expect(await iframe.getAttribute('src')).not.toBe(srcBefore);
    expect(await iframe.getAttribute('sandbox')).toBe(VIEWER_IFRAME_SANDBOX);
  });

  await test.step("the thumbnails mint no token; leaving the page revokes the frame's (an in-app navigation)", async () => {
    // The still thumbnails are images (PRDCT-2725): the only live preview
    // token is the big frame's, and it is revoked on the way out.
    const livePreviews = async () =>
      (await (await page.request.get(`/api/v1/presentations/${deckId}/tokens`)).json()).shareTokens.filter(
        (t: { purpose: string; revokedAt: string | null }) => t.purpose === 'preview' && !t.revokedAt
      ).length;
    await expect.poll(livePreviews).toBe(1);
    const minted = await livePreviews();
    const revoked: string[] = [];
    page.on('request', (req) => {
      if (req.method() === 'DELETE' && /\/tokens\/[^/]+$/.test(req.url())) revoked.push(req.url());
    });
    await page.getByRole('link', { name: 'Open in dashboard' }).click();
    await expect(page).toHaveURL(new RegExp(`/decks/${deckId}$`));
    await expect.poll(() => revoked.length).toBeGreaterThanOrEqual(minted);
    // At most the admin page's own frame token stays live.
    await expect.poll(livePreviews).toBeLessThanOrEqual(1);
    await page.goto(deckMasterPath(deckId));
    await expect(page.getByTestId('master-bar')).toBeVisible();
  });

  let viewerUrl = '';
  await test.step('share: a link is made from the bar, its URL copied once, the row listed', async () => {
    await openTitleMenu(page);
    await page.getByRole('menuitem', { name: 'Share' }).click();
    const sheet = page.getByTestId('share-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText('No share links yet.');
    await sheet.getByRole('button', { name: 'New share link' }).click();

    const dialog = page.getByRole('dialog').filter({ hasText: 'Create a share link' });
    await dialog.getByRole('textbox', { name: 'Recipient' }).fill('board-alice');
    // Downloads default ON — the switch is there, checked.
    await expect(dialog.getByRole('checkbox', { name: /Allow downloads/ })).toBeChecked();
    await dialog.getByRole('button', { name: 'Create link' }).click();

    const created = page.getByRole('dialog').filter({ hasText: 'Share link created' });
    viewerUrl = await created.getByRole('textbox', { name: 'Viewer URL' }).inputValue();
    expect(viewerUrl).toMatch(/\/v\/[A-Za-z0-9_-]{64}\/$/);
    await created.getByRole('button', { name: 'Copy viewer URL' }).click();
    await expect(page.getByText('Viewer URL copied to clipboard')).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(viewerUrl);
    await created.getByRole('button', { name: 'Done' }).click();

    const aliceRow = sheet.getByRole('row').filter({ hasText: 'board-alice' });
    await expect(aliceRow).toBeVisible();

    // The rebuilt table (PRDCT-2308): the recipient first, the version as a
    // tag, one check per capability, and the row's copy and open actions —
    // live for a link made in this page session, with the exact URL.
    await expect(aliceRow.getByTestId('link-version')).toHaveText('latest');
    await expect(aliceRow.getByTestId('link-version')).toHaveAttribute('data-mode', 'latest');
    for (const key of ['downloads', 'bar', 'forms']) {
      await expect(aliceRow.locator(`[data-capability="${key}"]`)).toHaveAttribute('data-on', '');
    }
    await expect(aliceRow.locator('[data-capability="notes"]')).not.toHaveAttribute('data-on', '');
    await aliceRow.getByTestId('link-copy').click();
    // The create dialog's own toast may still be on screen: the last one is the row's.
    await expect(page.getByText('Viewer URL copied to clipboard').last()).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(viewerUrl);
    expect(await aliceRow.getByTestId('link-open').getAttribute('href')).toBe(viewerUrl);
    expect(await aliceRow.getByTestId('link-open').getAttribute('target')).toBe('_blank');
    expect(await aliceRow.getByTestId('link-open').getAttribute('rel')).toContain('noopener');
    const headers = await sheet.getByRole('columnheader').allTextContents();
    expect(headers[0]).toContain('Recipient');
    // The first column is never cut (the wave's own defect, found hands-on
    // on this lane: the one column without a width in a fixed table got the
    // leftover, which was 4px). Every column carries a width; the recipient
    // gets a real one.
    const firstColumn = await sheet
      .getByRole('columnheader')
      .first()
      .evaluate((el) => el.getBoundingClientRect().width);
    expect(firstColumn).toBeGreaterThanOrEqual(160);
    await expect(aliceRow.getByTestId('link-name')).toHaveAttribute('title', 'board-alice');
    expect(headers.map((h) => h.trim())).toEqual(
      expect.arrayContaining(['Version', 'Downloads', 'Bar', 'Notes', 'Forms', 'Views', 'Status'])
    );

    // A second link with downloads switched OFF: the switch must reach the
    // server (verifier round 1, gap M9), and the row says so.
    await sheet.getByRole('button', { name: 'New share link' }).click();
    const second = page.getByRole('dialog').filter({ hasText: 'Create a share link' });
    await second.getByRole('textbox', { name: 'Recipient' }).fill('board-bob-no-files');
    await second.getByRole('checkbox', { name: /Allow downloads/ }).uncheck();
    await second.getByRole('button', { name: 'Create link' }).click();
    const createdSecond = page.getByRole('dialog').filter({ hasText: 'Share link created' });
    await createdSecond.getByRole('button', { name: 'Done' }).click();
    const bobRow = sheet.getByRole('row').filter({ hasText: 'board-bob-no-files' });
    await expect(bobRow).toBeVisible();
    await expect(bobRow.locator('[data-capability="downloads"]')).not.toHaveAttribute('data-on', '');
    await expect(bobRow.locator('[data-capability="bar"]')).toHaveAttribute('data-on', '');
    const tokens = await (await page.request.get(`/api/v1/presentations/${deckId}/tokens`)).json();
    const bob = tokens.shareTokens.find((t: { name: string }) => t.name === 'board-bob-no-files');
    expect(bob.canDownload).toBe(false);
    const alice = tokens.shareTokens.find((t: { name: string }) => t.name === 'board-alice');
    expect(alice.canDownload).toBe(true);

    // A third link with the BAR switched off (PRDCT-2299): the switch is
    // there, on by default; off, the link's page is a bare deck.
    await sheet.getByRole('button', { name: 'New share link' }).click();
    const third = page.getByRole('dialog').filter({ hasText: 'Create a share link' });
    await third.getByRole('textbox', { name: 'Recipient' }).fill('board-carol-bare');
    await expect(third.getByRole('checkbox', { name: /Show the bar/ })).toBeChecked();
    await third.getByRole('checkbox', { name: /Show the bar/ }).uncheck();
    await third.getByRole('button', { name: 'Create link' }).click();
    const createdThird = page.getByRole('dialog').filter({ hasText: 'Share link created' });
    const bareUrl = await createdThird.getByRole('textbox', { name: 'Viewer URL' }).inputValue();
    await createdThird.getByRole('button', { name: 'Done' }).click();
    const carolRow = sheet.getByRole('row').filter({ hasText: 'board-carol-bare' });
    await expect(carolRow.locator('[data-capability="bar"]')).not.toHaveAttribute('data-on', '');
    const carol = (
      await (await page.request.get(`/api/v1/presentations/${deckId}/tokens`)).json()
    ).shareTokens.find((t: { name: string }) => t.name === 'board-carol-bare');
    expect(carol.showBar).toBe(false);
    const bare = await page.request.get(bareUrl, { headers: { 'sec-fetch-dest': 'document' } });
    expect(bare.status()).toBe(200);
    expect(await bare.text()).not.toContain('data-slideless-topbar');
    const withBar = await page.request.get(viewerUrl, { headers: { 'sec-fetch-dest': 'document' } });
    expect(await withBar.text()).toContain('data-slideless-topbar');

    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();

    // The link follows the latest version and serves the deck to an anonymous
    // browser GET (a caller that does not ask for HTML gets the index, PRDCT-2670).
    const served = await page.request.get(viewerUrl, { headers: { accept: 'text/html' } });
    expect(served.status()).toBe(200);
    expect(await served.text()).toContain('Quarterly review v3');
  });

  let copyId = '';
  await test.step('duplicate lands on the copy’s own page; the copy points at the original', async () => {
    await openTitleMenu(page);
    await page.getByRole('menuitem', { name: 'Duplicate' }).click();
    await expect(page).toHaveURL(/\/decks\/[0-9a-f-]{36}\/present$/, { timeout: 15_000 });
    await expect(page).not.toHaveURL(deckMasterPath(deckId));
    copyId = page.url().match(/\/decks\/([0-9a-f-]{36})\/present$/)![1]!;
    await expect(page.getByTestId('master-title')).toContainText(`${RENAMED} (copy)`);
    await expect(page.getByTestId('master-version')).toHaveText('v1');
    const copy = await (await page.request.get(`/api/v1/presentations/${copyId}`)).json();
    expect(copy.remixedFrom).toBe(deckId);
    expect(copy.hasDownloads).toBe(true);
    // The copy is made from the deck's CURRENT version (v3, four files),
    // whatever version the frame happened to show when Duplicate was clicked.
    await expect(page.getByTestId('master-downloads')).toContainText('4');
  });

  await test.step('delete the copy from its bar; the decks list is where it lands', async () => {
    await openTitleMenu(page);
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    const confirm = page.getByRole('dialog').filter({ hasText: 'Delete this deck?' });
    await confirm.getByRole('button', { name: 'Delete' }).click();
    await expect(page).toHaveURL(/\/decks$/);
    await expect(page.getByRole('heading', { name: 'Decks', exact: true })).toBeVisible();
    expect((await page.request.get(`/api/v1/presentations/${copyId}`)).status()).toBe(404);
  });

  await test.step('signed out, the master URL bounces to the login with the deep link kept', async () => {
    // The new route group carries the app shell's guard (verifier round 1,
    // gap M16): no session, no page — the login, with `next` pointing back.
    const context = await browser.newContext();
    const visitor = await context.newPage();
    await visitor.goto(deckMasterPath(deckId));
    await expect(visitor).toHaveURL(/\/login\?next=/);
    expect(decodeURIComponent(new URL(visitor.url()).searchParams.get('next') ?? '')).toBe(
      deckMasterPath(deckId)
    );
    await expect(visitor.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    await context.close();
  });

  await test.step('clean up: delete the original via the API', async () => {
    const del = await page.request.delete(`/api/v1/presentations/${deckId}`);
    expect(del.status()).toBe(200);
  });
});
