import { createHash } from 'node:crypto';
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
    const zipHref = await menu.getByRole('menuitem', { name: 'All files (zip)' }).getAttribute('href');
    expect(zipHref).toBe(`/api/v1/presentations/${deckId}/versions/3/downloads.zip`);
    await page.keyboard.press('Escape');
    const zip = await page.request.get(zipHref!);
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

  await test.step('the version history lists each version with its own files; showing v1 re-targets the frame', async () => {
    const srcBefore = await page.getByTestId('deck-preview').getAttribute('src');
    await openTitleMenu(page);
    await page.getByRole('menuitem', { name: 'Version history' }).click();
    const sheet = page.getByTestId('version-history');
    await expect(sheet).toBeVisible();
    const rows = sheet.getByTestId('version-row');
    await expect(rows).toHaveCount(3);

    const v3 = sheet.locator('[data-testid="version-row"][data-version="3"]');
    await expect(v3).toContainText('Current');
    await expect(v3).toContainText('Showing');
    await expect(v3.getByRole('link', { name: 'notes.md' })).toBeVisible();
    await expect(v3.getByRole('link', { name: 'annex.pdf' })).toBeVisible();
    expect(await v3.getByRole('link').count()).toBe(5); // zip + 4 files

    const v1 = sheet.locator('[data-testid="version-row"][data-version="1"]');
    await expect(v1.getByRole('link', { name: 'figures.csv' })).toBeVisible();
    expect(await v1.getByRole('link', { name: 'notes.md' }).count()).toBe(0);
    expect(await v1.getByRole('link').count()).toBe(4); // zip + 3 files
    expect(await v1.getByRole('link', { name: 'annex.pdf' }).getAttribute('href')).toBe(
      `/api/v1/presentations/${deckId}/versions/1/downloads/annex.pdf`
    );

    await v1.getByRole('button', { name: 'Show' }).click();
    await expect(v1).toContainText('Showing');
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    await expect(page.getByTestId('master-version')).toHaveText('v1');
    await expect(page.getByTestId('master-downloads')).toContainText('3');
    const iframe = page.getByTestId('deck-preview');
    await expect(iframe).toBeVisible();
    expect(await iframe.getAttribute('src')).not.toBe(srcBefore);
    expect(await iframe.getAttribute('sandbox')).toBe(VIEWER_IFRAME_SANDBOX);
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

    await expect(sheet.getByRole('cell', { name: 'board-alice' })).toBeVisible();

    // A second link with downloads switched OFF: the switch must reach the
    // server (verifier round 1, gap M9), and the row says so.
    await sheet.getByRole('button', { name: 'New share link' }).click();
    const second = page.getByRole('dialog').filter({ hasText: 'Create a share link' });
    await second.getByRole('textbox', { name: 'Recipient' }).fill('board-bob-no-files');
    await second.getByRole('checkbox', { name: /Allow downloads/ }).uncheck();
    await second.getByRole('button', { name: 'Create link' }).click();
    const createdSecond = page.getByRole('dialog').filter({ hasText: 'Share link created' });
    await createdSecond.getByRole('button', { name: 'Done' }).click();
    await expect(sheet.getByRole('cell', { name: 'board-bob-no-files' })).toBeVisible();
    await expect(sheet.getByRole('row').filter({ hasText: 'board-bob-no-files' })).toContainText(
      'Downloads off'
    );
    const tokens = await (await page.request.get(`/api/v1/presentations/${deckId}/tokens`)).json();
    const bob = tokens.shareTokens.find((t: { name: string }) => t.name === 'board-bob-no-files');
    expect(bob.canDownload).toBe(false);
    const alice = tokens.shareTokens.find((t: { name: string }) => t.name === 'board-alice');
    expect(alice.canDownload).toBe(true);

    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();

    // The link follows the latest version and serves the deck to an anonymous GET.
    const served = await page.request.get(viewerUrl);
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
