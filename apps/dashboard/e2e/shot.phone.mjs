// Phone screenshots of the local dev stack as the owner: a page, then the drawer open, then
// a tap on a drawer entry. usage (from apps/dashboard):
//   node e2e/shot.phone.mjs <path> <out-prefix> [--base http://localhost:5200] [--drawer] [--tap "Settings"] [--full]
import { chromium } from '@playwright/test';
const [, , path, out, ...rest] = process.argv;
const opt = (k, d) => {
  const i = rest.indexOf(k);
  return i >= 0 ? rest[i + 1] : d;
};
const base = opt('--base', 'http://localhost:5200');
const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true
});
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
await page.goto(base + '/login');
await page.getByRole('textbox', { name: 'Email' }).fill('romain@antasphere.com');
await page.getByRole('textbox', { name: 'Password' }).fill('devpassword123');
await page.getByRole('button', { name: 'Sign in' }).click();
await page.waitForURL((u) => !u.pathname.startsWith('/login'));
await page.goto(base + path);
await page
  .locator('h1, h2')
  .first()
  .waitFor({ timeout: 20_000 })
  .catch(() => {});
await page.waitForLoadState('networkidle').catch(() => {});
await page.waitForTimeout(Number(opt('--settle', 1200)));
await page.screenshot({ path: `${out}.png`, fullPage: rest.includes('--full') });
if (rest.includes('--drawer')) {
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Menu' })
    .click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${out}-drawer.png` });
  const tap = opt('--tap', '');
  if (tap) {
    await page.getByRole('dialog').getByRole('link', { name: tap, exact: true }).click();
    await page.waitForTimeout(900);
    await page.screenshot({ path: `${out}-after-tap.png` });
    console.log('after tap:', page.url(), 'dialogs:', await page.getByRole('dialog').count());
  }
}
await browser.close();
console.log('saved', out, errors.length ? `console errors: ${errors.join(' | ')}` : '');
