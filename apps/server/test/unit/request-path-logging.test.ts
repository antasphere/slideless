import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { pino } from 'pino';
import { requestId } from '@antasphere/chassis-server/middleware';

/**
 * PRIV-1, and on THIS repo it is not hypothetical — it is the active
 * critical. The public share-link viewer is literally `/v/:secret`, so the
 * old `path: c.req.path` wrote every live share capability into the log
 * stream (and, via the OTel span attribute, into whatever trace backend the
 * operator points at). Redaction cannot help: pino keys off object
 * PROPERTIES and `path` is one opaque string.
 *
 * The completion log line must therefore carry the MATCHED ROUTE PATTERN.
 */
function appWithCapturedLogs() {
  const lines: Array<Record<string, unknown>> = [];
  const logger = pino(
    { level: 'info' },
    {
      write: (chunk: string) => {
        lines.push(JSON.parse(chunk) as Record<string, unknown>);
      }
    }
  );
  const app = new Hono();
  app.use('*', requestId(logger));
  app.get('/v/:secret', (c) => c.text('ok'));
  app.get('/v/:secret/*', (c) => c.text('ok'));
  app.get('/orgs/:orgId/members/:memberId', (c) => c.text('ok'));
  return { app, lines };
}

describe('request completion logging', () => {
  it('logs the route pattern, not the LIVE SHARE SECRET in the viewer path', async () => {
    const { app, lines } = appWithCapturedLogs();
    await app.request('/v/s3cr3t-share-token');
    const line = lines.find((l) => l.msg === 'request');
    expect(line).toBeDefined();
    expect(line?.path).toBe('/v/:secret');
    expect(JSON.stringify(line)).not.toContain('s3cr3t-share-token');
  });

  it('templates the viewer sub-path route too (/v/:secret/*)', async () => {
    const { app, lines } = appWithCapturedLogs();
    await app.request('/v/s3cr3t-share-token/slides/3.html');
    const line = lines.find((l) => l.msg === 'request');
    expect(line?.path).toBe('/v/:secret/*');
    expect(JSON.stringify(line)).not.toContain('s3cr3t-share-token');
  });

  it('keeps every dynamic segment templated', async () => {
    const { app, lines } = appWithCapturedLogs();
    await app.request('/orgs/11111111-2222-3333-4444-555555555555/members/deadbeef');
    const line = lines.find((l) => l.msg === 'request');
    expect(line?.path).toBe('/orgs/:orgId/members/:memberId');
    expect(JSON.stringify(line)).not.toContain('deadbeef');
  });

  it('reports an unmatched request without echoing the probed URL', async () => {
    const { app, lines } = appWithCapturedLogs();
    await app.request('/does-not-exist/?token=leaked-value');
    const line = lines.find((l) => l.msg === 'request');
    // Hono reports the wildcard for a non-match; either way the probed URL
    // (and the token riding it) never reaches the log stream.
    expect(line?.path).toBe('/*');
    expect(JSON.stringify(line)).not.toContain('does-not-exist');
    expect(JSON.stringify(line)).not.toContain('leaked-value');
  });

  it('still records method, status and latency', async () => {
    const { app, lines } = appWithCapturedLogs();
    await app.request('/v/abc');
    const line = lines.find((l) => l.msg === 'request');
    expect(line?.method).toBe('GET');
    expect(line?.status).toBe(200);
    expect(typeof line?.latencyMs).toBe('number');
  });
});

/**
 * The block above pins `requestId` against a SYNTHETIC root app whose viewer
 * routes are declared inline. The real app composes a SEPARATE Hono sub-app
 * (`app.route('/', viewer)` in app.ts, patterns from viewer/routes.ts), so the
 * question that actually decides PRIV-1 on this repo is whether
 * `c.req.routePath` survives that composition — if it did not, the middleware
 * would be correct and the deployed app would still log live share secrets.
 * Same class of gap as the PLT-39 / PLT-3 tests that passed while their fixes
 * were broken: assert against the real shape, not an isolated one.
 */
describe('the route label survives the real viewer sub-app composition', () => {
  const SECRET = 'Zq7-LIVE-SHARE-SECRET-abc123';

  function composed() {
    const lines: Array<Record<string, unknown>> = [];
    const logger = pino(
      { level: 'info' },
      { write: (chunk: string) => lines.push(JSON.parse(chunk) as Record<string, unknown>) }
    );
    // Exactly the registrations viewer/routes.ts makes, in its own sub-app.
    const embed = new Hono();
    embed.get('/embed.js', (c) => c.text('//'));
    const viewer = new Hono();
    viewer.route('/', embed);
    viewer.post('/v/:secret', (c) => c.text('ok'));
    viewer.post('/v/:secret/', (c) => c.text('ok'));
    viewer.post('/v/:secret/*', (c) => c.text('ok'));
    viewer.on(['GET', 'HEAD'], '/v/:secret', (c) => c.text('ok'));
    viewer.on(['GET', 'HEAD'], '/v/:secret/', (c) => c.text('ok'));
    viewer.on(['GET', 'HEAD'], '/v/:secret/*', (c) => c.text('ok'));

    const api = new Hono();
    api.post('/viewer/:secret/annotations', (c) => c.json({ ok: true }));

    const app = new Hono();
    app.use('*', requestId(logger));
    app.route('/api/v1', api);
    app.route('/', viewer);
    return { app, lines };
  }

  const probes: ReadonlyArray<readonly [string, string, string]> = [
    ['GET', `/v/${SECRET}`, '/v/:secret'],
    ['GET', `/v/${SECRET}/`, '/v/:secret/'],
    ['GET', `/v/${SECRET}/slides/3.html`, '/v/:secret/*'],
    // HEAD is rewritten to GET before routing (PLT-39) — the pattern must
    // still be what gets logged, not the raw path.
    ['HEAD', `/v/${SECRET}`, '/v/:secret'],
    ['HEAD', `/v/${SECRET}/assets/a.png`, '/v/:secret/*'],
    // The password form posts back to the same capability-bearing URL.
    ['POST', `/v/${SECRET}`, '/v/:secret'],
    ['POST', `/v/${SECRET}/x`, '/v/:secret/*'],
    // The share-token annotation API carries the secret under /api/v1 too.
    ['POST', `/api/v1/viewer/${SECRET}/annotations`, '/api/v1/viewer/:secret/annotations']
  ];

  for (const [method, path, expected] of probes) {
    it(`${method} ${path} logs ${expected}, never the secret`, async () => {
      const { app, lines } = composed();
      await app.request(path, { method });
      const line = lines.find((l) => l.msg === 'request');
      expect(line?.path).toBe(expected);
      expect(JSON.stringify(line)).not.toContain(SECRET);
    });
  }
});
