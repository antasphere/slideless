import { createHash } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { signInAsOwner } from './accounts';
import {
  ARCHITECTURE_DECK_HTML,
  BUNDLE_DECK_APP_JS,
  BUNDLE_DECK_INDEX_HTML,
  HASH_DECK_HTML,
  LATE_DECK_HTML,
  REALDECK_SUCCESS,
  TWO_FORMS_DECK_HTML
} from './deck-fixtures';

/**
 * PRDCT-1334 + PRDCT-1332 — the forms runtime IN ITS HABITAT.
 *
 * The pre-existing forms specs drive a bare `<form>` on an otherwise empty
 * page. That is why a feature whose own suite was 7/7 green broke five of
 * five genuine presentations: every real deck binds document-level keydown
 * and click navigation, and the runtime shielded only its confirmation
 * card. These specs use fixtures whose navigation engines are lifted
 * verbatim from `workspace/content/presentations/` (see deck-fixtures.ts).
 *
 * Each `test` names ONE audit finding and fails on its own if that finding
 * regresses — deliberately not one long chained scenario, so a single
 * broken defence cannot hide behind an earlier assertion.
 */

const shaOf = (text: string) => createHash('sha256').update(Buffer.from(text)).digest('hex');

interface ResponseRow {
  id: string;
  formName: string;
  payload: Record<string, string | string[]>;
}

// The shared, throttle-aware sign-in (accounts.ts): the projects sign in
// back to back on one worker, and Better Auth's sign-in throttle (three per
// ten seconds per IP under the image's production mode) answers "Too many
// attempts" to whichever lands fourth — a bare click here failed the moment
// the master project (PRDCT-2279) shifted the timing.
const signIn = signInAsOwner;

interface DeckFile {
  path: string;
  body: string;
  contentType: string;
}

/** Push a deck of one or more files and mint a default share link (forms ON by default). */
async function seedDeckFiles(
  page: Page,
  title: string,
  files: DeckFile[]
): Promise<{ deckId: string; secret: string }> {
  const reserve = await page.request.post('/api/v1/presentations/uploads');
  expect(reserve.status()).toBe(201);
  const { uploadSession } = await reserve.json();
  for (const f of files) {
    const upload = await page.request.post('/api/v1/presentations/assets', {
      multipart: {
        sha256: shaOf(f.body),
        file: { name: f.path.split('/').pop()!, mimeType: f.contentType, buffer: Buffer.from(f.body) }
      }
    });
    expect(upload.status()).toBe(201);
  }
  const commit = await page.request.post(`/api/v1/presentations/uploads/${uploadSession.id}/commit`, {
    data: {
      title,
      entryPath: 'index.html',
      manifest: files.map((f) => ({
        path: f.path,
        sha256: shaOf(f.body),
        sizeBytes: Buffer.byteLength(f.body),
        contentType: f.contentType
      }))
    }
  });
  expect(commit.status()).toBe(201);
  const deckId = (await commit.json()).presentation.id;
  const token = await page.request.post(`/api/v1/presentations/${deckId}/tokens`, {
    data: { name: `e2e-${title}` }
  });
  expect(token.status()).toBe(201);
  return { deckId, secret: (await token.json()).secret };
}

/** Push a one-file deck and mint a default share link (forms ON by default). */
function seedDeck(page: Page, title: string, html: string): Promise<{ deckId: string; secret: string }> {
  return seedDeckFiles(page, title, [{ path: 'index.html', body: html, contentType: 'text/html' }]);
}

async function listResponses(page: Page, deckId: string): Promise<ResponseRow[]> {
  const listed = await page.request.get(`/api/v1/presentations/${deckId}/responses`);
  expect(listed.status()).toBe(200);
  return (await listed.json()).responses as ResponseRow[];
}

/**
 * ONE sign-in for the whole file, deliberately. A `beforeEach` here signed
 * in five times, and `limiters.login` is 10 per 15 minutes per IP AND per
 * address (middleware/rate-limit.ts) — with smoke, decks, viewer, embed and
 * forms also signing in, the FULL suite crossed the budget and the last
 * tests failed at the login page, looking like forms flakes. Keep this at
 * one login: every test here shares the owner page for its API calls, and
 * respondents get their own fresh contexts anyway (which is the point).
 */
test.describe('forms runtime in a real slide deck', () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await (await browser.newContext()).newPage();
    await signIn(page);
  });

  test.afterAll(async () => {
    await page.context().close();
  });

  test('§4.1 deck handlers do not own the form: clicking, spacing and submitting stay on the slide', async ({
    browser
  }) => {
    const { deckId, secret } = await seedDeck(page, 'ArchDeck', ARCHITECTURE_DECK_HTML);
    const visitor = await (await browser.newContext()).newPage();
    const origin = new URL(page.url()).origin;
    await visitor.goto(`${origin}/v/${secret}/`);

    // Reach the form's slide with the deck's OWN keyboard nav: the shield is
    // scoped to the form, it must not disarm the deck.
    await expect(visitor.locator('#count')).toHaveText('1');
    await visitor.locator('body').press('ArrowRight');
    await expect(visitor.locator('#count')).toHaveText('2');
    await expect(visitor.locator('form[data-slideless-form="contact"]')).toBeVisible();

    // 1. Clicking a field must not drive the #deck click handler. The field
    //    sits left of centre, which in this engine means "previous slide".
    await visitor.locator('#f-name').click();
    await expect(visitor.locator('#count')).toHaveText('2');
    await expect(visitor.locator('#f-name')).toBeFocused();

    // 2. SPACE must reach the input, not the deck. The deck's handler both
    //    advances AND preventDefaults, so the original failure lost the
    //    space from the value ("JeanDupont") and moved the slide.
    await visitor.locator('#f-name').pressSequentially('Jean Dupont', { delay: 10 });
    await expect(visitor.locator('#f-name')).toHaveValue('Jean Dupont');
    await expect(visitor.locator('#count')).toHaveText('2');

    // 3. Arrow keys inside a text field belong to the field's caret, not to
    //    the deck's navigation.
    await visitor.locator('#f-mail').pressSequentially('jean@exemple.be', { delay: 10 });
    await visitor.locator('#f-mail').press('ArrowLeft');
    await expect(visitor.locator('#count')).toHaveText('2');
    await expect(visitor.locator('#f-mail')).toHaveValue('jean@exemple.be');

    // 4. Submitting must not navigate: the confirmation card has to be born
    //    on the VISIBLE slide, or the respondent never sees their edit link.
    await visitor.locator('#f-send').click();
    const card = visitor.locator('[data-slideless-card="contact"]');
    await expect(card).toBeVisible();
    await expect(card.locator('.sl-forms-ok')).toHaveText(REALDECK_SUCCESS);
    await expect(visitor.locator('#count')).toHaveText('2');
    await expect(card.locator('.sl-forms-link')).toContainText(`/v/${secret}/#slr=`);

    // …and clicking inside the card does not navigate the deck either.
    await card.locator('.sl-forms-ok').click();
    await expect(visitor.locator('#count')).toHaveText('2');

    const rows = await listResponses(page, deckId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      formName: 'contact',
      payload: { name: 'Jean Dupont', email: 'jean@exemple.be' }
    });
    await visitor.context().close();
    expect((await page.request.delete(`/api/v1/presentations/${deckId}`)).status()).toBe(200);
  });

  test('§4.2 two forms on one page: editing one never touches the other', async ({ browser }) => {
    const { deckId, secret } = await seedDeck(page, 'TwoForms', TWO_FORMS_DECK_HTML);
    const visitor = await (await browser.newContext()).newPage();
    const origin = new URL(page.url()).origin;
    await visitor.goto(`${origin}/v/${secret}/`);
    await visitor.locator('body').press('ArrowRight');
    await expect(visitor.locator('form[data-slideless-form="public"]')).toBeVisible();

    // Submit `public`, THEN `salary`. The old runtime kept ONE module-level
    // editSecret, so the second create clobbered the first form's handle.
    await visitor.locator('#pub-note').fill('nothing to hide');
    await visitor.locator('#pub-send').click();
    await expect(visitor.locator('[data-slideless-card="public"]')).toBeVisible();

    await visitor.locator('#sal-amount').fill('42000');
    await visitor.locator('#sal-send').click();
    await expect(visitor.locator('[data-slideless-card="salary"]')).toBeVisible();

    expect(await listResponses(page, deckId)).toHaveLength(2);

    // Correct the PUBLIC answer. With the shared secret this filed the
    // correction under `salary`, destroying the salary answer, while the
    // card told the respondent "Your response has been updated."
    const publicCard = visitor.locator('[data-slideless-card="public"]');
    await publicCard.getByRole('button', { name: 'Edit response' }).click();
    await expect(visitor.locator('form[data-slideless-form="public"]')).toBeVisible();
    await visitor.locator('#pub-note').fill('corrected note');
    await visitor.locator('#pub-send').click();
    await expect(visitor.locator('[data-slideless-card="public"] .sl-forms-ok')).toHaveText(
      'Your response has been updated.'
    );

    const rows = await listResponses(page, deckId);
    expect(rows).toHaveLength(2); // an update, never a third row
    const byForm = Object.fromEntries(rows.map((r) => [r.formName, r.payload]));
    expect(byForm['public']).toEqual({ note: 'corrected note' });
    // The load-bearing assertion of this whole spec.
    expect(byForm['salary']).toEqual({ amount: '42000' });

    // The two cards advertise DIFFERENT edit links — one shared secret made
    // form A's card hand out form B's respondent capability (verified in the
    // audit via Mailpit, under text telling the recipient it is a password).
    const pubLink = await publicCard.locator('.sl-forms-link').textContent();
    const salLink = await visitor.locator('[data-slideless-card="salary"] .sl-forms-link').textContent();
    expect(pubLink).not.toBe(salLink);

    await visitor.context().close();
    expect((await page.request.delete(`/api/v1/presentations/${deckId}`)).status()).toBe(200);
  });

  test('§4.3 a form rendered on DOMContentLoaded is still intercepted', async ({ browser }) => {
    const { deckId, secret } = await seedDeck(page, 'LateDeck', LATE_DECK_HTML);
    const visitor = await (await browser.newContext()).newPage();
    const origin = new URL(page.url()).origin;
    await visitor.goto(`${origin}/v/${secret}/`);

    await expect(visitor.locator('form[data-slideless-form="late"]')).toBeVisible();
    await visitor.locator('#f-note').fill('rendered late');
    await visitor.locator('#f-send').click();

    // A missed form native-submits: the sandbox navigates with the answers
    // in the query string and nothing is stored. Both halves are asserted.
    await expect(visitor.locator('[data-slideless-card="late"]')).toBeVisible();
    expect(new URL(visitor.url()).search).toBe('');
    const rows = await listResponses(page, deckId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ formName: 'late', payload: { note: 'rendered late' } });

    await visitor.context().close();
    expect((await page.request.delete(`/api/v1/presentations/${deckId}`)).status()).toBe(200);
  });

  test('§4.4 a deck that rewrites its own hash does not destroy the edit link', async ({ browser }) => {
    const { deckId, secret } = await seedDeck(page, 'HashDeck', HASH_DECK_HTML);
    const origin = new URL(page.url()).origin;
    const visitor = await (await browser.newContext()).newPage();
    await visitor.goto(`${origin}/v/${secret}/`);
    await visitor.locator('body').press('ArrowRight');
    await expect(visitor.locator('form[data-slideless-form="avis"]')).toBeVisible();

    // This engine makes DIGITS hotkeys (1..7), so an address with a digit
    // used to jump the deck mid-typing.
    await visitor.locator('#f-mail').pressSequentially('avis2@exemple.be', { delay: 10 });
    await expect(visitor.locator('#f-mail')).toHaveValue('avis2@exemple.be');
    await expect(visitor.locator('#count')).toHaveText('2');

    await visitor.locator('#f-send').click();
    const editUrl =
      (await visitor.locator('[data-slideless-card="avis"] .sl-forms-link').textContent()) ?? '';
    expect(editUrl).toContain('#slr=');
    await visitor.context().close();

    // The deck runs history.replaceState(null,'','#slide=1') at start-up,
    // BEFORE the end-of-body runtime, so location.hash is already gone by
    // the time the runtime reads it. The early <head> stub is what saves it.
    const returning = await (await browser.newContext()).newPage();
    await returning.goto(editUrl);
    await expect(returning).toHaveURL(/#slide=1$/); // the deck did wipe it
    await returning.locator('body').press('ArrowRight');

    // PRDCT-1332: the fragment is a CANDIDATE, never adopted silently. This
    // prompt existing at all is the proof the secret survived the wipe.
    const resume = returning.locator('[data-slideless-resume="avis"]');
    await expect(resume).toBeVisible();
    await expect(returning.locator('#f-mail')).toHaveValue(''); // nothing adopted yet
    await resume.getByRole('button', { name: 'Edit that response' }).click();
    await expect(returning.locator('#f-mail')).toHaveValue('avis2@exemple.be');

    await returning.locator('#f-mail').fill('avis3@exemple.be');
    await returning.locator('#f-send').click();
    await expect(returning.locator('[data-slideless-card="avis"] .sl-forms-ok')).toHaveText(
      'Your response has been updated.'
    );
    const rows = await listResponses(page, deckId);
    expect(rows).toHaveLength(1); // updated in place, not duplicated
    expect(rows[0]!.payload).toEqual({ email: 'avis3@exemple.be' });

    await returning.context().close();
    expect((await page.request.delete(`/api/v1/presentations/${deckId}`)).status()).toBe(200);
  });

  test('PRDCT-1332: a PLANTED #slr= creates a new row instead of overwriting the stranger it points at', async ({
    browser
  }) => {
    const { deckId, secret } = await seedDeck(page, 'HijackDeck', ARCHITECTURE_DECK_HTML);
    const origin = new URL(page.url()).origin;

    // The attacker submits one blank response through the public link and
    // keeps its edit secret. A blank payload makes the prefill invisible,
    // which is what made the original attack silent to the victim.
    const attacker = await (await browser.newContext()).newPage();
    await attacker.goto(`${origin}/v/${secret}/`);
    await attacker.locator('body').press('ArrowRight');
    await attacker.locator('#f-send').click();
    const attackerLink =
      (await attacker.locator('[data-slideless-card="contact"] .sl-forms-link').textContent()) ?? '';
    const attackerSecret = attackerLink.split('#slr=')[1] ?? '';
    expect(attackerSecret).not.toBe('');
    await attacker.context().close();

    const before = await listResponses(page, deckId);
    expect(before).toHaveLength(1);
    const attackerRowId = before[0]!.id;

    // The victim opens the ATTACKER's link and fills the form.
    const victim = await (await browser.newContext()).newPage();
    await victim.goto(attackerLink);
    await victim.locator('body').press('ArrowRight');

    // The hijack is now visible and consented: an explicit prompt, create is
    // the default, nothing is prefilled and no secret is adopted.
    await expect(victim.locator('[data-slideless-resume="contact"]')).toBeVisible();
    await expect(victim.locator('#f-name')).toHaveValue('');
    await victim.locator('#f-name').fill('Real Subscriber');
    await victim.locator('#f-mail').fill('real.subscriber@bank.example');
    await victim.locator('#f-send').click();
    // The author's success message, NOT "updated" — the only tell the audit
    // found for the victim, and it now says the truthful thing.
    await expect(victim.locator('[data-slideless-card="contact"] .sl-forms-ok')).toHaveText(REALDECK_SUCCESS);

    // TWO rows: the victim created their own, the attacker's is untouched.
    const rows = await listResponses(page, deckId);
    expect(rows).toHaveLength(2);
    const attackerRow = rows.find((r) => r.id === attackerRowId);
    expect(attackerRow!.payload).toEqual({ name: '', email: '' });
    expect(rows.some((r) => r.payload['name'] === 'Real Subscriber')).toBe(true);

    // And the attacker reading their own row back harvests nothing.
    const readBack = await page.request.get(`${origin}/api/v1/viewer/${secret}/forms/contact/responses/me`, {
      headers: { 'x-slideless-response': attackerSecret, origin: 'null' }
    });
    expect(readBack.status()).toBe(200);
    expect((await readBack.json()).response.payload).toEqual({ name: '', email: '' });

    await victim.context().close();
    expect((await page.request.delete(`/api/v1/presentations/${deckId}`)).status()).toBe(200);
  });
  test('residual 1: a form authored from an EXTERNAL JS bundle is detected and wired', async ({
    browser
  }) => {
    const { deckId, secret } = await seedDeckFiles(page, 'BundleDeck', [
      { path: 'index.html', body: BUNDLE_DECK_INDEX_HTML, contentType: 'text/html' },
      { path: 'app.js', body: BUNDLE_DECK_APP_JS, contentType: 'text/javascript' }
    ]);
    const visitor = await (await browser.newContext()).newPage();
    const origin = new URL(page.url()).origin;
    await visitor.goto(`${origin}/v/${secret}/`);

    // The runtime is present at all — the failure mode was its ABSENCE.
    await expect(visitor.locator('script[data-slideless-forms]')).toHaveCount(1);
    await expect(visitor.locator('form[data-slideless-form="bundled"]')).toBeVisible();
    await visitor.locator('#f-note').fill('from the bundle');
    await visitor.locator('#f-send').click();

    await expect(visitor.locator('[data-slideless-card="bundled"]')).toBeVisible();
    expect(new URL(visitor.url()).search).toBe('');
    const rows = await listResponses(page, deckId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ formName: 'bundled', payload: { note: 'from the bundle' } });

    await visitor.context().close();
    expect((await page.request.delete(`/api/v1/presentations/${deckId}`)).status()).toBe(200);
  });

  test('residual 2: a planted bogus #slr= costs ONE probe per page load on a two-form deck, and nobody gets locked out', async ({
    browser
  }) => {
    const { deckId, secret } = await seedDeck(page, 'ProbeDeck', TWO_FORMS_DECK_HTML);
    const origin = new URL(page.url()).origin;
    const bogus = 'x'.repeat(48);

    // Ten page loads with a bogus fragment. It used to cost one probe PER
    // FORM per load (20 here) against a 30-point submit bucket keyed IP +
    // link — the 11th load locked every respondent behind that IP out.
    const visitor = await (await browser.newContext()).newPage();
    let probes = 0;
    visitor.on('request', (req) => {
      if (req.method() === 'GET' && /\/forms\/(?:[^/]+\/)?responses\/me$/.test(new URL(req.url()).pathname))
        probes++;
    });
    for (let i = 0; i < 10; i++) {
      // A goto whose URL differs only by fragment is a same-document
      // navigation: reload() is what makes each iteration a real page load.
      if (i === 0) await visitor.goto(`${origin}/v/${secret}/#slr=${bogus}`);
      else await visitor.reload();
      await visitor.locator('body').press('ArrowRight');
      await expect(visitor.locator('form[data-slideless-form="public"]')).toBeVisible();
      // Give a per-form probe every chance to fire before counting.
      await visitor.waitForTimeout(150);
    }
    expect(probes).toBe(10);
    // No resume prompt for a secret that resolves to nothing.
    await expect(visitor.locator('[data-slideless-resume]')).toHaveCount(0);

    // The bucket is still healthy: a submit from this same IP succeeds.
    await visitor.locator('#pub-note').fill('still allowed');
    await visitor.locator('#pub-send').click();
    await expect(visitor.locator('[data-slideless-card="public"]')).toBeVisible();
    await visitor.context().close();

    // A REAL secret resolves once too, and the prompt lands on the form the
    // row names — not on its neighbour.
    const first = await (await browser.newContext()).newPage();
    await first.goto(`${origin}/v/${secret}/`);
    await first.locator('body').press('ArrowRight');
    await first.locator('#sal-amount').fill('4200');
    await first.locator('#sal-send').click();
    const link = (await first.locator('[data-slideless-card="salary"] .sl-forms-link').textContent()) ?? '';
    expect(link).toContain('#slr=');
    await first.context().close();

    const returning = await (await browser.newContext()).newPage();
    let realProbes = 0;
    returning.on('request', (req) => {
      if (req.method() === 'GET' && /\/forms\/(?:[^/]+\/)?responses\/me$/.test(new URL(req.url()).pathname))
        realProbes++;
    });
    await returning.goto(link);
    await returning.locator('body').press('ArrowRight');
    await expect(returning.locator('[data-slideless-resume="salary"]')).toBeVisible();
    await expect(returning.locator('[data-slideless-resume="public"]')).toHaveCount(0);
    expect(realProbes).toBe(1);
    await returning.context().close();

    const rows = await listResponses(page, deckId);
    expect(rows).toHaveLength(2);
    expect((await page.request.delete(`/api/v1/presentations/${deckId}`)).status()).toBe(200);
  });
});
