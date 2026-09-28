// A tool sign-in through the hub's password form with NO hub session must land every time. Before
// the hub's login page navigated once (hub PR #29, 28 September 2026), the page and the sign-in
// library's redirect plugin both sent the browser to the tool's callback, 1 to 5 ms apart, and the
// tool refused the second request: about two runs in three ended on /login?error=state_mismatch or
// oauth_code_verification_failed (the end-to-end report of 28 September 2026, finding 2).
// Needs a running pair (playwright.pair.config.ts says which variables); PW_PAIR_SIGNIN_RUNS sets the
// number of runs (5 by default, 10 for a measure).
import { expect, test } from '@playwright/test';

const HUB = process.env.PW_PAIR_HUB;
const SL = process.env.PW_PAIR_SL;
const PERSON = process.env.PW_PAIR_PERSON_A ?? 'jonas.peeters@example.com';
const PASSWORD = process.env.PW_PAIR_PERSON_A_PASSWORD;
const RUNS = Number(process.env.PW_PAIR_SIGNIN_RUNS ?? '5');

test.skip(!HUB || !SL || !PASSWORD, 'PW_PAIR_HUB, PW_PAIR_SL and PW_PAIR_PERSON_A_PASSWORD name the pair');

test(`a tool sign-in with no hub session lands ${RUNS} times out of ${RUNS}`, async ({ browser }) => {
  test.setTimeout(RUNS * 60_000);
  for (let run = 1; run <= RUNS; run++) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const callbacks: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/api/v1/auth/oauth2/callback/')) callbacks.push(r.url());
    });
    await page.goto(`${SL}/login`);
    await page
      .getByRole('button', { name: /antasphere/i })
      .first()
      .click();
    await page.waitForURL((u) => u.origin === new URL(HUB!).origin);
    await page.getByLabel(/email/i).first().fill(PERSON);
    await page
      .getByLabel(/password/i)
      .first()
      .fill(PASSWORD!);
    await page
      .getByRole('button', { name: /^(sign in|continue|log in)$/i })
      .first()
      .click();
    await page.waitForURL((u) => u.origin === new URL(SL!).origin && !u.pathname.startsWith('/login'), {
      timeout: 30_000
    });
    expect(callbacks, `run ${run}: one callback request`).toHaveLength(1);
    const me = await context.request.get(`${SL}/api/v1/me`, { headers: { origin: SL! } });
    expect(me.status(), `run ${run}: signed in`).toBe(200);
    await context.close();
    // The sign-in library's own wall on both sides: three `/sign-in*` calls per
    // ten seconds per address, and every refusal it makes also costs one of the
    // tool's ten failures per fifteen minutes. Eleven seconds between runs keeps
    // every window at one call.
    if (run < RUNS) await new Promise((done) => setTimeout(done, 11_000));
  }
});
