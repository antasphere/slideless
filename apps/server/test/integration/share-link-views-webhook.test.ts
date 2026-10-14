import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { shareTokenViews, shareTokenViewWindows } from '@slideless/db';
import {
  createDatabase,
  createTestApp,
  extractCookie,
  readJson,
  startPostgres,
  type TestApp
} from './helpers.js';

/**
 * The `share_link.viewed` webhook, grouped per link (PRDCT-3483, Romain's
 * ruling of 13 October 2026): the first counted view of a link goes out at
 * once with `views: 1`, then at most one event per link per window carries
 * the count of the views since and their facts. A view nobody listens to
 * writes no window row and queues nothing; a disabled endpoint listens to
 * nothing; a preview link never emits. The window is shrunk to eight seconds
 * through `DeckOverrides.viewWebhookWindowMs`; the receiver is a real
 * loopback server (the instance opens private networks for it).
 */

const OWNER = { email: 'owner@view-hooks.test', name: 'Hooks Owner', password: 'view-hooks-owner-pass-1' };
/**
 * Long enough for the fifty views of the grouped test to land inside one
 * window on a loaded machine (about 1.5 s alone, several seconds under the
 * whole integration run beside it), short enough to keep the suite quick;
 * the forty-nine views go in concurrent batches, and the test checks the
 * views did fit before it asserts.
 */
const WINDOW_MS = 15_000;
const DOC_NAV = { accept: 'text/html' };
const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/126.0.0.0 Safari/537.36';
const FIREFOX_UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0';

const HTML = Buffer.from('<!doctype html><html><body><h1>Hooked deck</h1></body></html>');
const shaOf = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

type Envelope = {
  id: string;
  type: string;
  occurredAt: string;
  subjects: { deckId?: string; projectIds?: string[]; shareLinkId?: string };
  data: {
    deckId: string;
    linkId: string;
    version: number | null;
    views: number;
    firstViewAt: string;
    lastViewAt: string;
    referrerHosts: string[];
    placements: string[];
    browserFamilies: string[];
  };
};

let container: StartedPostgreSqlContainer;
let app: TestApp;
let ownerCookie: string;
let deckId: string;
let projectId: string;

// ── The receiver ─────────────────────────────────────────────────────────────

let server: http.Server;
let base = '';
const received: Envelope[] = [];
const eventsOf = (linkId: string) =>
  received.filter((e) => e.type === 'share_link.viewed' && e.subjects.shareLinkId === linkId);

// ── Helpers ──────────────────────────────────────────────────────────────────

let ipCounter = 0;
const nextIp = () => `10.83.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

const send = (method: string, path: string, body?: unknown) =>
  app.app.request(`/api/v1${path}`, {
    method,
    headers: {
      cookie: ownerCookie,
      'x-forwarded-for': nextIp(),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {})
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });

async function mintLink(name: string): Promise<{ id: string; secret: string }> {
  const res = await send('POST', `/presentations/${deckId}/tokens`, { name });
  expect(res.status).toBe(201);
  const created = await readJson(res);
  return { id: created.shareToken.id, secret: created.secret };
}

/** One counted view: no viewed cookie is ever presented, so every GET counts. */
async function view(secret: string, opts: { placement?: string; referer?: string; ua?: string } = {}) {
  const query = opts.placement ? `?p=${opts.placement}` : '';
  const res = await app.app.request(`/v/${secret}/${query}`, {
    headers: {
      ...DOC_NAV,
      'user-agent': opts.ua ?? CHROME_UA,
      'x-forwarded-for': nextIp(),
      ...(opts.referer ? { referer: opts.referer } : {})
    }
  });
  expect(res.status).toBe(200);
}

async function windowRow(linkId: string) {
  const [row] = await app.db.db
    .select()
    .from(shareTokenViewWindows)
    .where(eq(shareTokenViewWindows.shareTokenId, linkId));
  return row;
}

/** The jobs a link left in pg-boss: the fan-out's events of its views, and its flush timers. */
async function jobsOf(linkId: string): Promise<{ events: number; timers: number }> {
  const { rows } = await app.db.pool.query<{ events: number; timers: number }>(
    `SELECT
       count(*) FILTER (WHERE name = 'webhook-events' AND data->>'type' = 'share_link.viewed'
                          AND data->'subjects'->>'link' = $1)::int AS events,
       count(*) FILTER (WHERE name = 'share-link-view-window' AND data->>'tokenId' = $1)::int AS timers
     FROM pgboss.job`,
    [linkId]
  );
  return rows[0]!;
}

async function waitFor<T>(
  label: string,
  probe: () => Promise<T | undefined | null | false> | T | undefined | null | false,
  timeoutMs = 20_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value as T;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Boot ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (body += chunk));
    req.on('end', () => {
      try {
        received.push(JSON.parse(body) as Envelope);
      } catch {
        // not an envelope: ignored
      }
      res.statusCode = 200;
      res.end('ok');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  container = await startPostgres();
  app = await createTestApp(
    await createDatabase(container, 'share_link_views_webhook'),
    { WEBHOOKS_ALLOW_PRIVATE_NETWORKS: 'true' },
    {
      webhookDials: { listenerTtlMs: 0, retryLimit: 1, retryDelaySeconds: 1 },
      tool: { viewWebhookWindowMs: WINDOW_MS }
    }
  );
  const setup = await app.app.request('/api/v1/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() },
    body: JSON.stringify({ setupToken: 'integration-test-setup-token', instanceName: 'Hooks', owner: OWNER })
  });
  expect(setup.status).toBe(201);
  ownerCookie = extractCookie(
    await app.app.request('/api/v1/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() },
      body: JSON.stringify({ email: OWNER.email, password: OWNER.password })
    })
  );

  // A one-version deck, in a project.
  const form = new FormData();
  form.set('sha256', shaOf(HTML));
  form.set('file', new Blob([new Uint8Array(HTML)], { type: 'text/html' }), 'index.html');
  const upload = await app.app.request('/api/v1/presentations/assets', {
    method: 'POST',
    headers: { cookie: ownerCookie, 'x-forwarded-for': nextIp() },
    body: form
  });
  expect(upload.status).toBe(201);
  const reserve = await readJson(await send('POST', '/presentations/uploads'));
  deckId = reserve.uploadSession.presentationId;
  const commit = await send('POST', `/presentations/uploads/${reserve.uploadSession.id}/commit`, {
    title: 'Hooked Deck',
    entryPath: 'index.html',
    manifest: [{ path: 'index.html', sha256: shaOf(HTML), sizeBytes: HTML.length, contentType: 'text/html' }]
  });
  expect(commit.status).toBe(201);
  const project = await send('POST', '/projects', { name: 'Launch' });
  expect(project.status).toBe(201);
  projectId = (await readJson(project)).id;
  expect((await send('PUT', `/presentations/${deckId}/projects/${projectId}`)).status).toBe(200);
}, 180_000);

afterAll(async () => {
  await app?.stop();
  await container?.stop();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
});

// ── The tests ────────────────────────────────────────────────────────────────

let endpointId = '';
let silent: { id: string; secret: string };

describe('a view nobody listens to costs nothing', () => {
  it('with no endpoint at all, ten views write no window row and queue nothing', async () => {
    silent = await mintLink('Silent');
    for (let i = 0; i < 10; i++) await view(silent.secret);
    expect(await windowRow(silent.id)).toBeUndefined();
    expect(await jobsOf(silent.id)).toEqual({ events: 0, timers: 0 });
  });

  it('with the only endpoint disabled, the same', async () => {
    const res = await send('POST', '/webhooks', {
      url: `${base}/views`,
      events: ['share_link.viewed'],
      enabled: false
    });
    expect(res.status).toBe(201);
    const created = await readJson(res);
    expect(created.enabled).toBe(false);
    endpointId = created.id;
    for (let i = 0; i < 10; i++) await view(silent.secret);
    expect(await windowRow(silent.id)).toBeUndefined();
    expect(await jobsOf(silent.id)).toEqual({ events: 0, timers: 0 });
  });
});

describe('the grouped event', () => {
  let preview: { id: string; secret: string };

  it('a preview link’s views open no window', async () => {
    const enabled = await send('PATCH', `/webhooks/${endpointId}`, { enabled: true });
    expect(enabled.status).toBe(200);
    const res = await send('POST', `/presentations/${deckId}/preview-token`, {});
    expect(res.status).toBe(201);
    const created = await readJson(res);
    preview = { id: created.shareToken.id, secret: created.secret };
    for (let i = 0; i < 3; i++) await view(preview.secret);
    expect(await windowRow(preview.id)).toBeUndefined();
    expect(await jobsOf(preview.id)).toEqual({ events: 0, timers: 0 });
  });

  it('fifty views: one event at once with views 1, then one after the window with views 49', async () => {
    const link = await mintLink('Grouped');
    const started = Date.now();

    // The first view, with facts of its own (they go out with it, never again).
    await view(link.secret, { placement: 'first', referer: 'https://first.example.org/a', ua: FIREFOX_UA });
    const opened = await windowRow(link.id);
    expect(opened).toMatchObject({ pending: false, countAtStart: 1 });

    const first = await waitFor('the first event', () => eventsOf(link.id)[0]);
    expect(first.data).toMatchObject({
      deckId,
      linkId: link.id,
      version: 1,
      views: 1,
      referrerHosts: ['first.example.org'],
      placements: ['first'],
      browserFamilies: ['firefox']
    });
    expect(first.data.firstViewAt).toBe(first.data.lastViewAt);
    expect(first.subjects).toEqual({ deckId, projectIds: [projectId], shareLinkId: link.id });

    // Forty-nine more inside the window: they arm one timer and send nothing yet.
    for (let batch = 0; batch < 49; batch += 7) {
      await Promise.all(
        Array.from({ length: Math.min(7, 49 - batch) }, (_, k) => batch + k).map((i) =>
          view(link.secret, {
            placement: 'rest',
            ...(i % 2 === 0 ? { referer: 'https://docs.example.com/page?q=dropped' } : {})
          })
        )
      );
    }
    // The fifty views fitted in one window (else the figures below mean nothing).
    expect(Date.now() - started).toBeLessThan(WINDOW_MS - 1000);
    expect(await windowRow(link.id)).toMatchObject({ pending: true, countAtStart: 1 });
    expect(eventsOf(link.id)).toHaveLength(1);
    expect((await jobsOf(link.id)).timers).toBe(1);

    const second = await waitFor('the grouped event', () => eventsOf(link.id)[1]);
    expect(second.data).toMatchObject({
      deckId,
      linkId: link.id,
      version: 1,
      views: 49,
      referrerHosts: ['docs.example.com'],
      placements: ['rest'],
      browserFamilies: ['chrome']
    });
    expect(Date.parse(second.data.firstViewAt)).toBeLessThanOrEqual(Date.parse(second.data.lastViewAt));
    expect(Date.parse(second.data.firstViewAt)).toBeGreaterThan(Date.parse(first.data.lastViewAt));
    expect(second.subjects).toEqual({ deckId, projectIds: [projectId], shareLinkId: link.id });

    // The flush closed the window, and nothing else goes out.
    expect(await windowRow(link.id)).toBeUndefined();
    await settle(1500);
    expect(eventsOf(link.id)).toHaveLength(2);

    // The next view opens a new window and is sent at once again.
    await view(link.secret, { placement: 'again' });
    const third = await waitFor('the next window’s first event', () => eventsOf(link.id)[2]);
    expect(third.data).toMatchObject({ views: 1, placements: ['again'] });
    expect(await windowRow(link.id)).toMatchObject({ pending: false, countAtStart: 51 });
  }, 60_000);

  it('the grouped count is the link’s counter, never the analytics rows: rows purged before the flush, still views 49 (verifier round 1, S3)', async () => {
    const link = await mintLink('Counted');
    const started = Date.now();
    await view(link.secret);
    await waitFor('the first event', () => eventsOf(link.id)[0]);
    for (let batch = 0; batch < 49; batch += 7) {
      await Promise.all(
        Array.from({ length: Math.min(7, 49 - batch) }).map(() => view(link.secret, { placement: 'purged' }))
      );
    }
    // The fifty views fitted in one window, and the flush has not fired yet.
    expect(Date.now() - started).toBeLessThan(WINDOW_MS - 1000);
    expect(await windowRow(link.id)).toMatchObject({ pending: true, countAtStart: 1 });
    expect(eventsOf(link.id)).toHaveLength(1);

    // Every analytics row of the link goes (a purge, or inserts that failed): the counter stays.
    const rowsOf = async () =>
      (
        await app.db.db
          .select({ id: shareTokenViews.id })
          .from(shareTokenViews)
          .where(eq(shareTokenViews.shareTokenId, link.id))
      ).length;
    await waitFor('the fifty analytics rows', async () => (await rowsOf()) === 50);
    await app.db.db.delete(shareTokenViews).where(eq(shareTokenViews.shareTokenId, link.id));
    expect(await rowsOf()).toBe(0);
    expect(await windowRow(link.id)).toMatchObject({ pending: true });

    const second = await waitFor('the grouped event', () => eventsOf(link.id)[1]);
    expect(second.data.views).toBe(49);
    expect(Date.parse(second.data.firstViewAt)).toBeLessThanOrEqual(Date.parse(second.data.lastViewAt));
    expect(second.subjects).toEqual({ deckId, projectIds: [projectId], shareLinkId: link.id });
  }, 60_000);

  it('neither the preview link nor the silent one ever emitted', () => {
    // The grouped link's events went through the same fan-out and deliveries:
    // they are the witness that anything queued for these would have arrived.
    expect(eventsOf(preview.id)).toHaveLength(0);
    expect(eventsOf(silent.id)).toHaveLength(0);
  });
});
