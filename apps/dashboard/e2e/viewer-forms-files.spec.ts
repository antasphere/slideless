import { createHash } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { OWNER } from './accounts';

/**
 * PRDCT-2403 — a form's FILE FIELD through a direct share link, in a real
 * browser against the real stack (`dependencies: ['smoke']`, so the owner
 * exists). The deck is a HABITAT, not a bare form: it binds its own
 * document-level key handler and its own document-level drop handler, the
 * way real decks do, and the drop panel has to work inside that.
 *
 *  - the file inputs become drop panels that state the author's rules;
 *  - a wrong type, a file over the author's size and a missing mandatory
 *    file are refused in the page, in the deck's language, nothing uploaded;
 *  - a REAL drop (a DataTransfer carrying File objects) and a click through
 *    the system file picker both upload; the deck's own handlers see neither;
 *  - the submit attaches the files, and the owner reads them back through
 *    the API: the listing, one file's bytes served as a download, the zip;
 *  - a link with uploads off shows the field as unavailable and still
 *    submits the rest of the form.
 */

const INDEX_HTML = [
  '<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>E2E File Field</title></head><body>',
  '<h1 id="title">Dossier</h1>',
  '<form data-slideless-form="dossier">',
  '  <input id="f-name" name="societe" required>',
  '  <input id="f-docs" type="file" name="documents" multiple required accept=".pdf,.png" data-slideless-max="2">',
  '  <input id="f-logo" type="file" name="logo" accept="image/*" data-slideless-max-mb="1">',
  '  <button id="f-send" type="submit">Envoyer</button>',
  '</form>',
  '<script>',
  "  document.addEventListener('keydown', function () { document.body.setAttribute('data-deck-key', '1'); });",
  "  document.addEventListener('drop', function () { document.body.setAttribute('data-deck-drop', '1'); });",
  '</script>',
  '</body></html>'
].join('\n');

const shaOf = (text: string) => createHash('sha256').update(Buffer.from(text)).digest('hex');

const PDF = Buffer.from('%PDF-1.4 e2e statuts');
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

/** Drop real File objects on an element, the way a drag from the desktop ends. */
async function dropOn(page: Page, selector: string, files: { name: string; type: string; bytes: Buffer }[]) {
  await page.evaluate(
    ({ selector, payload }) => {
      const dt = new DataTransfer();
      for (const p of payload) {
        const bin = atob(p.b64);
        const u8 = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        dt.items.add(new File([u8], p.name, { type: p.type }));
      }
      const el = document.querySelector(selector)!;
      for (const type of ['dragenter', 'dragover', 'drop']) {
        el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
      }
    },
    { selector, payload: files.map((f) => ({ name: f.name, type: f.type, b64: f.bytes.toString('base64') })) }
  );
}

test('a file field: refusals in the page, a drop and a pick upload, the owner reads the files back', async ({
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
  let closedSecret = '';
  await test.step('seed the deck and two links (uploads on, uploads off)', async () => {
    const reserve = await page.request.post('/api/v1/presentations/uploads');
    expect(reserve.status()).toBe(201);
    const { uploadSession } = await reserve.json();
    const asset = await page.request.post('/api/v1/presentations/assets', {
      multipart: {
        sha256: shaOf(INDEX_HTML),
        file: { name: 'index.html', mimeType: 'text/html', buffer: Buffer.from(INDEX_HTML) }
      }
    });
    expect(asset.status()).toBe(201);
    const commit = await page.request.post(`/api/v1/presentations/uploads/${uploadSession.id}/commit`, {
      data: {
        title: 'E2E File Field',
        entryPath: 'index.html',
        manifest: [
          {
            path: 'index.html',
            sha256: shaOf(INDEX_HTML),
            sizeBytes: Buffer.byteLength(INDEX_HTML),
            contentType: 'text/html'
          }
        ]
      }
    });
    expect(commit.status()).toBe(201);
    deckId = (await commit.json()).presentation.id;
    const open = await page.request.post(`/api/v1/presentations/${deckId}/tokens`, {
      data: { name: 'e2e-files', remembersResponses: false }
    });
    expect(open.status()).toBe(201);
    secret = (await open.json()).secret;
    const closed = await page.request.post(`/api/v1/presentations/${deckId}/tokens`, {
      data: { name: 'e2e-no-uploads', remembersResponses: false, canUploadFiles: false }
    });
    expect(closed.status()).toBe(201);
    closedSecret = (await closed.json()).secret;
  });

  const origin = new URL(page.url()).origin;
  const respondent = await (await browser.newContext()).newPage();
  const pageErrors: string[] = [];
  respondent.on('pageerror', (e) => pageErrors.push(e.message));
  const docs = respondent.locator('[data-slideless-drop="documents"]');
  const docsFiles = respondent.locator('[data-slideless-files="documents"] li');
  const docsMsg = respondent.locator('[data-slideless-files="documents"] ~ .sl-forms-err').first();
  const logo = respondent.locator('[data-slideless-drop="logo"]');
  const logoMsg = respondent.locator('[data-slideless-files="logo"] ~ .sl-forms-err').first();

  await test.step('the inputs become drop panels that state the rules, in French', async () => {
    await respondent.goto(`${origin}/v/${secret}/`);
    await expect(docs).toContainText('Déposez des fichiers ici, ou cliquez pour les choisir');
    await expect(docs).toContainText('.pdf, .png');
    await expect(docs).toContainText('2 fichiers au maximum');
    await expect(logo).toContainText('Déposez un fichier ici, ou cliquez pour le choisir');
    await expect(logo).toContainText('1 MB maximum par fichier');
    // The author's own inputs stay in the DOM, out of sight and out of the tab order.
    await expect(respondent.locator('#f-docs')).toHaveClass(/sl-forms-file-hidden/);
  });

  await test.step('a wrong type, an oversize file and a missing mandatory file are refused in the page', async () => {
    await dropOn(respondent, '[data-slideless-drop="documents"]', [
      { name: 'notes.txt', type: 'text/plain', bytes: Buffer.from('nope') }
    ]);
    await expect(docsMsg).toContainText("notes.txt n'est pas d'un format accepté");
    await dropOn(respondent, '[data-slideless-drop="logo"]', [
      { name: 'huge.png', type: 'image/png', bytes: Buffer.alloc(1024 * 1024 + 1, 1) }
    ]);
    await expect(logoMsg).toContainText('huge.png dépasse 1 MB');
    await respondent.locator('#f-name').fill('Atelier E2E');
    await respondent.locator('#f-send').click();
    await expect(docsMsg).toContainText('Veuillez ajouter un fichier');
    await expect(respondent.locator('[data-slideless-dialog]')).toHaveCount(0);
    await expect(docsFiles).toHaveCount(0);
  });

  await test.step("a real drop and a pick through the file chooser both upload; the deck's handlers see neither", async () => {
    await dropOn(respondent, '[data-slideless-drop="documents"]', [
      { name: 'statuts.pdf', type: 'application/pdf', bytes: PDF }
    ]);
    await expect(
      respondent.locator('[data-slideless-files="documents"] li[data-slideless-file="done"]')
    ).toHaveCount(1);
    const [chooser] = await Promise.all([respondent.waitForEvent('filechooser'), docs.click()]);
    expect(chooser.isMultiple()).toBe(true);
    await chooser.setFiles({ name: 'carte.png', mimeType: 'image/png', buffer: PNG });
    await expect(
      respondent.locator('[data-slideless-files="documents"] li[data-slideless-file="done"]')
    ).toHaveCount(2);
    // A third file passes the author's maximum of two.
    await dropOn(respondent, '[data-slideless-drop="documents"]', [
      { name: 'extra.pdf', type: 'application/pdf', bytes: PDF }
    ]);
    await expect(docsMsg).toContainText('2 fichiers au maximum');
    await expect(docsFiles).toHaveCount(2);
    // Enter on the focused panel opens the picker; the deck's key handler saw nothing.
    await docs.focus();
    const [again] = await Promise.all([
      respondent.waitForEvent('filechooser'),
      respondent.keyboard.press('Enter')
    ]);
    await again.setFiles([]);
    await expect(respondent.locator('body')).not.toHaveAttribute('data-deck-key', '1');
    await expect(respondent.locator('body')).not.toHaveAttribute('data-deck-drop', '1');
  });

  await test.step('a drop that misses the panels, with two on screen, adds nothing and never leaves the page', async () => {
    const before = respondent.url();
    await dropOn(respondent, '#title', [{ name: 'stray.pdf', type: 'application/pdf', bytes: PDF }]);
    await expect(docsFiles).toHaveCount(2);
    expect(respondent.url()).toBe(before);
  });

  await test.step('the submit attaches the files and the owner reads them back', async () => {
    await respondent.locator('#f-send').click();
    await expect(respondent.locator('[data-slideless-dialog="dossier"]')).toBeVisible();
    const listed = await (await page.request.get(`/api/v1/presentations/${deckId}/responses`)).json();
    expect(listed.responses).toHaveLength(1);
    const response = listed.responses[0];
    expect(response.payload).toEqual({ societe: 'Atelier E2E' });
    expect(response.files.map((f: { field: string; name: string }) => `${f.field}/${f.name}`)).toEqual([
      'documents/statuts.pdf',
      'documents/carte.png'
    ]);
    const pdf = response.files[0];
    const dl = await page.request.get(
      `/api/v1/presentations/${deckId}/responses/${response.id}/files/${pdf.id}`
    );
    expect(dl.status()).toBe(200);
    expect(dl.headers()['content-disposition']).toMatch(/^attachment;/);
    expect(dl.headers()['x-content-type-options']).toBe('nosniff');
    expect((await dl.body()).equals(PDF)).toBe(true);
    const zip = await page.request.get(`/api/v1/presentations/${deckId}/responses/files.zip`);
    expect(zip.status()).toBe(200);
    expect(zip.headers()['content-type']).toBe('application/zip');
  });

  await test.step('a link with uploads off shows the field as unavailable and still submits the rest', async () => {
    const closed = await (await browser.newContext()).newPage();
    await closed.goto(`${origin}/v/${closedSecret}/`);
    await expect(closed.locator('[data-slideless-drop="documents"]')).toContainText(
      "L'envoi de fichiers n'est pas disponible sur ce lien."
    );
    await closed.locator('#f-name').fill('Sans fichiers');
    await closed.locator('#f-send').click();
    await expect(closed.locator('[data-slideless-dialog="dossier"]')).toBeVisible();
  });

  expect(pageErrors).toEqual([]);
});
