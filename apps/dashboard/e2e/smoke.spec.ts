import { test, expect } from '@playwright/test';
import { INSTANCE_NAME, INVITEE, OWNER } from './accounts';

/**
 * One end-to-end pass over a FRESH instance (empty database):
 * setup wizard → app → API key (secret shown once) → invitation (copyable
 * link) → invite acceptance in a second, cookie-less context → audit trail →
 * deep-link cold load → sign out → sign back in → consent page fail-closed
 * check. (The full OAuth dance is covered by server integration tests.)
 *
 * The owner account it creates is reused by the `decks` project
 * (decks.spec.ts), which depends on this one.
 */

test('fresh instance: setup → key → invite → audit → re-login', async ({ page, browser, request }) => {
  await test.step('health endpoint answers', async () => {
    const res = await request.get('/healthz');
    expect(res.status()).toBe(200);
  });

  await test.step('first boot lands on the setup wizard', async () => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/setup$/);
    await page.getByLabel('Instance name').fill(INSTANCE_NAME);
    await page.getByLabel('Your name').fill(OWNER.name);
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
    await page.getByRole('link', { name: 'API keys', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'API keys' })).toBeVisible();
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
    // Invitations are a tab of the people section (PRDCT-2436), not a sidebar entry.
    await page.getByRole('link', { name: 'People', exact: true }).click();
    await page.getByRole('link', { name: 'Invitations', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Invitations' })).toBeVisible();
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
    await invitee.getByLabel('Your name').fill(INVITEE.name);
    await invitee.getByLabel('Choose a password').fill(INVITEE.password);
    await invitee.getByRole('button', { name: 'Create account and join' }).click();
    await expect(invitee.getByRole('heading', { name: 'Overview' })).toBeVisible({ timeout: 20_000 });
    await context.close();
  });

  await test.step('audit log shows the trail', async () => {
    await page.getByRole('link', { name: 'Audit log' }).click();
    await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible();
    await expect(page.getByText('apikey.create').first()).toBeVisible();
    await expect(page.getByText('invitation.create').first()).toBeVisible();
    await expect(page.getByText('invitation.accept').first()).toBeVisible();
  });

  await test.step('deep link cold-loads the SPA on /members', async () => {
    await page.goto('/members');
    await expect(page.getByRole('heading', { name: 'Members' })).toBeVisible();
    await expect(page.getByRole('cell', { name: OWNER.email })).toBeVisible();
    await expect(page.getByRole('cell', { name: INVITEE.email })).toBeVisible();
  });

  await test.step('no workspace switcher for a single-membership user (ADR 014)', async () => {
    // Self-host UX invariant: the sidebar keeps the plain instance-name
    // header; the switcher only exists with several active memberships.
    await expect(page.getByTestId('workspace-switcher')).toHaveCount(0);
    await expect(
      page.locator('[data-sidebar="sidebar"]').getByText(INSTANCE_NAME, { exact: true })
    ).toBeVisible();
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
