import { defineConfig } from '@playwright/test';

/**
 * The browser suite that needs a PAIR: this instance on `EDITION=cloud` behind
 * a running Antasphere hub. Nothing is booted here (the federation harness,
 * `docker-compose.federation.yml`, or any live pair is the stack); the suite
 * reads where the pair is from the environment and skips itself when it is
 * not told:
 *
 *   PW_PAIR_HUB             the hub's public base URL (http://hub.ant.localhost:6601)
 *   PW_PAIR_SL              this instance's public base URL (http://slideless.ant.localhost:6610)
 *   PW_PAIR_OWNER_EMAIL     an owner of the hub organization below, with a password
 *   PW_PAIR_OWNER_PASSWORD  its password (never printed)
 *   PW_PAIR_ORG             the hub organization's name (the demo people are its members)
 *   PW_PAIR_TOOL            the tool's registry slug (default slideless-cloud)
 *   PW_PAIR_PERSON_A / _B   two demo-eligible members of that organization (example or test addresses)
 *
 *   PW_PAIR_HUB=… PW_PAIR_SL=… pnpm --filter @slideless/dashboard test:e2e:pair
 *
 * Kept apart from `playwright.config.ts`, whose `webServer` boots the
 * self-hosted stack the main suite runs on.
 */
export default defineConfig({
  testDir: './e2e/pair',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' }
});
