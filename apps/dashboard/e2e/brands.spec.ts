import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test, expect, type Download, type Page } from '@playwright/test';
import { signInAsOwner } from './accounts';

/**
 * PRDCT-2421 — the Brands section, end to end against the real stack
 * (`dependencies: ['smoke']`, so the owner exists).
 *
 * There is no upload UI, so the brand is seeded through the API on the
 * owner's session cookie (page.request shares the context's cookies), the
 * way decks.spec.ts seeds its deck: three manifest entries, one of them the
 * reserved root `AGENT.md` whose frontmatter names `type: Brand`. That one
 * line is what makes the deck a reference.
 *
 * What the spec proves, in the owner's browser and then in a plain member's:
 * the card and its side sheet render the frontmatter (colours, fonts,
 * voice), the files of the version download the bytes that were pushed, the
 * audience switch publishes to the workspace, the default is set and shown
 * as a crown, the server's 409 on making a default private comes back as a
 * SENTENCE (never a silently flipped switch), the overview's brand card
 * names it — and a plain member reads the published brand and its files
 * while getting neither the switch nor the default button.
 *
 * The title carries HTML on purpose (decks.spec.ts's assertion): the literal
 * text must be visible and no `<b>` element may exist in `main`.
 */

const BRAND_TITLE = 'E2E Brand <b>not-bold</b>';
const READER = {
  firstName: 'Reader',
  lastName: 'One',
  name: 'Reader One',
  email: 'reader@example.com',
  password: 'reader-password-123'
};

const INDEX_HTML =
  '<!doctype html><html><body><h1>E2E brand cover</h1><p>Harbour and Signal.</p></body></html>';
const LOGO_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" fill="#0B3954"/></svg>';
// The frontmatter MUST open the file: the classifier reads the first bytes.
const AGENT_MD = [
  '---',
  'type: Brand',
  'title: E2E brand',
  'description: The look of every E2E deck.',
  // tags in a shape the sheet cannot read as words: it must come back as a row, never be dropped
  'tags: 12',
  'timestamp: 2026-09-19T05:00:00Z',
  'fonts:',
  '  heading: { family: Fraunces, weights: [600] }',
  '  body: { family: Inter, weights: [400] }',
  'colors:',
  "  - { name: Harbour, hex: '#0B3954', role: primary }",
  "  - { name: Signal, hex: '#FF6B35', role: accent }",
  'voice:',
  '  tone: plain, direct',
  '  avoid: [synergy]',
  '---',
  '',
  '# E2E brand',
  'Read this before writing a deck.',
  ''
].join('\n');

const shaOf = (text: string) => createHash('sha256').update(Buffer.from(text)).digest('hex');
const entryOf = (path: string, text: string, contentType: string) => ({
  path,
  sha256: shaOf(text),
  sizeBytes: Buffer.byteLength(text),
  contentType
});

async function uploadAsset(page: Page, text: string, mimeType: string): Promise<void> {
  const res = await page.request.post('/api/v1/presentations/assets', {
    multipart: {
      sha256: shaOf(text),
      file: { name: shaOf(text), mimeType, buffer: Buffer.from(text) }
    }
  });
  expect(res.status()).toBe(201);
}

/** Click, and hand back the download the click started. */
async function downloadFrom(page: Page, click: () => Promise<void>): Promise<Download> {
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 20_000 }), click()]);
  return download;
}

async function bytesOf(download: Download): Promise<string> {
  const path = await download.path();
  return (await readFile(path)).toString('utf8');
}

/**
 * Sign in as the reader through the login page — the shape of
 * `signInAsOwner`, throttle wait included (the projects run back to back on
 * one worker, so the sign-in throttle can answer here).
 */
async function signInAsReader(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(READER.email);
  await page.getByLabel('Password').fill(READER.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const throttled = await page
    .getByText('Too many attempts')
    .waitFor({ state: 'visible', timeout: 3_000 })
    .then(() => true)
    .catch(() => false);
  if (throttled) {
    await page.waitForTimeout(12_000);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  }
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible({ timeout: 20_000 });
}

test('brands: a pushed reference is read, downloaded, published, made the default — and a member reads it', async ({
  page,
  browser
}) => {
  await test.step('sign in as the owner', async () => {
    await signInAsOwner(page);
  });

  let deckId = '';
  await test.step('seed a brand via the API: AGENT.md frontmatter naming type: Brand', async () => {
    const reserve = await page.request.post('/api/v1/presentations/uploads');
    expect(reserve.status()).toBe(201);
    const { uploadSession } = await reserve.json();

    await uploadAsset(page, INDEX_HTML, 'text/html');
    await uploadAsset(page, AGENT_MD, 'text/markdown');
    await uploadAsset(page, LOGO_SVG, 'image/svg+xml');

    const commit = await page.request.post(`/api/v1/presentations/uploads/${uploadSession.id}/commit`, {
      data: {
        title: BRAND_TITLE,
        kind: 'presentation',
        interactive: false,
        entryPath: 'index.html',
        manifest: [
          entryOf('index.html', INDEX_HTML, 'text/html'),
          entryOf('AGENT.md', AGENT_MD, 'text/markdown'),
          entryOf('assets/logo.svg', LOGO_SVG, 'image/svg+xml')
        ]
      }
    });
    expect(commit.status()).toBe(201);
    const { presentation } = await commit.json();
    deckId = presentation.id;
    // The one line that makes it a reference, read back from the server.
    expect(presentation.reference?.type).toBe('brand');
    expect(presentation.audience).toBe('private');
    expect(presentation.defaultReference).toBe(false);
  });

  await test.step('Brands lists the brand as a card, with its title ESCAPED', async () => {
    // the menu's Library entry opens on its first tab, Brands (PRDCT-2583)
    await page.getByRole('link', { name: 'Library', exact: true }).click();
    await expect(page).toHaveURL(/\/brands$/);
    await expect(page.getByRole('heading', { name: 'Brands' })).toBeVisible();

    const card = page.getByTestId('reference-card');
    await expect(card).toHaveCount(1);
    // The literal "<b>" text is visible — meaning it was escaped…
    await expect(card.getByRole('heading', { name: BRAND_TITLE })).toBeVisible();
    // …and no <b> element was created from it anywhere on the page.
    expect(await page.locator('main b').count()).toBe(0);
    await expect(card).toContainText('Private');
    await expect(card).toContainText('The look of every E2E deck.');
    // The colours of the frontmatter, as the card's strip.
    expect(await card.locator('.swatches span').count()).toBe(2);
  });

  await test.step('the sheet opens on the card with the frontmatter rendered', async () => {
    await page.getByTestId('reference-card').click();
    const sheet = page.getByTestId('reference-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('heading', { name: BRAND_TITLE })).toBeVisible();
    await expect(sheet).toContainText('The look of every E2E deck.');

    const colours = sheet.getByTestId('reference-colours');
    await expect(colours).toContainText('Harbour');
    await expect(colours).toContainText('#0B3954');
    await expect(colours).toContainText('Signal');
    await expect(sheet.getByTestId('reference-fonts')).toContainText('Fraunces');
    // a typed field in an unusable shape (tags: 12) is kept as a row under
    // "Also in the frontmatter" rather than dropped (verifier round 2, G3)
    const extras = sheet.getByTestId('reference-extras');
    await expect(extras).toContainText('tags');
    await expect(extras).toContainText('12');
    const voice = sheet.getByTestId('reference-voice');
    await expect(voice).toContainText('plain');
    await expect(voice).toContainText('synergy');
  });

  await test.step('the files of the version list assets/ first, and logo.svg downloads its bytes', async () => {
    const files = page.getByTestId('reference-files');
    await expect(files).toBeVisible();
    const names = files.getByTestId('reference-file');
    await expect(names).toHaveCount(3);
    // assets/ is the first group: the logo, then the root files by path.
    expect(await names.evaluateAll((els) => els.map((el) => el.getAttribute('data-path')))).toEqual([
      'assets/logo.svg',
      'AGENT.md',
      'index.html'
    ]);
    // PRDCT-2426: every download goes through $lib/download (a button and a
    // fetch that carries the active workspace), never a plain anchor, which
    // cannot carry X-Workspace-Id and answers 404 on a non-default workspace.
    expect(await names.evaluateAll((els) => els.map((el) => el.tagName))).toEqual([
      'BUTTON',
      'BUTTON',
      'BUTTON'
    ]);
    expect(await files.locator('a[download], a[href*="/assets/"]').count()).toBe(0);

    const download = await downloadFrom(page, () =>
      files.getByTestId('reference-file').filter({ hasText: 'logo.svg' }).click()
    );
    expect(download.suggestedFilename()).toBe('logo.svg');
    expect(await bytesOf(download)).toBe(LOGO_SVG);
  });

  await test.step('publishing to the workspace: the switch, the sentence, the tag, the API', async () => {
    const sheet = page.getByTestId('reference-sheet');
    const audienceSwitch = sheet.getByRole('switch', { name: 'Published to the workspace' });
    await expect(audienceSwitch).not.toBeChecked();
    await audienceSwitch.click();

    await expect(audienceSwitch).toBeChecked();
    await expect(sheet.getByTestId('audience-sentence')).toContainText('Every member');
    await expect(sheet).toContainText('Workspace');
    await expect(page.getByTestId('reference-card')).toContainText('Workspace');

    const read = await page.request.get(`/api/v1/presentations/${deckId}`);
    expect(read.status()).toBe(200);
    // GET /presentations/{id} answers the presentation itself, unwrapped.
    expect((await read.json()).audience).toBe('workspace');
  });

  await test.step('the default brand: the crown on the card, the button becomes Clear the default', async () => {
    const sheet = page.getByTestId('reference-sheet');
    await sheet.getByRole('button', { name: 'Set as the workspace’s default brand' }).click();

    const crown = page.getByTestId('reference-default');
    await expect(crown).toBeVisible();
    await expect(crown).toHaveText('Default');
    await expect(sheet.getByRole('button', { name: 'Clear the default' })).toBeVisible();

    const read = await page.request.get(`/api/v1/presentations/${deckId}`);
    expect((await read.json()).defaultReference).toBe(true);
  });

  await test.step('a default cannot go private: the refusal is a sentence, the switch stays on', async () => {
    const sheet = page.getByTestId('reference-sheet');
    const audienceSwitch = sheet.getByRole('switch', { name: 'Published to the workspace' });
    await audienceSwitch.click();

    // 409 default_reference, in words under the control.
    await expect(sheet.getByTestId('reference-refusal')).toContainText('default brand');
    await expect(audienceSwitch).toBeChecked();
    await expect(sheet.getByTestId('audience-sentence')).toContainText('Every member');
  });

  await test.step('the overview names the workspace’s brand', async () => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
    await expect(page.getByTestId('default-brand')).toContainText(BRAND_TITLE, { timeout: 15_000 });
  });

  await test.step('a plain member reads the published brand and its files, and sets nothing', async () => {
    const invite = await page.request.post('/api/v1/invitations', {
      data: { email: READER.email, role: 'member' }
    });
    expect(invite.status()).toBe(201);
    const { acceptUrl } = await invite.json();
    const token = new URL(acceptUrl).pathname.split('/invite/')[1];
    expect(token).toBeTruthy();

    const context = await browser.newContext();
    const reader = await context.newPage();
    // The accept endpoint is public and takes no cookies: this context has none.
    const accepted = await reader.request.post('/api/v1/invitations/accept', {
      data: { token, name: READER.name, password: READER.password }
    });
    expect(accepted.status()).toBe(200);

    await signInAsReader(reader);
    await reader.goto('/brands');
    await expect(reader.getByRole('heading', { name: 'Brands' })).toBeVisible();
    const card = reader.getByTestId('reference-card');
    await expect(card).toHaveCount(1);
    await expect(card.getByRole('heading', { name: BRAND_TITLE })).toBeVisible();

    await card.click();
    const sheet = reader.getByTestId('reference-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId('audience-sentence')).toContainText('Every member');
    // The page hides what the server would refuse: no switch, no default.
    expect(await sheet.getByRole('switch').count()).toBe(0);
    expect(await sheet.getByRole('button', { name: 'Set as the workspace’s default brand' }).count()).toBe(0);

    // The member reads the files of the version, bytes for bytes.
    const files = sheet.getByTestId('reference-files');
    await expect(files.getByTestId('reference-file')).toHaveCount(3);
    const download = await downloadFrom(reader, () =>
      files.getByTestId('reference-file').filter({ hasText: 'logo.svg' }).click()
    );
    expect(download.suggestedFilename()).toBe('logo.svg');
    expect(await bytesOf(download)).toBe(LOGO_SVG);

    await context.close();
  });

  await test.step('clean up: delete the brand; the section shows its empty state again', async () => {
    const del = await page.request.delete(`/api/v1/presentations/${deckId}`);
    expect(del.status()).toBe(200);
    await page.goto('/brands');
    await expect(page.getByRole('heading', { name: 'Brands', exact: true })).toBeVisible();
    await expect(page.getByText('No brands yet')).toBeVisible();
  });
});
