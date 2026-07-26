import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { pino } from 'pino';
import { requestId } from '../../src/middleware/request-id.js';

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
