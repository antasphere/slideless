import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..', '..');
export const COMPOSE_PROJECT = 'pw-smoke';
// Overridable so the e2e can run beside another instance of the product
// (or the dev stack) already holding the default host port.
export const APP_PORT = process.env.PW_SMOKE_PORT ?? '3100';

export const composeArgs = [
  'compose',
  '-p',
  COMPOSE_PROJECT,
  '-f',
  path.join(REPO_ROOT, 'docker-compose.yml')
];

/** Compose env: isolated image tag, host port, and throwaway credentials. */
export function stackEnv() {
  return {
    ...process.env,
    APP_IMAGE: 'slideless:pw-smoke',
    APP_PORT,
    PUBLIC_BASE_URL: `http://localhost:${APP_PORT}`,
    POSTGRES_PASSWORD: process.env.PW_SMOKE_PG_PASSWORD ?? randomBytes(16).toString('hex'),
    AUTH_SECRET: '',
    // The runner mints this in playwright.config.ts; the smoke presents it.
    SETUP_TOKEN: process.env.PW_SMOKE_SETUP_TOKEN ?? '',
    EMAIL_DRIVER: 'none',
    // The renderer container (PRDCT-2725), built from this checkout, so the
    // master spec sees a real still image. The secret is minted once in
    // playwright.config.ts, so every runner process hands the same one to
    // the app and to the renderer.
    COMPOSE_PROFILES: 'images',
    RENDERER_IMAGE: 'slideless-renderer:pw-smoke',
    SLIDELESS_RENDERER_URL: 'http://renderer:3100',
    SLIDELESS_RENDERER_SECRET: process.env.PW_SMOKE_RENDERER_SECRET ?? randomBytes(16).toString('hex')
  };
}
