// Desk screenshots of the local dev stack as the owner, one sign-in for the whole batch, the
// sibling of shot.phone.mjs. usage (from apps/dashboard):
//   node e2e/shot.desk.mjs <out-dir> <path>=<name> [<path>=<name> …] [--base http://localhost:5200]
//     [--width 1440] [--height 900] [--fold Apps=<name>] [--full]
// `--fold Apps=<name>` opens the rail's fold beside the entry named Apps on the overview and shoots it.
import { chromium } from '@playwright/test';
const [, , outDir, ...rest] = process.argv;
const opt = (k, d) => {
  const i = rest.indexOf(k);
  return i >= 0 ? rest[i + 1] : d;
};
const base = opt('--base', 'http://localhost:5200');
const width = Number(opt('--width', 1440));
const height = Number(opt('--height', 900));
const flags = new Set(['--base', '--width', '--height', '--fold', '--settle']);
const shots = rest.filter((a, i) => a.includes('=') && !flags.has(rest[i - 1]) && !a.startsWith('--'));
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`${page.url()}: ${m.text()}`);
});
await page.goto(base + '/login');
await page.getByRole('textbox', { name: 'Email' }).fill('romain@antasphere.com');
await page.getByRole('textbox', { name: 'Password' }).fill('devpassword123');
await page.getByRole('button', { name: 'Sign in' }).click();
await page.waitForURL((u) => !u.pathname.startsWith('/login'));
const settle = Number(opt('--settle', 1400));
async function open(path) {
  await page.goto(base + path);
  await page
    .locator('h1, h2')
    .first()
    .waitFor({ timeout: 20_000 })
    .catch(() => {});
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(settle);
}
for (const shot of shots) {
  const [path, name] = shot.split('=');
  await open(path);
  await page.screenshot({ path: `${outDir}/${name}.png`, fullPage: rest.includes('--full') });
  console.log('saved', `${outDir}/${name}.png`);
}
const fold = opt('--fold', '');
if (fold) {
  const [entry, name] = fold.split('=');
  await open('/');
  // the chevron beside the entry (Sidebar.MenuAction, labelled with the entry's title)
  const toggle = page.locator(`[data-sidebar="sidebar"] [aria-expanded][aria-label="${entry}"]`).first();
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${outDir}/${name}.png` });
  console.log('saved', `${outDir}/${name}.png`);
}
await browser.close();
if (errors.length) console.log(`console errors: ${errors.join(' | ')}`);
