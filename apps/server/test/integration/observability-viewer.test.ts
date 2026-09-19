import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDatabase, createTestApp, startPostgres, type TestApp } from './helpers.js';

/**
 * M5, the viewer leg of the metrics pin (PRIV-1). Split out of
 * observability.test.ts when that file became part of the chassis suite
 * (`packages/chassis-server/test/integration`): the `/v/:secret` route is the
 * deck viewer's, so this `it` stays with the app. Same fixture the original
 * ran on: an instance booted with a METRICS_TOKEN.
 */

let container: StartedPostgreSqlContainer;
let app: TestApp;

beforeAll(async () => {
  container = await startPostgres();
  app = await createTestApp(await createDatabase(container, 'obs_viewer'), {
    METRICS_TOKEN: 'obs-metrics-token'
  });
});

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

describe('metrics', () => {
  it('labels viewer traffic with the route pattern, never the share secret (PRIV-1)', async () => {
    const secret = 'Zq7-LIVE-SHARE-SECRET-metrics';
    await app.app.request(`/v/${secret}`);
    const res = await app.app.request('/metrics', {
      headers: { authorization: 'Bearer obs-metrics-token' }
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('/v/:secret');
    expect(body).not.toContain(secret);
  });
});
