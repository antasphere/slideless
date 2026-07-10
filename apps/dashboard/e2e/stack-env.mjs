import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..', '..');
export const COMPOSE_PROJECT = 'pw-smoke';
export const APP_PORT = '3100';

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
    APP_IMAGE: 'codika-platform-template:pw-smoke',
    APP_PORT,
    PUBLIC_BASE_URL: `http://localhost:${APP_PORT}`,
    POSTGRES_PASSWORD: process.env.PW_SMOKE_PG_PASSWORD ?? randomBytes(16).toString('hex'),
    AUTH_SECRET: '',
    SETUP_TOKEN: '',
    EMAIL_DRIVER: 'none'
  };
}
