import { createHash } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { signInAsOwner } from './accounts';

/**
 * Phase 8 — the decks product UI, against the same stack the smoke project
 * set up (this project `dependencies: ['smoke']`, so the owner exists).
 *
 * There is deliberately no upload UI, so the deck is seeded through the API
 * on the owner's session cookie (page.request shares the context's cookies):
 * two versions, an annotator share token, and one reviewer annotation whose
 * body/author are HOSTILE HTML — the suite's key assertion is that the
 * dashboard renders them as escaped TEXT (no element, no script, no dialog).
 */

const DECK_TITLE = 'E2E Deck <b>not-bold</b>';
const XSS_BODY = '<img src=x onerror=alert(1)>';
const XSS_AUTHOR = '<script>alert(2)</script>';
const HTML_V1 = '<!doctype html><html><body><h1>E2E deck body v1</h1></body></html>';
const HTML_V2 = '<!doctype html><html><body><h1>E2E deck body v2</h1></body></html>';
const SANDBOX =
  'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads';

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

test('decks: list, sandboxed preview, share links, collaborators, XSS-escaped annotations, versions', async ({
  page,
  browser
}) => {
  // XSS canary: any JS dialog (alert from an executed annotation payload)
  // fails the test at the end.
  let dialogFired = false;
  page.on('dialog', (dialog) => {
    dialogFired = true;
    void dialog.dismiss();
  });

  await test.step('sign in as the owner', async () => {
    await signInAsOwner(page);
  });

  let deckId = '';
  await test.step('seed a deck via the API (no upload UI, by design)', async () => {
    const reserve = await page.request.post('/api/v1/presentations/uploads');
    expect(reserve.status()).toBe(201);
    const { uploadSession } = await reserve.json();

    await uploadAsset(page, HTML_V1);
    const commit = await page.request.post(`/api/v1/presentations/uploads/${uploadSession.id}/commit`, {
      data: {
        title: DECK_TITLE,
        kind: 'presentation',
        interactive: false,
        entryPath: 'index.html',
        manifest: [entryOf('index.html', HTML_V1)]
      }
    });
    expect(commit.status()).toBe(201);
    deckId = (await commit.json()).presentation.id;

    // Version 2 — the version-history panel needs more than one row.
    await uploadAsset(page, HTML_V2);
    const v2 = await page.request.post(`/api/v1/presentations/${deckId}/versions`, {
      data: { expectedBaseVersion: 1, entryPath: 'index.html', manifest: [entryOf('index.html', HTML_V2)] }
    });
    expect(v2.status()).toBe(201);

    // A reviewer annotation with a HOSTILE body + author, through the real
    // public token-session surface (exactly what an anonymous reviewer can do).
    const annotator = await page.request.post(`/api/v1/presentations/${deckId}/tokens`, {
      data: { name: 'e2e-annotator', canAnnotate: true }
    });
    expect(annotator.status()).toBe(201);
    const { secret } = await annotator.json();
    const note = await page.request.post(`/api/v1/viewer/${secret}/annotations`, {
      data: { body: XSS_BODY, authorName: XSS_AUTHOR, selection: { slide: 1 } }
    });
    expect(note.status()).toBe(201);
  });

  await test.step('decks list renders the deck with an ESCAPED title', async () => {
    await page.getByRole('link', { name: 'Decks', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Decks' })).toBeVisible();
    // The literal "<b>" text must be visible — meaning it was escaped.
    // the decks page shows one card per deck (PRDCT-2437); the card's heading is the title
    await expect(page.getByRole('heading', { name: DECK_TITLE })).toBeVisible();
    // …and no <b> element was created from it anywhere on the page.
    expect(await page.locator('main b').count()).toBe(0);
  });

  await test.step('deck detail: sandboxed preview iframe WITHOUT allow-same-origin', async () => {
    await page.getByRole('heading', { name: DECK_TITLE }).click();
    await expect(page.getByRole('heading', { name: DECK_TITLE })).toBeVisible();

    const iframe = page.getByTestId('deck-preview');
    await expect(iframe).toBeVisible({ timeout: 15_000 });
    const sandbox = await iframe.getAttribute('sandbox');
    expect(sandbox).toBe(SANDBOX); // ADR 012 Surface D — the exact set
    expect(sandbox).not.toContain('allow-same-origin');
    expect(await iframe.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(await iframe.getAttribute('allow')).toBe('fullscreen');
    expect(await iframe.getAttribute('src')).toMatch(/\/v\/[A-Za-z0-9_-]{20,}/);
  });

  let viewerUrl = '';
  await test.step('create a share link via the UI — viewer URL shown once, then live', async () => {
    await page.getByRole('button', { name: 'New share link' }).click();
    const dialog = page.getByRole('dialog').filter({ hasText: 'Create a share link' });
    // getByLabel substring-matches the "…the recipient can leave notes"
    // checkbox label too — target the textbox role exactly.
    await dialog.getByRole('textbox', { name: 'Recipient' }).fill('reviewer-alice');
    // PRDCT-2299: the bar switch sits in the shared form, on by default.
    await expect(dialog.getByRole('checkbox', { name: /Show the bar/ })).toBeChecked();
    await dialog.getByRole('button', { name: 'Create link' }).click();

    const created = page.getByRole('dialog').filter({ hasText: 'Share link created' });
    viewerUrl = await created.getByRole('textbox', { name: 'Viewer URL' }).inputValue();
    // Trailing slash: the canonical entry URL, so relative deck refs resolve.
    expect(viewerUrl).toMatch(/\/v\/[A-Za-z0-9_-]{64}\/$/);
    await expect(created.getByRole('button', { name: 'Copy viewer URL' })).toBeVisible();
    await created.getByRole('button', { name: 'Done' }).click();

    // The row appears, and the URL actually serves the deck to an anonymous GET.
    await expect(page.getByRole('cell', { name: 'reviewer-alice' })).toBeVisible();
    const served = await page.request.get(viewerUrl);
    expect(served.status()).toBe(200);
    expect(await served.text()).toContain('E2E deck body v2');
  });

  await test.step('revoke the share link — access dies immediately', async () => {
    const row = page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'reviewer-alice' }) });
    await row.getByRole('button', { name: 'Open menu' }).click();
    await page.getByRole('menuitem', { name: 'Revoke' }).click();
    const confirm = page.getByRole('dialog').filter({ hasText: 'Revoke share link?' });
    await confirm.getByRole('button', { name: 'Revoke' }).click();
    await expect(row.getByText('Revoked')).toBeVisible();

    const served = await page.request.get(viewerUrl);
    expect(served.status()).toBe(403);
  });

  let claimUrl = '';
  await test.step('invite a collaborator via the UI — claim link produced, row listed', async () => {
    await page.getByRole('button', { name: 'Invite collaborator' }).click();
    const dialog = page.getByRole('dialog').filter({ hasText: 'Invite a collaborator' });
    await dialog.getByLabel('Email').fill('collab@example.com');
    await dialog.getByRole('button', { name: 'Create invitation' }).click();

    const created = page.getByRole('dialog').filter({ hasText: 'Collaborator invitation created' });
    claimUrl = await created.getByRole('textbox', { name: 'Claim link' }).inputValue();
    expect(claimUrl).toContain('/collab/');
    await created.getByRole('button', { name: 'Done' }).click();

    await expect(page.getByRole('cell', { name: 'collab@example.com' })).toBeVisible();
    await expect(page.getByText('Pending')).toBeVisible();
  });

  await test.step('the claim link works in a clean context and lands on the deck', async () => {
    const context = await browser.newContext();
    const claimer = await context.newPage();
    await claimer.goto(claimUrl);
    await expect(claimer.getByText('Collaborate on')).toBeVisible();
    await claimer.getByLabel('Your name').fill('Collab One');
    await claimer.getByLabel('Choose a password').fill('collab-password-123');
    await claimer.getByRole('button', { name: 'Create account and claim' }).click();
    // Claiming lands on the deck detail — the collaborator can read it.
    await expect(claimer.getByRole('heading', { name: DECK_TITLE })).toBeVisible({ timeout: 20_000 });
    await context.close();
  });

  await test.step('KEY SECURITY ASSERTION: hostile annotation renders as escaped text, never executes', async () => {
    const panel = page.getByTestId('annotations-panel');
    // The literal payloads are visible as TEXT…
    await expect(panel.getByText(XSS_BODY)).toBeVisible();
    await expect(panel.getByText(XSS_AUTHOR)).toBeVisible();
    await expect(panel.getByText('via share link')).toBeVisible();
    // …and never became elements: no <img>, no <script> inside the panel.
    expect(await panel.locator('img').count()).toBe(0);
    expect(await panel.locator('script').count()).toBe(0);
    // The onerror=alert(1) payload never executed (no dialog fired so far).
    expect(dialogFired).toBe(false);
  });

  await test.step('resolve the annotation', async () => {
    const panel = page.getByTestId('annotations-panel');
    await panel.getByRole('button', { name: 'Resolve' }).click();
    await expect(panel.getByText('Resolved', { exact: true })).toBeVisible();
  });

  await test.step('version history lists both versions; selecting one re-targets the preview', async () => {
    await expect(page.getByRole('cell', { name: 'v2 · Current' })).toBeVisible();
    const v1Row = page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'v1', exact: true }) });
    await expect(v1Row).toBeVisible();

    await v1Row.getByRole('button', { name: 'Preview' }).click();
    await expect(v1Row.getByText('Previewing')).toBeVisible();
    await expect(page.getByText('Previewing v1')).toBeVisible();

    // The remounted iframe still carries the exact sandbox set.
    const iframe = page.getByTestId('deck-preview');
    await expect(iframe).toBeVisible();
    expect(await iframe.getAttribute('sandbox')).toBe(SANDBOX);
  });

  await test.step('clean up: delete the deck; the list shows the empty state again', async () => {
    const del = await page.request.delete(`/api/v1/presentations/${deckId}`);
    expect(del.status()).toBe(200);
    await page.goto('/decks');
    // exact: the "No decks yet" card title is a heading matching the substring.
    await expect(page.getByRole('heading', { name: 'Decks', exact: true })).toBeVisible();
    await expect(page.getByText('No decks yet')).toBeVisible();
    // Final canary check: nothing executed anywhere along the way.
    expect(dialogFired).toBe(false);
  });
});
