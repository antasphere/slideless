// The billing campaign: Stripe's hosted Checkout page, paid by a browser.
// The path lane A proved on the sandbox on 24 September (its checkout-pay.mjs):
// the Card choice, Stripe's stable field ids, the box an automated browser is
// shown ("I am an AI agent acting on behalf of someone else"), the submit
// button that swallows a click landing before the page settled, so the click
// is tried up to three times. Extended here with the setup and subscription
// modes (their own return queries), the 3-D Secure test challenge, and the
// decline family. Playwright's Chromium comes from the dashboard's
// @playwright/test, the only place this repository holds a browser.
import { createRequire } from 'node:module';
import { config } from './config.mjs';

const require = createRequire(`${config.repo}/apps/dashboard/package.json`);
const { chromium } = require('@playwright/test');

/** Stripe's test cards, by what they do (docs: testing). */
export const CARDS = {
  visa: '4242424242424242',
  declined: '4000000000000002',
  insufficientFunds: '4000000000009995',
  expired: '4000000000000069',
  /** 3-D Secure required on session; an off-session charge fails with authentication_required. */
  authenticationRequired: '4000002500003155',
  /** Attaches, then fails every charge. */
  chargeFails: '4000000000000341'
};

/** The return query each Checkout mode lands on (the hub's routes). */
export const RETURNS = {
  payment: /checkout=success/,
  setup: /card=saved/,
  subscription: /plan=subscribed/
};

let browser = null;
async function launch() {
  if (!browser) browser = await chromium.launch({ headless: !config.headed });
  return browser;
}
export async function closeBrowser() {
  if (browser) await browser.close();
  browser = null;
}

const fillIfEmpty = async (page, selector, value) => {
  const loc = page.locator(selector);
  if (!(await loc.count()) || !(await loc.first().isVisible().catch(() => false))) return;
  const v = await loc.first().inputValue().catch(() => '');
  if (!v) await loc.first().fill(value);
};

/**
 * Pay (or save a card on, or subscribe through) a Checkout session.
 *   expect: 'paid' (the page reaches the mode's return URL), 'declined' (the
 *   page shows Stripe's decline and stays), '3ds' (a challenge is shown and
 *   completed, then the return URL).
 * Answers `{ outcome, url, text, shots }`; throws on anything else.
 */
export async function payCheckout(url, { card = CARDS.visa, expect = 'paid', mode = 'payment', email = config.owner.email, name = config.owner.name, label = 'checkout', country = 'BE', postalCode = '1000', line1 = 'Rue de la Loi 1', city = 'Bruxelles' } = {}) {
  const b = await launch();
  const context = await b.newContext({ viewport: { width: 1200, height: 1500 } });
  const page = await context.newPage();
  const shots = [];
  const shot = async (n) => {
    const file = `${config.out}/${label}-${n}.png`;
    try {
      await page.screenshot({ path: file, fullPage: true });
      shots.push(file);
    } catch {
      /* a closed page */
    }
  };
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForSelector('#email, #cardNumber, [data-testid="card-accordion-item"]', { timeout: 60_000 });
    const cardChoice = page.locator('[data-testid="card-accordion-item"], [data-testid="card-accordion-item-button"]').first();
    if (await cardChoice.count()) await cardChoice.click();
    else {
      const byText = page.getByText('Card', { exact: true }).first();
      if (await byText.count()) await byText.click();
    }
    await page.waitForSelector('#cardNumber', { timeout: 60_000 });
    await fillIfEmpty(page, '#email', email);
    await page.fill('#cardNumber', card);
    await page.fill('#cardExpiry', '12 / 34');
    await page.fill('#cardCvc', '123');
    await fillIfEmpty(page, '#billingName', name);
    const countryField = page.locator('#billingCountry');
    if (await countryField.count()) {
      const v = await countryField.inputValue().catch(() => '');
      if (!v) await countryField.selectOption(country);
    }
    await fillIfEmpty(page, '#billingPostalCode', postalCode);
    await fillIfEmpty(page, '#billingAddressLine1', line1);
    await fillIfEmpty(page, '#billingLocality', city);
    const agentBox = page.getByLabel(/AI agent/i).first();
    if (await agentBox.count()) {
      await agentBox.scrollIntoViewIfNeeded().catch(() => {});
      await agentBox.check({ force: true }).catch(() => {});
    }
    await shot('filled');
    const pay = page.locator('button.SubmitButton, button[type="submit"]').last();
    const alertText = async () => {
      const alerts = page.locator('[role="alert"], .FieldError, .Error, [aria-live="assertive"]');
      const n = await alerts.count();
      const parts = [];
      for (let i = 0; i < n; i += 1) {
        const t = ((await alerts.nth(i).textContent().catch(() => '')) ?? '').trim();
        if (t) parts.push(t);
      }
      return parts.join(' | ');
    };
    await page.waitForTimeout(1500);
    const returned = RETURNS[mode] ?? RETURNS.payment;
    if (expect === 'declined') {
      await pay.click();
      const err = page.locator('text=/declined|refus|insufficient|expired|invalid/i').first();
      await err.waitFor({ timeout: 60_000 });
      await shot('declined');
      const text = (await err.textContent())?.trim() ?? '';
      return { outcome: 'declined', url: page.url(), text, shots };
    }
    let done = false;
    let challengeShown = false;
    for (let attempt = 1; attempt <= 3 && !done; attempt += 1) {
      await pay.scrollIntoViewIfNeeded().catch(() => {});
      // A Pay button already busy ("Processing", disabled) refuses the click; that is not a failure of the page.
      await pay.click({ timeout: 10_000 }).catch(() => {});
      if (expect === '3ds') {
        // Stripe's test challenge is an iframe with a Complete button, shown
        // after a card-brand splash: wait for the button to be visible.
        const frame = await waitForChallengeFrame(page, 30_000);
        if (frame) {
          challengeShown = true;
          const complete = frame.getByRole('button', { name: /complete|authorize|confirm/i }).first();
          await complete.waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {});
          await shot(`challenge-${attempt}`);
          await complete.click({ timeout: 15_000 }).catch(() => {});
        }
      }
      try {
        await page.waitForURL(returned, { timeout: 45_000 });
        done = true;
      } catch {
        await shot(`after-pay-${attempt}`);
        const said = await alertText();
        if (said && !/processing/i.test(said)) return { outcome: 'declined', url: page.url(), text: said, shots };
        await page.waitForTimeout(1500);
      }
    }
    if (!done) throw new Error(`the page did not reach ${returned} after three attempts and showed no error`);
    await shot('done');
    return { outcome: 'paid', url: page.url(), text: '', shots, challengeShown };
  } catch (err) {
    await shot('failed');
    throw new Error(`Checkout (${label}): ${err?.message ?? err}; screenshots ${shots.join(', ')}`);
  } finally {
    await context.close();
  }
}

async function waitForChallengeFrame(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      const btn = frame.getByRole('button', { name: /complete|authorize|confirm/i });
      if (await btn.count().catch(() => 0)) return frame;
    }
    await page.waitForTimeout(500);
  }
  return null;
}
