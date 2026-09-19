import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test, expect, type Download, type Page } from '@playwright/test';
import { deckMasterPath } from '@slideless/contract';
import { INSTANCE_NAME, signInAsOwner } from './accounts';

/**
 * PRDCT-2444 / PRDCT-2443 + PRDCT-2426, in a real browser against the real
 * stack (`dependencies: ['smoke']`, so the owner exists; self-hosted, the
 * operator's cap at its default, so the owner may create).
 *
 *  - Creation closed (`/me.canCreateWorkspace` false, the ONE field the test
 *    rewrites on the wire): a person with one workspace sees the plain
 *    instance-name header, no menu.
 *  - Creation open: the same person gets the menu with their one workspace
 *    and "New workspace". The dialog takes the focus in its field, refuses an
 *    empty name, goes through its three steps, posts once with an
 *    Idempotency-Key, and the person LANDS in the new workspace.
 *  - Downloads follow the active workspace. The new workspace is NOT the
 *    default one, so a plain anchor navigation (no `X-Workspace-Id`) answers
 *    404 for every file below: the signature of PRDCT-2426. Each dashboard
 *    download of that workspace must save the right bytes under the server's
 *    name: a deck attachment and the attachments zip (master bar, version
 *    history), a form response's file, its zip and the deck's zip, a file of
 *    the files page, and the settings export.
 *
 * This project runs LAST (playwright.config.ts): it leaves the owner with a
 * second workspace, which the other projects never have to know about.
 */

const SECOND = 'Second Workspace E2E';

const FORM_HTML = [
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>E2E Workspace Deck</title></head><body>',
  '<h1 id="title">Second workspace deck</h1>',
  '<form data-slideless-form="apply">',
  '  <input id="f-name" name="name" required>',
  '  <input id="f-cv" type="file" name="cv" accept=".pdf">',
  '  <button id="f-send" type="submit">Send</button>',
  '</form>',
  '</body></html>'
].join('\n');
const FIGURES = 'quarter,revenue\nQ1,10\nQ2,14\n';
// A name that needs the RFC 5987 form of Content-Disposition to survive.
const NOTES_NAME = 'résumé notes.md';
const NOTES = '# Notes\nsecond workspace\n';
const CV = Buffer.from('%PDF-1.4 e2e cv of the second workspace');
const LOOSE_FILE = Buffer.from('a loose file of the second workspace\n');

const shaOf = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const entryOf = (path: string, text: string, contentType: string) => ({
  path,
  sha256: shaOf(text),
  sizeBytes: Buffer.byteLength(text),
  contentType
});

/** Click, and hand back the download the click started. */
async function downloadFrom(page: Page, click: () => Promise<void>): Promise<Download> {
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 20_000 }), click()]);
  return download;
}

async function bytesOf(download: Download): Promise<Buffer> {
  const path = await download.path();
  return readFile(path);
}

/** A zip is a zip: the local-file-header magic, and the entry names somewhere inside. */
function expectZipWith(bytes: Buffer, ...names: string[]): void {
  expect(bytes.subarray(0, 4).toString('hex')).toBe('504b0304');
  for (const name of names) expect(bytes.includes(Buffer.from(name))).toBe(true);
}

test('a workspace is created from the sidebar, the person lands in it, and its downloads follow it', async ({
  page,
  browser
}) => {
  await test.step('sign in as the owner', async () => {
    await signInAsOwner(page);
  });

  let firstWorkspace = { id: '', name: '' };
  await test.step('creation closed: one workspace, the plain instance-name header, no menu', async () => {
    const me = await (await page.request.get('/api/v1/me')).json();
    expect(me.workspaces).toHaveLength(1);
    expect(me.canCreateWorkspace).toBe(true);
    firstWorkspace = { id: me.workspaces[0].id, name: me.workspaces[0].name };

    // What an instance with MAX_WORKSPACES_PER_USER=0 answers: the same /me, the flag false.
    await page.route('**/api/v1/me', async (route) => {
      const response = await route.fetch();
      const json = await response.json();
      await route.fulfill({ response, json: { ...json, canCreateWorkspace: false } });
    });
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('workspace-switcher')).toHaveCount(0);
    await expect(
      page.locator('[data-sidebar="sidebar"]').getByText(INSTANCE_NAME, { exact: true })
    ).toBeVisible();
    await page.unroute('**/api/v1/me');
  });

  let secondId = '';
  await test.step('creation open: the menu lists the one workspace, then New workspace', async () => {
    await page.reload();
    const switcher = page.getByTestId('workspace-switcher');
    await expect(switcher).toBeVisible({ timeout: 20_000 });
    await expect(switcher).toContainText(firstWorkspace.name);
    await switcher.click();
    const menu = page.getByRole('menu');
    await expect(menu.getByTestId('workspace-entry')).toHaveCount(1);
    await expect(menu.getByRole('menuitem', { name: 'New workspace' })).toBeVisible();
    await menu.getByRole('menuitem', { name: 'New workspace' }).click();
  });

  await test.step('the dialog: focus in the field, no empty name, three steps, one POST with an Idempotency-Key, the person lands in the new workspace', async () => {
    // The creation is three steps and a door since the settings pass: the
    // dialog is named after its step, so it is found by its first title and
    // followed by role from there.
    await expect(page.getByRole('dialog', { name: 'Name your workspace' })).toBeVisible();
    const dialog = page.getByRole('dialog');
    const field = dialog.getByLabel('Workspace name');
    await expect(field).toBeFocused();
    const next = dialog.getByTestId('workspace-step-next');
    await expect(next).toBeDisabled();
    await field.fill('   ');
    await expect(next).toBeDisabled();
    // The wording is a Slideless workspace, nothing behind it.
    await expect(dialog).not.toContainText(/organi[sz]ation|hub|antasphere/i);

    await field.fill(SECOND);
    const posts: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/workspaces') {
        posts.push(request.headers()['idempotency-key'] ?? '');
      }
    });
    const created = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/v1/workspaces'
    );
    // Enter in the name field is the first Continue; nothing is posted before the third step's submit.
    await field.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Give it a look' })).toBeVisible();
    await dialog.getByTestId('workspace-step-next').click();
    await expect(page.getByRole('dialog', { name: 'Bring people in' })).toBeVisible();
    expect(posts).toHaveLength(0);
    await dialog.getByRole('button', { name: 'Create workspace' }).click();
    expect((await created).status()).toBe(201);
    await expect(page.getByRole('dialog', { name: `${SECOND} is ready` })).toBeVisible();
    await dialog.getByTestId('workspace-open').click();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatch(/^ws-create-[0-9a-f]{32}$/);

    // switchWorkspace persisted the choice and reloaded: the shell is the new
    // workspace's. (The id is read from the list, not from the POST's body:
    // the page that received it is gone by now.)
    const switcher = page.getByTestId('workspace-switcher');
    await expect(switcher).toContainText(SECOND, { timeout: 20_000 });
    const listed = await (await page.request.get('/api/v1/me')).json();
    secondId = listed.workspaces.find((w: { name: string }) => w.name === SECOND).id;
    expect(await page.evaluate(() => localStorage.getItem('platform.workspaceId'))).toBe(secondId);
    await page.goto('/decks');
    await expect(page.getByRole('heading', { name: 'Decks', exact: true })).toBeVisible();
    await expect(page.getByTestId('workspace-switcher')).toContainText(SECOND);

    await page.getByTestId('workspace-switcher').click();
    const entries = page.getByRole('menu').getByTestId('workspace-entry');
    await expect(entries).toHaveCount(2);
    await page.keyboard.press('Escape');

    // It is NOT the default workspace: a request that names none still means the first one.
    const me = await (await page.request.get('/api/v1/me')).json();
    expect(me.workspace.id).toBe(firstWorkspace.id);
    expect(me.workspaces.find((w: { id: string }) => w.id === secondId).default).toBe(false);
  });

  const inSecond = () => ({ 'x-workspace-id': secondId });
  let deckId = '';
  let responseId = '';
  let cvFileId = '';
  let looseFileId = '';

  await test.step('seed the new workspace: a deck with attachments and a form, one response with a file, one loose file', async () => {
    for (const [text, type] of [
      [FORM_HTML, 'text/html'],
      [FIGURES, 'text/csv'],
      [NOTES, 'text/markdown']
    ] as const) {
      const asset = await page.request.post('/api/v1/presentations/assets', {
        headers: inSecond(),
        multipart: {
          sha256: shaOf(text),
          file: { name: shaOf(text), mimeType: type, buffer: Buffer.from(text) }
        }
      });
      expect(asset.status()).toBe(201);
    }
    const reserve = await page.request.post('/api/v1/presentations/uploads', { headers: inSecond() });
    expect(reserve.status()).toBe(201);
    const { uploadSession } = await reserve.json();
    const commit = await page.request.post(`/api/v1/presentations/uploads/${uploadSession.id}/commit`, {
      headers: inSecond(),
      data: {
        title: 'Second workspace deck',
        entryPath: 'index.html',
        manifest: [
          entryOf('index.html', FORM_HTML, 'text/html'),
          entryOf('downloads/figures.csv', FIGURES, 'text/csv'),
          entryOf(`downloads/${NOTES_NAME}`, NOTES, 'text/markdown')
        ]
      }
    });
    expect(commit.status()).toBe(201);
    deckId = (await commit.json()).presentation.id;

    const token = await page.request.post(`/api/v1/presentations/${deckId}/tokens`, {
      headers: inSecond(),
      data: { name: 'e2e-second-workspace', remembersResponses: false }
    });
    expect(token.status()).toBe(201);
    const { secret } = await token.json();

    const origin = new URL(page.url()).origin;
    const respondent = await (await browser.newContext()).newPage();
    await respondent.goto(`${origin}/v/${secret}/`);
    await respondent.locator('#f-name').fill('Ada Lovelace');
    const [chooser] = await Promise.all([
      respondent.waitForEvent('filechooser'),
      respondent.locator('[data-slideless-drop="cv"]').click()
    ]);
    await chooser.setFiles({ name: 'cv.pdf', mimeType: 'application/pdf', buffer: CV });
    await expect(
      respondent.locator('[data-slideless-files="cv"] li[data-slideless-file="done"]')
    ).toHaveCount(1);
    await respondent.locator('#f-send').click();
    await expect(respondent.locator('[data-slideless-dialog="apply"]')).toBeVisible();
    await respondent.context().close();

    const listed = await (
      await page.request.get(`/api/v1/presentations/${deckId}/responses`, { headers: inSecond() })
    ).json();
    expect(listed.responses).toHaveLength(1);
    responseId = listed.responses[0].id;
    cvFileId = listed.responses[0].files[0].id;

    const loose = await page.request.post('/api/v1/files?name=loose-file.txt', {
      headers: { ...inSecond(), 'content-type': 'text/plain' },
      data: LOOSE_FILE
    });
    expect(loose.status()).toBe(201);
    looseFileId = (await loose.json()).file.id;
  });

  await test.step('the bug’s signature: without X-Workspace-Id, what a plain anchor sends, every one of these answers 404', async () => {
    for (const path of [
      `/api/v1/presentations/${deckId}/versions/1/downloads/figures.csv`,
      `/api/v1/presentations/${deckId}/versions/1/downloads.zip`,
      `/api/v1/presentations/${deckId}/responses/${responseId}/files/${cvFileId}`,
      `/api/v1/presentations/${deckId}/responses/${responseId}/files.zip`,
      `/api/v1/presentations/${deckId}/responses/files.zip`,
      `/api/v1/files/${looseFileId}/content`
    ]) {
      expect((await page.request.get(path)).status(), path).toBe(404);
    }
  });

  await test.step('master bar: one attachment and the zip are saved from the active workspace, under the server’s names', async () => {
    await page.goto(deckMasterPath(deckId));
    const downloads = page.getByTestId('master-downloads');
    await expect(downloads).toContainText('2', { timeout: 15_000 });

    await downloads.click();
    const figures = await downloadFrom(page, () =>
      page.getByRole('menu').getByRole('menuitem', { name: 'figures.csv' }).click()
    );
    expect(figures.suggestedFilename()).toBe('figures.csv');
    expect((await bytesOf(figures)).toString()).toBe(FIGURES);

    await downloads.click();
    const notes = await downloadFrom(page, () =>
      page.getByRole('menu').getByRole('menuitem', { name: NOTES_NAME }).click()
    );
    // The accented name comes from filename*=UTF-8''…, not from the ascii fallback.
    expect(notes.suggestedFilename()).toBe(NOTES_NAME);
    expect((await bytesOf(notes)).toString()).toBe(NOTES);

    await downloads.click();
    const zip = await downloadFrom(page, () =>
      page.getByRole('menu').getByRole('menuitem', { name: 'All files (zip)' }).click()
    );
    expect(zip.suggestedFilename()).toMatch(/-v1\.zip$/);
    expectZipWith(await bytesOf(zip), 'figures.csv');
  });

  await test.step('version history: the same files, from the sheet', async () => {
    await page.getByTestId('master-title').click();
    await page.getByTestId('master-history-trigger').hover();
    await page.getByTestId('master-history-full').click();
    const sheet = page.getByTestId('version-history');
    await expect(sheet).toBeVisible();
    const v1 = sheet.locator('[data-testid="version-row"][data-version="1"]');
    const file = await downloadFrom(page, () => v1.getByRole('button', { name: 'figures.csv' }).click());
    expect(file.suggestedFilename()).toBe('figures.csv');
    expect((await bytesOf(file)).toString()).toBe(FIGURES);
    const zip = await downloadFrom(page, () => v1.getByTestId('version-files-zip').click());
    expectZipWith(await bytesOf(zip), 'figures.csv');
    await page.keyboard.press('Escape');
  });

  await test.step('form responses: one file, one response’s zip, the whole deck’s zip', async () => {
    await page.goto(`/decks/${deckId}`);
    const panel = page.getByTestId('form-responses-panel');
    await expect(panel.getByTestId('response-file')).toHaveCount(1, { timeout: 15_000 });

    const cv = await downloadFrom(page, () => panel.getByTestId('response-file').click());
    expect(cv.suggestedFilename()).toBe('cv.pdf');
    expect((await bytesOf(cv)).equals(CV)).toBe(true);

    const oneZip = await downloadFrom(page, () => panel.getByTestId('response-files-zip').click());
    expect(oneZip.suggestedFilename()).toMatch(/\.zip$/);
    expectZipWith(await bytesOf(oneZip), 'cv.pdf');

    const allZip = await downloadFrom(page, () => page.getByTestId('responses-files-zip').click());
    expect(allZip.suggestedFilename()).toMatch(/\.zip$/);
    expectZipWith(await bytesOf(allZip), 'cv.pdf');
  });

  await test.step('files page and settings export', async () => {
    await page.goto('/files');
    const row = page.getByRole('row', { name: /loose-file\.txt/ });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.getByRole('button', { name: 'Open menu' }).click();
    const loose = await downloadFrom(page, () => page.getByRole('menuitem', { name: 'Download' }).click());
    expect(loose.suggestedFilename()).toBe('loose-file.txt');
    expect((await bytesOf(loose)).equals(LOOSE_FILE)).toBe(true);

    await page.goto('/settings');
    const exported = await downloadFrom(page, () =>
      page
        .getByRole('button', { name: /export/i })
        .first()
        .click()
    );
    // The server's own name for an export, not a name the page made up.
    expect(exported.suggestedFilename()).toMatch(/^export-.+\.zip$/);
    expect((await bytesOf(exported)).subarray(0, 2).toString()).toBe('PK');
  });

  await test.step('a refused download is said on screen, never a click that does nothing', async () => {
    await page.goto(`/decks/${deckId}`);
    const panel = page.getByTestId('form-responses-panel');
    await expect(panel.getByTestId('response-file')).toHaveCount(1, { timeout: 15_000 });
    // The response goes away behind the page's back (another tab, a colleague).
    const gone = await page.request.delete(`/api/v1/presentations/${deckId}/responses/${responseId}`, {
      headers: inSecond()
    });
    expect(gone.status()).toBe(200);
    await panel.getByTestId('response-file').click();
    await expect(page.getByText('This file is no longer available')).toBeVisible();
  });

  await test.step('switching back from the menu returns to the first workspace', async () => {
    await page.getByTestId('workspace-switcher').click();
    await page
      .getByRole('menu')
      .getByTestId('workspace-entry')
      .filter({ hasText: firstWorkspace.name })
      .click();
    await expect(page.getByTestId('workspace-switcher')).toContainText(firstWorkspace.name, {
      timeout: 20_000
    });
    expect(await page.evaluate(() => localStorage.getItem('platform.workspaceId'))).toBe(firstWorkspace.id);
  });
});
