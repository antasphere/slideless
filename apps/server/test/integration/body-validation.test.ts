import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  createDatabase,
  createTestApp,
  extractCookie,
  readJson,
  startPostgres,
  type TestApp
} from './helpers.js';

/**
 * Release-gate regression — malformed/empty JSON bodies must answer 400,
 * never 500.
 *
 * BEFORE: hono's json-body validator throws HTTPException(400) on an
 * unparseable body BEFORE zod runs; the zod-openapi defaultHook only handles
 * result.success === false, so the exception fell through to app.onError →
 * 500 {"error":{"code":"internal"}} + an error-level log. Pre-auth reachable
 * (/setup, /cli/auth/request, /invitations/accept) → log-noise amplifier.
 * Separately, a body route called WITHOUT a JSON content-type skipped
 * validation entirely and handed the handler `{}` → TypeError → another 500.
 *
 * NOW: a guard middleware at the top of the api app maps the framework's
 * body-parse 400s to the wire shape (stable code `invalid_json`), and every
 * contract request body is `required` so the no-content-type case hits the
 * schema (→ 400 validation_error) instead of the handler.
 */

const OWNER = { email: 'owner@bodyval.test', name: 'Body Owner', password: 'bodyval-owner-pass-1' };

let container: StartedPostgreSqlContainer;
let app: TestApp;
let cookie: string;

// Pre-auth routes ride tight per-IP walls; TRUST_PROXY=true in tests, so
// every request carries a fresh forwarded address.
let ipCounter = 0;
const nextIp = () => `10.97.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

const post = (path: string, body: string | undefined, headers: Record<string, string> = {}) =>
  app.app.request(path, {
    method: 'POST',
    headers: { 'x-forwarded-for': nextIp(), ...headers },
    ...(body !== undefined ? { body } : {})
  });

const JSON_CT = { 'content-type': 'application/json' };

beforeAll(async () => {
  container = await startPostgres();
  app = await createTestApp(await createDatabase(container, 'body_validation'));
  const setup = await post(
    '/api/v1/setup',
    JSON.stringify({ setupToken: 'integration-test-setup-token', instanceName: 'BodyVal', owner: OWNER }),
    JSON_CT
  );
  expect(setup.status).toBe(201);
  const signIn = await post(
    '/api/v1/auth/sign-in/email',
    JSON.stringify({ email: OWNER.email, password: OWNER.password }),
    JSON_CT
  );
  cookie = extractCookie(signIn);
}, 120_000);

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

describe('malformed JSON answers 400 invalid_json (never 500)', () => {
  it('authed body route: POST /presentations/precheck with a truncated body', async () => {
    const res = await post('/api/v1/presentations/precheck', '{', { ...JSON_CT, cookie });
    expect(res.status).toBe(400);
    expect((await readJson(res)).error.code).toBe('invalid_json');
  });

  it('authed body route: empty body under a JSON content-type', async () => {
    const res = await post('/api/v1/presentations/precheck', '', { ...JSON_CT, cookie });
    expect(res.status).toBe(400);
    expect((await readJson(res)).error.code).toBe('invalid_json');
  });

  it('PRE-AUTH route: POST /cli/auth/request with garbage (the log-noise amplifier)', async () => {
    const res = await post('/api/v1/cli/auth/request', '{"email": "x@y.z"', JSON_CT);
    expect(res.status).toBe(400);
    expect((await readJson(res)).error.code).toBe('invalid_json');
  });

  it('PRE-AUTH route: POST /invitations/accept with a bare brace', async () => {
    const res = await post('/api/v1/invitations/accept', '{', JSON_CT);
    expect(res.status).toBe(400);
    expect((await readJson(res)).error.code).toBe('invalid_json');
  });

  it('PRE-AUTH route: POST /setup with an empty JSON body (already-set-up instance still 400s first)', async () => {
    const res = await post('/api/v1/setup', '', JSON_CT);
    expect(res.status).toBe(400);
    expect((await readJson(res)).error.code).toBe('invalid_json');
  });
});

describe('missing body / missing content-type hits the schema, not the handler', () => {
  it('POST /setup with no body and no content-type → 400 validation_error (was a handler TypeError → 500)', async () => {
    const res = await post('/api/v1/setup', undefined);
    expect(res.status).toBe(400);
    expect((await readJson(res)).error.code).toBe('validation_error');
  });

  it('POST /presentations/precheck with a JSON body under text/plain → 400 validation_error', async () => {
    const res = await post('/api/v1/presentations/precheck', JSON.stringify({ sha256: ['a'.repeat(64)] }), {
      'content-type': 'text/plain',
      cookie
    });
    expect(res.status).toBe(400);
    expect((await readJson(res)).error.code).toBe('validation_error');
  });
});

describe('the schema-mismatch and happy paths are untouched', () => {
  it('valid JSON, wrong schema → 400 validation_error with zod issues', async () => {
    const res = await post('/api/v1/presentations/precheck', JSON.stringify({ nope: true }), {
      ...JSON_CT,
      cookie
    });
    expect(res.status).toBe(400);
    const body = await readJson(res);
    expect(body.error.code).toBe('validation_error');
    expect(Array.isArray(body.error.details)).toBe(true);
  });

  it('well-formed precheck still answers 200 with the missing list', async () => {
    const sha = 'b'.repeat(64);
    const res = await post('/api/v1/presentations/precheck', JSON.stringify({ sha256: [sha] }), {
      ...JSON_CT,
      cookie
    });
    expect(res.status).toBe(200);
    expect((await readJson(res)).missing).toEqual([sha]);
  });

  it('malformed multipart on the asset route → 400 (never 500)', async () => {
    const res = await post('/api/v1/presentations/assets', 'not-multipart', {
      'content-type': 'multipart/form-data; boundary=deadbeef',
      cookie
    });
    expect(res.status).toBe(400);
    expect((await readJson(res)).error.code).toBe('invalid_body');
  });
});
