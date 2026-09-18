import { randomBytes } from 'node:crypto';
import { defineConfig } from '@playwright/test';

// The first-boot claim requires a setup token (PRDCT-1347). One value is
// minted here, in the runner process, so the compose stack (webServer
// inherits this env) and the smoke spec (workers inherit it too) agree.
process.env.PW_SMOKE_SETUP_TOKEN ??= randomBytes(16).toString('hex');

// Keep in lockstep with e2e/stack-env.mjs (this config cannot import the
// .mjs): the port is overridable so the suite can run beside another
// instance of the product already holding 3100.
const APP_PORT = process.env.PW_SMOKE_PORT ?? '3100';

/**
 * Smoke suite against the REAL stack: the docker compose file at the repo
 * root, built fresh, on an isolated compose project (pw-smoke) with its own
 * volumes and a random Postgres password. start-stack.mjs owns the lifecycle;
 * global-teardown.mjs runs `compose down -v` so every run starts from an
 * empty database (the /setup wizard is part of the spec).
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  globalTeardown: './e2e/global-teardown.mjs',
  // Explicit ordering: smoke sets up the fresh instance (setup wizard) and
  // creates the owner; the decks product suite signs in as that owner.
  projects: [
    { name: 'smoke', testMatch: /smoke\.spec\.ts/ },
    { name: 'decks', testMatch: /decks\.spec\.ts/, dependencies: ['smoke'] },
    // PRDCT-2279: the deck's master page, opened through the contract's path.
    { name: 'master', testMatch: /master\.spec\.ts/, dependencies: ['smoke'] },
    { name: 'viewer', testMatch: /viewer-annotations\.spec\.ts/, dependencies: ['smoke'] },
    { name: 'embed', testMatch: /embed\.spec\.ts/, dependencies: ['smoke'] },
    { name: 'forms', testMatch: /viewer-forms\.spec\.ts/, dependencies: ['smoke'] },
    // The habitat suite (PRDCT-1334): the runtime inside real slide decks.
    {
      name: 'forms-realdeck',
      testMatch: /viewer-forms-realdeck\.spec\.ts/,
      dependencies: ['smoke']
    },
    { name: 'embed-forms', testMatch: /embed-forms\.spec\.ts/, dependencies: ['smoke'] },
    // PRDCT-2403: a form's file field, the drop panel inside a deck with its own handlers.
    { name: 'forms-files', testMatch: /viewer-forms-files\.spec\.ts/, dependencies: ['smoke'] },
    // PRDCT-2268: windows a deck opens escape the sandbox; the deck does not.
    { name: 'viewer-popups', testMatch: /viewer-popups\.spec\.ts/, dependencies: ['smoke'] },
    // PRDCT-2281 (lane D): the recipient bar over a shared deck.
    { name: 'viewer-topbar', testMatch: /viewer-topbar\.spec\.ts/, dependencies: ['smoke'] },
    // PRDCT-2444 / PRDCT-2443 / PRDCT-2426: a workspace created from the sidebar,
    // and every dashboard download from that NON-default workspace. Declared
    // LAST on purpose: the projects run in declaration order (one worker), and
    // this one leaves the owner with a second workspace, which no other project
    // has to know about. It depends on `smoke` alone: depending on every project
    // makes Playwright schedule them in reverse, and `decks` needs to run before
    // the projects that leave a deck behind.
    { name: 'workspaces', testMatch: /workspaces\.spec\.ts/, dependencies: ['smoke'] }
  ],
  use: {
    baseURL: `http://localhost:${APP_PORT}`,
    trace: 'retain-on-failure'
  },
  webServer: {
    command: 'node e2e/start-stack.mjs',
    url: `http://localhost:${APP_PORT}/readyz`,
    // First run builds the docker image — give it room.
    timeout: 600_000,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe'
  }
});
