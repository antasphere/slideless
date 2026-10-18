import { test, expect, type Page } from '@playwright/test';
import { INSTANCE_NAME, INVITEE, OWNER } from './accounts';

/**
 * One end-to-end pass over a FRESH instance (empty database):
 * setup wizard → app → API key (secret shown once) → invitation (copyable
 * link) → invite acceptance in a second, cookie-less context → audit trail →
 * deep-link cold load → the Apps page → sign out → sign back in → consent
 * page fail-closed check. (The full OAuth dance is covered by server
 * integration tests.)
 *
 * The workspace's administration is not in the rail (PRDCT-3437, the tool
 * template's DESIGN.md, "The rail"): People, API keys, Files and the Audit log
 * are tabs of the one Settings section, reached from the rail's Settings entry
 * and the section's bar (`nav[data-section-bar]`); People holds its own second
 * bar (SubTabs, a nav named People) for Members, Teams and Invitations. Each of
 * those pages names the section on its band (h1 Settings) and itself in an h2
 * for assistive technology.
 *
 * The owner account it creates is reused by the `decks` project
 * (decks.spec.ts), which depends on this one.
 */

/** The rail (the desk sidebar): where the sections are opened. */
function rail(page: Page) {
  return page.locator('[data-sidebar="sidebar"]');
}

/** The Settings section's bar: its tabs (People, API keys, Files, the Audit log, …). */
function sectionBar(page: Page) {
  return page.locator('nav[data-section-bar]');
}

test('fresh instance: setup → key → invite → audit → re-login', async ({ page, browser, request }) => {
  await test.step('health endpoint answers', async () => {
    const res = await request.get('/healthz');
    expect(res.status()).toBe(200);
  });

  await test.step('first boot lands on the setup wizard', async () => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/setup$/);
    await page.getByLabel('Instance name').fill(INSTANCE_NAME);
    await page.getByLabel('First name').fill(OWNER.firstName);
    await page.getByLabel('Last name').fill(OWNER.lastName);
    await page.getByLabel('Email').fill(OWNER.email);
    await page.getByLabel('Password').fill(OWNER.password);
    // The first-boot claim requires a setup token (PRDCT-1347) and the wizard
    // shows the field from the start (PRDCT-2389). The runner minted the
    // value the stack boots with (playwright.config.ts).
    await page.getByLabel('Setup token').fill(process.env.PW_SMOKE_SETUP_TOKEN ?? '');
    await page.getByRole('button', { name: 'Create instance' }).click();
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible({ timeout: 20_000 });
  });

  await test.step('create an API key and see the secret exactly once', async () => {
    // API keys is a tab of Settings: the rail's Settings entry, then the section's bar.
    await rail(page).getByRole('link', { name: 'Settings', exact: true }).click();
    await expect(page).toHaveURL(/\/settings$/);
    await sectionBar(page).getByRole('link', { name: 'API keys', exact: true }).click();
    await expect(page).toHaveURL(/\/api-keys$/);
    await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'API keys', level: 2 })).toBeAttached();
    await expect(sectionBar(page).getByRole('link', { name: 'API keys', exact: true })).toHaveAttribute(
      'aria-current',
      'page'
    );
    await page.getByRole('button', { name: 'Create key' }).click();
    const dialog = page.getByRole('dialog').filter({ hasText: 'Create API key' });
    await dialog.getByLabel('Name').fill('smoke-key');
    await dialog.getByRole('button', { name: 'Create key' }).click();

    const secretDialog = page.getByRole('dialog').filter({ hasText: 'Copy your API key' });
    await expect(secretDialog.getByText('You will not see this key again')).toBeVisible();
    const secret = await secretDialog.getByLabel('API key secret').inputValue();
    // keyId + secret are base64url: '-' is in the alphabet (\w is not enough).
    expect(secret).toMatch(/^slk_[A-Za-z0-9_-]{8}_[A-Za-z0-9_-]{20,}$/);
    await expect(secretDialog.getByRole('button', { name: 'Copy API key' })).toBeVisible();
    await secretDialog.getByRole('button', { name: 'I saved it' }).click();
    await expect(page.getByRole('cell', { name: 'smoke-key' })).toBeVisible();
  });

  let inviteUrl = '';
  await test.step('create an invitation and get the copyable link', async () => {
    // Invitations are a tab of the people section (PRDCT-2436), itself a tab of
    // Settings: People in the section's bar, then Invitations in People's own bar.
    await sectionBar(page).getByRole('link', { name: 'People', exact: true }).click();
    await expect(page).toHaveURL(/\/members$/);
    const people = page.getByRole('navigation', { name: 'People', exact: true });
    await expect(people.getByRole('link')).toHaveText(['Members', 'Teams', 'Invitations']);
    await people.getByRole('link', { name: 'Invitations', exact: true }).click();
    await expect(page).toHaveURL(/\/invitations$/);
    await expect(page.getByRole('heading', { name: 'Invitations', level: 2 })).toBeAttached();
    await expect(people.getByRole('link', { name: 'Invitations', exact: true })).toHaveAttribute(
      'aria-current',
      'page'
    );
    // People stays lit in the section's bar on all three of its pages
    await expect(sectionBar(page).getByRole('link', { name: 'People', exact: true })).toHaveAttribute(
      'aria-current',
      'page'
    );
    await page.getByRole('button', { name: 'Invite member' }).click();
    const dialog = page.getByRole('dialog').filter({ hasText: 'Invite a member' });
    await dialog.getByLabel('Email').fill(INVITEE.email);
    await dialog.getByRole('button', { name: 'Create invitation' }).click();

    const linkDialog = page.getByRole('dialog').filter({ hasText: 'Invitation created' });
    await expect(linkDialog.getByText('Invitation created')).toBeVisible();
    // getByLabel would also match the "Copy invitation link" button (strict
    // mode violation on the substring) — target the textbox role exactly.
    inviteUrl = await linkDialog.getByRole('textbox', { name: 'Invitation link' }).inputValue();
    expect(inviteUrl).toContain('/invite/');
    await expect(linkDialog.getByRole('button', { name: 'Copy invitation link' })).toBeVisible();
    await linkDialog.getByRole('button', { name: 'Done' }).click();
  });

  await test.step('invitee accepts in a clean context and lands in the app', async () => {
    const context = await browser.newContext();
    const invitee = await context.newPage();
    await invitee.goto(inviteUrl);
    await expect(invitee.getByText(`Join ${INSTANCE_NAME}`)).toBeVisible();
    await invitee.getByLabel('First name').fill(INVITEE.firstName);
    await invitee.getByLabel('Last name').fill(INVITEE.lastName);
    await invitee.getByLabel('Choose a password').fill(INVITEE.password);
    await invitee.getByRole('button', { name: 'Create account and join' }).click();
    await expect(invitee.getByRole('heading', { name: 'Overview' })).toBeVisible({ timeout: 20_000 });
    await context.close();
  });

  await test.step('audit log shows the trail', async () => {
    // The Audit log is a tab of Settings too (an owner's and an admin's).
    await sectionBar(page).getByRole('link', { name: 'Audit log', exact: true }).click();
    await expect(page).toHaveURL(/\/audit$/);
    await expect(page.getByRole('heading', { name: 'Audit log', level: 2 })).toBeAttached();
    await expect(page.getByText('apikey.create').first()).toBeVisible();
    await expect(page.getByText('invitation.create').first()).toBeVisible();
    await expect(page.getByText('invitation.accept').first()).toBeVisible();
  });

  await test.step('deep link cold-loads the SPA on /members', async () => {
    await page.goto('/members');
    await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Members', level: 2 })).toBeAttached();
    await expect(page.getByRole('cell', { name: OWNER.email })).toBeVisible();
    await expect(page.getByRole('cell', { name: INVITEE.email })).toBeVisible();
  });

  await test.step('one workspace and creation open: the workspace menu, named after the instance (ADR 014, PRDCT-2444)', async () => {
    // The operator's cap is at its default, so the owner may create another
    // workspace and gets the menu with ONE workspace too. With creation closed
    // the plain instance-name header stays: workspaces.spec.ts pins that side.
    await expect(page.getByTestId('workspace-switcher')).toContainText(INSTANCE_NAME);
  });

  await test.step("the rail's Apps entry opens the Apps page (the tool template's DESIGN.md, §4)", async () => {
    await rail(page).getByRole('link', { name: 'Apps', exact: true }).first().click();
    await expect(page).toHaveURL(/\/apps$/);
    await expect(page.getByRole('heading', { name: 'Apps', level: 1 })).toBeVisible();
    // The stack sets no APPS_FILE and is self-hosted: the list is `source: 'none'`,
    // so the grid holds no card, not even this tool's "You are here" one, and the
    // empty plate names the setting.
    await expect(page.getByTestId('apps-grid')).toBeAttached();
    await expect(page.getByTestId('app-card')).toHaveCount(0);
    await expect(page.getByTestId('app-here')).toHaveCount(0);
    const empty = page.getByTestId('apps-empty');
    await expect(empty).toBeVisible();
    await expect(empty).toContainText('No other app is listed here');
    await expect(empty).toContainText('APPS_FILE');
  });

  await test.step('sign out, then sign back in', async () => {
    await page.getByRole('button', { name: OWNER.name }).click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login$/);

    await page.getByLabel('Email').fill(OWNER.email);
    await page.getByLabel('Password').fill(OWNER.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible({ timeout: 20_000 });
  });

  await test.step('a sign-in from a deep link lands on that page, not the Overview (PRDCT-2693)', async () => {
    await page.getByRole('button', { name: OWNER.name }).click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login$/);

    await page.goto('/account');
    await expect(page).toHaveURL(/\/login\?next=%2Faccount$/);
    // The oss card keeps its greeting (PRDCT-2696 changes the cloud card only).
    await expect(page.getByText('Welcome back')).toBeVisible();
    await page.getByLabel('Email').fill(OWNER.email);
    await page.getByLabel('Password').fill(OWNER.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    // The previous step signed in seconds ago: wait the sign-in throttle out
    // once and retry, as signInAsOwner does, rather than fail on the harness.
    const throttled = await page
      .getByText('Too many attempts')
      .waitFor({ state: 'visible', timeout: 3_000 })
      .then(() => true)
      .catch(() => false);
    if (throttled) {
      await page.waitForTimeout(12_000);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    }
    await expect(page).toHaveURL(/\/account$/, { timeout: 20_000 });
    await expect(page.getByRole('heading', { name: 'My account' })).toBeVisible();
  });

  await test.step('consent page rejects a garbage authorize query', async () => {
    // Cold deep link with an unsigned/expired query — must show the
    // invalid-request card, never an approvable consent screen.
    await page.goto('/oauth/consent?client_id=bogus&redirect_uri=https%3A%2F%2Fexample.com%2Fcb&sig=nope');
    await expect(page.getByText('invalid or expired')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
  });
});

test('language switcher: FR on the login page persists across reload', async ({ page }) => {
  // Runs after the setup test (single worker, in-file order), so /login exists.
  await page.goto('/login');
  await expect(page.getByText('Sign in to your workspace')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');

  // Switch to French from the public-page switcher.
  await page.getByRole('button', { name: 'FR', exact: true }).click();
  await expect(page.getByText('Connectez-vous à votre espace de travail')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');

  // The choice persists across a full reload (localStorage, no cookies).
  await page.reload();
  await expect(page.getByText('Connectez-vous à votre espace de travail')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');

  // And back to English.
  await page.getByRole('button', { name: 'EN', exact: true }).click();
  await expect(page.getByText('Sign in to your workspace')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
});
