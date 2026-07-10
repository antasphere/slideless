// THROWAWAY SPIKE harness (branch spike/viewer-origin).
//
// Drives Chromium + WebKit (+ Firefox if installed) against the running app on
// http://localhost:3100. For each engine it:
//   1. establishes a REAL owner session (POST /api/v1/auth/sign-in/email),
//   2. confirms the session works at the API level (GET /api/v1/me → 200),
//   3. loads four viewer surfaces with that live session in the cookie jar and
//      records, from inside the browser, what the hostile deck could reach.
//
// Surfaces:
//   control  — user HTML on app origin, NO sandbox            → expect LEAK
//   sandbox  — CSP: sandbox allow-scripts allow-forms …       → expect BLOCKED
//   same-origin-footgun — CSP: sandbox allow-scripts allow-same-origin → expect LEAK
//   framed   — sandboxed deck inside a sandbox="allow-scripts" iframe → expect BLOCKED
//
// Secrets: OWNER_PASSWORD is read from process.env (sourced indirectly by the
// caller); it is never printed. Cookie VALUES are never printed — only names.
import { createRequire } from 'node:module';
const require = createRequire(new URL('../apps/dashboard/package.json', import.meta.url));
const { chromium, webkit, firefox } = require('@playwright/test');

const BASE = 'http://localhost:3100';
const OWNER_EMAIL = process.env.OWNER_EMAIL || 'dev@slideless.local';
const OWNER_PASSWORD = process.env.OWNER_PASSWORD;
if (!OWNER_PASSWORD) {
  console.error('OWNER_PASSWORD not set in env — aborting');
  process.exit(2);
}

const SURFACES = [
  { name: 'control', url: `${BASE}/spike/viewer/control`, framed: false },
  { name: 'sandbox', url: `${BASE}/spike/viewer/deck?tokens=${encodeURIComponent('allow-scripts allow-forms allow-popups')}`, framed: false },
  { name: 'same-origin-footgun', url: `${BASE}/spike/viewer/deck?tokens=${encodeURIComponent('allow-scripts allow-same-origin')}`, framed: false },
  { name: 'framed', url: `${BASE}/spike/viewer/framed?tokens=allow-scripts`, framed: true }
];

async function loadSurface(context, surface) {
  const page = await context.newPage();
  const consoleLines = [];
  const meResponses = [];
  const meRequests = [];
  page.on('console', (m) => { const t = m.text(); if (t.includes('[SPIKE]')) consoleLines.push(t); });
  page.on('response', (r) => { if (r.url().includes('/api/v1/me')) meResponses.push({ status: r.status() }); });
  page.on('request', (r) => {
    if (r.url().includes('/api/v1/me')) {
      // Names only — never the cookie value.
      r.allHeaders().then((h) => meRequests.push({ cookieHeaderSent: Object.prototype.hasOwnProperty.call(h, 'cookie') })).catch(() => {});
    }
  });

  let topUrlAfter = null;
  let report = null;
  let err = null;
  try {
    await page.goto(surface.url, { waitUntil: 'load', timeout: 15000 });
    const target = surface.framed
      ? (await waitForDeckFrame(page))
      : page;
    await target.waitForSelector('html[data-done="1"]', { timeout: 15000 });
    const outText = await target.locator('#out').innerText();
    report = JSON.parse(outText);
    // Did a top-frame navigation succeed? (framed only)
    topUrlAfter = page.url();
  } catch (e) {
    err = e.message;
    try { report = JSON.parse(await page.locator('#out').innerText()); } catch { /* ignore */ }
  }
  await page.close();
  return { surface: surface.name, report, err, meResponses, meRequests, topUrlAfter, consoleCount: consoleLines.length };
}

async function waitForDeckFrame(page) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const f = page.frames().find((fr) => fr.url().includes('/spike/viewer/deck'));
    if (f) return f;
    await page.waitForTimeout(200);
  }
  throw new Error('deck iframe never appeared');
}

async function runEngine(name, launcher) {
  const result = { engine: name, launched: false };
  let browser;
  try {
    browser = await launcher.launch({ headless: true });
  } catch (e) {
    result.launchError = e.message.split('\n')[0];
    return result;
  }
  result.launched = true;
  const context = await browser.newContext();

  // 1. Establish a real owner session.
  const login = await context.request.post(`${BASE}/api/v1/auth/sign-in/email`, {
    data: { email: OWNER_EMAIL, password: OWNER_PASSWORD }
  });
  result.loginStatus = login.status();
  const cookies = await context.cookies();
  result.cookieNames = cookies.map((c) => ({ name: c.name, httpOnly: c.httpOnly, sameSite: c.sameSite, secure: c.secure }));

  // 2. Confirm the session works at the API level (context request = same jar).
  const meCheck = await context.request.get(`${BASE}/api/v1/me`);
  result.apiMeStatus = meCheck.status();
  try {
    const body = await meCheck.json();
    result.apiMeOwnerEmail = body?.user?.email ?? null;
  } catch { result.apiMeOwnerEmail = null; }

  // 3. Load each viewer surface with the live session present.
  result.surfaces = [];
  for (const s of SURFACES) {
    result.surfaces.push(await loadSurface(context, s));
  }

  await context.close();
  await browser.close();
  return result;
}

const engines = [
  ['chromium', chromium],
  ['webkit', webkit],
  ['firefox', firefox]
];

const out = { base: BASE, ownerEmail: OWNER_EMAIL, engines: [] };
for (const [name, launcher] of engines) {
  out.engines.push(await runEngine(name, launcher));
}
console.log('SPIKE_RESULTS_JSON_BEGIN');
console.log(JSON.stringify(out, null, 2));
console.log('SPIKE_RESULTS_JSON_END');
