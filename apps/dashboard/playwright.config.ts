import { defineConfig } from '@playwright/test';

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
    { name: 'viewer', testMatch: /viewer-annotations\.spec\.ts/, dependencies: ['smoke'] },
    { name: 'embed', testMatch: /embed\.spec\.ts/, dependencies: ['smoke'] }
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
