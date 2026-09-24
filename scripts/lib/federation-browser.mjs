// The browser step of scripts/federation-browser-check.sh (PRDCT-2694): a
// person signs in to cloud Slideless with Antasphere in a real Chromium and is
// still signed in a few seconds later. Playwright comes from the dashboard's
// dev dependencies, so the repo carries no second copy of it.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(REPO, 'apps/dashboard/package.json'));
const { chromium } = require('@playwright/test');

const { SL_URL, OWNER_EMAIL, OWNER_PASSWORD } = process.env;
if (!SL_URL || !OWNER_EMAIL || !OWNER_PASSWORD) throw new Error('SL_URL, OWNER_EMAIL and OWNER_PASSWORD are required');
const HINT = 'ant_sso_hint';
// Long enough for the hint-watch's first check after the dashboard loads,
// which used to sign the session out within the second.
const STAY_MS = 5_000;

const browser = await chromium.launch({ headless: process.env.BROWSER_HEADED !== '1' });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const logouts = [];
  page.on('request', (req) => {
    if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/v1/sso/logout') logouts.push(req.url());
  });

  await page.goto(`${SL_URL}/login`);
  await page.getByRole('button', { name: 'Sign in with Antasphere' }).click();

  // The hub's login page: registry tools skip the consent screen, so the
  // sign-in goes straight back to Slideless.
  await page.waitForURL((url) => url.hostname.startsWith('hub.'), { timeout: 30_000 });
  await page.getByLabel('Email').fill(OWNER_EMAIL);
  await page.getByLabel('Password').fill(OWNER_PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();

  await page.waitForURL((url) => url.origin === SL_URL && !url.pathname.startsWith('/login'), { timeout: 30_000 });
  const hint = (await context.cookies(SL_URL)).find((c) => c.name === HINT);
  if (!hint) throw new Error(`no ${HINT} cookie on ${SL_URL} after the sign-in`);
  console.log(`  PASS signed in; ${HINT} on Domain=${hint.domain}, landed on ${new URL(page.url()).pathname}`);

  await page.waitForTimeout(STAY_MS);
  const now = new URL(page.url());
  if (logouts.length) throw new Error(`the dashboard posted ${logouts.length} sso logout request(s)`);
  if (now.origin !== SL_URL || now.pathname.startsWith('/login')) throw new Error(`signed out: now on ${page.url()}`);
  const me = await page.request.get(`${SL_URL}/api/v1/me`);
  if (!me.ok()) throw new Error(`GET /api/v1/me answered ${me.status()} after the wait`);
  console.log(`  PASS still signed in after ${STAY_MS / 1000} s on ${now.pathname}, no sso logout`);
} finally {
  await browser.close();
}
