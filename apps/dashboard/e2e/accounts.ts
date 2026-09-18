import { expect, type Page } from '@playwright/test';

/**
 * Accounts shared across the e2e projects: `smoke` runs first against the
 * fresh database and creates the instance + owner through the setup wizard;
 * `decks` (dependencies: ['smoke']) signs in as that same owner.
 */
export const INSTANCE_NAME = 'Smoke Test Instance';
// The account forms ask for a first and a last name and send them joined as
// the one `name` the API takes, so `name` stays what the app shows.
export const OWNER = {
  firstName: 'Owner',
  lastName: 'One',
  name: 'Owner One',
  email: 'owner@example.com',
  password: 'owner-password-123'
};
export const INVITEE = {
  firstName: 'Invited',
  lastName: 'Member',
  name: 'Invited Member',
  email: 'invitee@example.com',
  password: 'invitee-password-123'
};

/**
 * Sign in as the owner through the login page. The sign-in throttle answers
 * "Too many attempts" when a project signs in right after the smoke's own
 * logins (the projects run back to back, one worker); wait the window out
 * once and retry rather than fail on the harness.
 */
export async function signInAsOwner(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(OWNER.email);
  await page.getByLabel('Password').fill(OWNER.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  // isVisible() does not wait, and the refusal lands a beat after the click.
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
