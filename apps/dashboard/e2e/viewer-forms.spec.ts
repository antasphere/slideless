import { createHash } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { OWNER } from './accounts';

/**
 * ADR 022 — deck-embedded forms through a direct share link, end-to-end
 * against the real stack (this project `dependencies: ['smoke']`, so the
 * owner exists):
 *
 *  - push a deck whose HTML carries a plain `<form data-slideless-form>` →
 *    share it → an anonymous viewer fills and submits;
 *  - the confirmation card shows the author's custom success message and
 *    the personal edit link (the `#slr=` fragment secret);
 *  - a FRESH visitor reopening that edit link gets the form prefilled and
 *    their submit becomes an update (same row, new payload, bumped
 *    updatedAt) — never a second row;
 *  - the owner sees it all through the responses API with source 'link'.
 *
 * The stack runs EMAIL_DRIVER=none, so the email opt-in row must be absent
 * from the card (the injected config's emailAvailable:false).
 */

const SUCCESS = 'Merci! Response saved for the e2e spec.';

const INDEX_HTML = [
  '<!doctype html><html><head><meta charset="utf-8"><title>E2E Forms Deck</title></head><body>',
  '<h1>RSVP</h1>',
  `<form data-slideless-form="rsvp" data-slideless-success="${SUCCESS}">`,
  '  <input id="f-name" name="name" placeholder="Your name">',
  '  <label><input type="checkbox" name="dish" value="salad"> salad</label>',
  '  <label><input type="checkbox" name="dish" value="bread"> bread</label>',
  '  <button id="f-send" type="submit">Send</button>',
  '</form>',
  '</body></html>'
].join('\n');

const shaOf = (text: string) => createHash('sha256').update(Buffer.from(text)).digest('hex');

async function uploadAsset(page: Page, text: string): Promise<void> {
  const res = await page.request.post('/api/v1/presentations/assets', {
    multipart: {
      sha256: shaOf(text),
      file: { name: shaOf(text), mimeType: 'text/html', buffer: Buffer.from(text) }
    }
  });
  expect(res.status()).toBe(201);
}

test('viewer forms: submit, confirmation card with edit link, return-and-update, owner sees the row', async ({
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
    await uploadAsset(page, INDEX_HTML);
    const commit = await page.request.post(`/api/v1/presentations/uploads/${uploadSession.id}/commit`, {
      data: {
        title: 'E2E Forms Deck',
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

    // No flags: can_submit_forms defaults ON — push + share = working form.
    const token = await page.request.post(`/api/v1/presentations/${deckId}/tokens`, {
      data: { name: 'e2e-form-filler' }
    });
    expect(token.status()).toBe(201);
    secret = (await token.json()).secret;
  });

  const origin = new URL(page.url()).origin;
  const respondent = await (await browser.newContext()).newPage();
  let editUrl = '';

  await test.step('an anonymous viewer fills and submits the form', async () => {
    await respondent.goto(`${origin}/v/${secret}/`);
    await expect(respondent.locator('form[data-slideless-form="rsvp"]')).toBeVisible();
    await respondent.locator('#f-name').fill('Ada E2E');
    await respondent.locator('input[name="dish"][value="salad"]').check();
    await respondent.locator('input[name="dish"][value="bread"]').check();
    await respondent.locator('#f-send').click();

    const card = respondent.locator('.sl-forms-card');
    await expect(card).toBeVisible();
    // The author's custom success message, then the personal edit link.
    await expect(card.locator('.sl-forms-ok')).toHaveText(SUCCESS);
    const link = (await card.locator('.sl-forms-link').textContent()) ?? '';
    expect(link).toContain(`/v/${secret}/#slr=`);
    editUrl = link;
    // The form swapped away; EMAIL_DRIVER=none hides the email opt-in.
    await expect(respondent.locator('form[data-slideless-form="rsvp"]')).toBeHidden();
    await expect(card.locator('.sl-forms-mail')).toHaveCount(0);
  });

  let responseId = '';
  let createdUpdatedAt = '';
  await test.step("the owner's responses API shows the row (source 'link')", async () => {
    const listed = await page.request.get(`/api/v1/presentations/${deckId}/responses`);
    expect(listed.status()).toBe(200);
    const { responses } = await listed.json();
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({
      formName: 'rsvp',
      source: 'link',
      placement: null,
      payload: { name: 'Ada E2E', dish: ['salad', 'bread'] }
    });
    responseId = responses[0].id;
    createdUpdatedAt = responses[0].updatedAt;
  });

  await test.step('a fresh visitor reopens via the edit link: consents, is prefilled, and updates in place', async () => {
    // A NEW context: the edit secret in the fragment is the whole handle.
    const returning = await (await browser.newContext()).newPage();
    await returning.goto(editUrl);

    // PRDCT-1332: an arriving fragment is NEVER silently adopted — whoever
    // wrote the link may not be the person now at the keyboard. The prompt
    // comes first and CREATE is the default, so nothing is prefilled yet.
    const resume = returning.locator('[data-slideless-resume="rsvp"]');
    await expect(resume).toBeVisible();
    await expect(returning.locator('#f-name')).toHaveValue('');
    await resume.getByRole('button', { name: 'Edit that response' }).click();
    await expect(resume).toHaveCount(0);

    await expect(returning.locator('#f-name')).toHaveValue('Ada E2E');
    await expect(returning.locator('input[name="dish"][value="salad"]')).toBeChecked();
    await expect(returning.locator('input[name="dish"][value="bread"]')).toBeChecked();

    await returning.locator('#f-name').fill('Ada Updated');
    await returning.locator('input[name="dish"][value="bread"]').uncheck();
    await returning.locator('#f-send').click();
    await expect(returning.locator('.sl-forms-card .sl-forms-ok')).toHaveText(
      'Your response has been updated.'
    );
    await returning.context().close();
  });

  await test.step('the owner sees the UPDATED row — same row, new payload, bumped updatedAt', async () => {
    const listed = await page.request.get(`/api/v1/presentations/${deckId}/responses`);
    const { responses } = await listed.json();
    expect(responses).toHaveLength(1); // an update, never a second row
    expect(responses[0].id).toBe(responseId);
    expect(responses[0].payload).toEqual({ name: 'Ada Updated', dish: 'salad' });
    expect(new Date(responses[0].updatedAt).getTime()).toBeGreaterThan(new Date(createdUpdatedAt).getTime());

    // The summary agrees.
    const summary = await page.request.get(`/api/v1/presentations/${deckId}/responses/summary`);
    expect(summary.status()).toBe(200);
    const body = await summary.json();
    expect(body.total).toBe(1);
    expect(body.buckets[0]).toMatchObject({ formName: 'rsvp', source: 'link', count: 1 });
  });

  await test.step('clean up: delete the deck', async () => {
    await respondent.context().close();
    const del = await page.request.delete(`/api/v1/presentations/${deckId}`);
    expect(del.status()).toBe(200);
  });
});
