import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { and, eq } from 'drizzle-orm';
import { webhookDeliveries, workspaceMembers } from '@antasphere/chassis-db';
import { verifyWebhookSignature } from '@antasphere/chassis-server/webhooks';
import { DECK_WEBHOOK_EVENTS, DECK_WEBHOOK_EVENT_TYPES, DECK_WEBHOOK_SUBJECTS } from '@slideless/contract';
import {
  createDatabase,
  createTestApp,
  extractCookie,
  readJson,
  RecordingEmailDriver,
  startPostgres,
  type TestApp
} from './helpers.js';
import type { RendererClient, RendererJob, SubmitOutcome } from '../../src/thumbnails/renderer-client.js';
import { MAX_ATTEMPTS } from '../../src/thumbnails/service.js';

/**
 * Slideless speaks its events (PRDCT-3483), end to end: every one of the 24
 * event types of the catalog (`@slideless/contract`, `DECK_WEBHOOK_EVENTS`)
 * is driven through the product's own API, received by a REAL loopback
 * receiver, its signature verified with the endpoint's secret, its `data`
 * parsed with the contract's own zod schema, and its subjects checked
 * (`deckId`, `projectIds` as a list, `shareLinkId` where the event declares
 * the link). Then: a failed write emits nothing, the subject filters, the
 * scope rule for keys, the oss plan value (unlimited), the audit row's
 * silence on the secret, and the catalog route.
 *
 * One app, one container, one receiver. The grouping of `share_link.viewed`
 * is share-link-views-webhook.test.ts's; here only its first event is seen.
 * The renderer is a fake playing the protocol (thumbnails.test.ts's shape):
 * it renders every deck, and fails every capture of a deck whose entry
 * carries the `thumb-fail` marker.
 */

const PASSWORD = 'webhooks-owner-pass-1';
const OWNER = { email: 'owner@hooks.test', name: 'Hooks Owner', password: PASSWORD };
const COLLAB = { email: 'collab@outside.test', name: 'Outside Collab', password: 'collab-pass-0001' };
const DEADLINE_MS = 15_000;

const shaOf = (bytes: Buffer | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
type Blob = { path: string; bytes: Buffer; contentType: string };
const entryOf = (b: Blob) => ({
  path: b.path,
  sha256: shaOf(b.bytes),
  sizeBytes: b.bytes.length,
  contentType: b.contentType
});
const htmlOf = (label: string) =>
  Buffer.from(
    `<!doctype html><html><head><title>${label}</title></head><body><h1>${label}</h1>` +
      '<form data-slideless-form="kyc"><input name="who">' +
      '<input type="checkbox" name="tags" value="a"><input type="checkbox" name="tags" value="b">' +
      '<input type="file" name="docs" multiple accept=".pdf" data-slideless-max="3"></form>' +
      '</body></html>'
  );
const CSV = Buffer.from('a,b\n1,2\n');

// ── The receiver ─────────────────────────────────────────────────────────────

type Envelope = {
  id: string;
  type: string;
  occurredAt: string;
  workspaceId: string;
  subjects: Record<string, unknown> & { deckId?: string; projectIds?: string[]; shareLinkId?: unknown };
  data: Record<string, unknown>;
  attempt: number;
};
type Received = { url: string; headers: http.IncomingHttpHeaders; raw: string; body: Envelope };

let server: http.Server;
let base = '';
const received: Received[] = [];

// ── The fake renderer ────────────────────────────────────────────────────────

const FAKE_WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0x20, 0, 0, 0]),
  Buffer.from('WEBPVP8 '),
  Buffer.alloc(24, 0x5a)
]);

class FakeRenderer implements RendererClient {
  private readonly inflight = new Set<Promise<void>>();
  constructor(private readonly getApp: () => TestApp) {}

  async submit(job: RendererJob): Promise<SubmitOutcome> {
    const p = this.render(job).finally(() => this.inflight.delete(p));
    this.inflight.add(p);
    return 'queued';
  }

  async settle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.all([...this.inflight]);
  }

  private async render(job: RendererJob): Promise<void> {
    const app = this.getApp();
    const entry = await app.app.request(
      `/internal/renderer/jobs/${job.job}/files/${job.entryPath.split('/').map(encodeURIComponent).join('/')}`,
      { headers: { authorization: `Bearer ${job.token}` } }
    );
    const text = entry.status === 200 ? await entry.text() : '';
    if (text.includes('thumb-fail')) {
      await app.app.request(`/internal/renderer/jobs/${job.job}/failure`, {
        method: 'POST',
        headers: { authorization: `Bearer ${job.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ error: 'the page never loaded' })
      });
      return;
    }
    await app.app.request(`/internal/renderer/jobs/${job.job}/image`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${job.token}`,
        'content-type': 'image/webp',
        'content-length': String(FAKE_WEBP.length)
      },
      body: new Uint8Array(FAKE_WEBP)
    });
  }
}

// ── State ────────────────────────────────────────────────────────────────────

let container: StartedPostgreSqlContainer;
let app: TestApp;
const mail = new RecordingEmailDriver();
const fake = new FakeRenderer(() => app);
let ownerCookie = '';
let workspaceId = '';
let projectId = '';
let all: { id: string; secret: string };
/** The event types this file has asserted end to end (the last test checks the whole catalog is here). */
const asserted = new Set<string>();

// ── Helpers ──────────────────────────────────────────────────────────────────

let ipCounter = 0;
const nextIp = () => `10.84.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  app.app.request(`/api/v1${path}`, {
    method,
    headers: {
      cookie: ownerCookie,
      'x-forwarded-for': nextIp(),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });

/** A viewer-surface request (the deck page's runtime: opaque origin, no cookie). */
const viewer = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  app.app.request(`/api/v1/viewer${path}`, {
    method,
    headers: {
      origin: 'null',
      'x-forwarded-for': nextIp(),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });

async function expectStatus(res: Response, status: number): ReturnType<typeof readJson> {
  const body = await readJson(res);
  expect({ status: res.status, body }).toMatchObject({ status });
  return body;
}

async function upload(b: Blob): Promise<void> {
  const form = new FormData();
  form.set('sha256', shaOf(b.bytes));
  form.set('file', new Blob([new Uint8Array(b.bytes)], { type: b.contentType }), b.path.split('/').pop()!);
  const res = await app.app.request('/api/v1/presentations/assets', {
    method: 'POST',
    headers: { cookie: ownerCookie, 'x-forwarded-for': nextIp() },
    body: form
  });
  expect(res.status).toBe(201);
}

const deckBlobs = (label: string): Blob[] => [
  { path: 'index.html', bytes: htmlOf(label), contentType: 'text/html' },
  { path: 'downloads/a.csv', bytes: CSV, contentType: 'text/csv' }
];

async function reserve(): Promise<{ sessionId: string; deckId: string }> {
  const body = await expectStatus(await send('POST', '/presentations/uploads'), 201);
  return { sessionId: body.uploadSession.id, deckId: body.uploadSession.presentationId };
}

async function pushDeck(
  title: string,
  opts: { projectIds?: string[]; label?: string } = {}
): Promise<string> {
  const blobs = deckBlobs(opts.label ?? title);
  for (const b of blobs) await upload(b);
  const r = await reserve();
  await expectStatus(
    await send('POST', `/presentations/uploads/${r.sessionId}/commit`, {
      title,
      entryPath: 'index.html',
      manifest: blobs.map(entryOf),
      ...(opts.projectIds ? { projectIds: opts.projectIds } : {})
    }),
    201
  );
  return r.deckId;
}

/** A new version; its blobs are uploaded first unless the caller already did (the race wants the two commits alone). */
async function commitVersion(
  deckId: string,
  base: number,
  label: string,
  uploadFirst = true
): Promise<Response> {
  if (uploadFirst) for (const b of deckBlobs(label)) await upload(b);
  return send('POST', `/presentations/${deckId}/versions`, {
    expectedBaseVersion: base,
    entryPath: 'index.html',
    manifest: deckBlobs(label).map(entryOf)
  });
}

async function mintLink(
  deckId: string,
  body: Record<string, unknown>
): Promise<{ id: string; secret: string }> {
  const created = await expectStatus(await send('POST', `/presentations/${deckId}/tokens`, body), 201);
  return { id: created.shareToken.id, secret: created.secret };
}

async function createEndpoint(body: Record<string, unknown>): Promise<{ id: string; secret: string }> {
  const created = await expectStatus(await send('POST', '/webhooks', body), 201);
  expect(created.secret).toMatch(/^whsec_/);
  return { id: created.id, secret: created.secret };
}

async function waitFor<T>(
  label: string,
  probe: () => Promise<T | undefined | null | false> | T | undefined | null | false,
  timeoutMs = DEADLINE_MS
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value as T;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const settle = (ms = 3000) => new Promise((r) => setTimeout(r, ms));

const at = (path: string, type: string, match: (e: Envelope) => boolean = () => true) =>
  received.filter((r) => r.url === path && r.body.type === type && match(r.body));

/** The one subject value an event says for a deck: `deckId`, the sorted project ids, the link where declared. */
interface ExpectedSubjects {
  deckId: string;
  projectIds: string[];
  /** The link id; `[]` when the act went through no link. Only for events that declare `link`. */
  shareLinkId?: string | string[];
}

/**
 * Wait for the first `type` event at the catch-all endpoint that matches,
 * then hold it to the contract: a valid signature under the endpoint's
 * secret, the envelope's workspace, `data` parsed by the catalog's own zod
 * schema, and exactly the declared subjects with the expected values.
 */
async function expectEvent(
  type: string,
  match: (e: Envelope) => boolean,
  subjects: ExpectedSubjects
): Promise<Envelope> {
  const hit = await waitFor(`${type} at /all`, () => at('/all', type, match)[0]);
  const headers = {
    id: hit.headers['webhook-id'] as string,
    timestamp: hit.headers['webhook-timestamp'] as string,
    signature: hit.headers['webhook-signature'] as string
  };
  expect(verifyWebhookSignature(all.secret, headers, hit.raw), `${type}: signature`).toBe(true);
  expect(headers.id).toBe(hit.body.id);
  expect(hit.body.workspaceId).toBe(workspaceId);

  const declared = DECK_WEBHOOK_EVENTS.find((e) => e.type === type);
  expect(declared, `${type} is in the catalog`).toBeDefined();
  const parsed = declared!.data.safeParse(hit.body.data);
  expect(parsed.success ? null : parsed.error.issues, `${type}: data matches the contract`).toBeNull();

  const expectedFields: Record<string, unknown> = {
    deckId: subjects.deckId,
    projectIds: [...subjects.projectIds].sort()
  };
  if (declared!.subjects.includes('link')) {
    expect(subjects.shareLinkId, `${type}: the test names the link it expects`).toBeDefined();
    expectedFields.shareLinkId = subjects.shareLinkId;
  }
  const got = { ...hit.body.subjects };
  if (Array.isArray(got.projectIds)) got.projectIds = [...got.projectIds].sort();
  expect(got, `${type}: subjects`).toEqual(expectedFields);
  expect(Object.keys(got).sort()).toEqual(
    declared!.subjects.map((s) => DECK_WEBHOOK_SUBJECTS[s].field).sort()
  );
  asserted.add(type);
  return hit.body;
}

async function deliveryFor(endpointId: string, eventId: string) {
  const [row] = await app.db.db
    .select()
    .from(webhookDeliveries)
    .where(and(eq(webhookDeliveries.endpointId, endpointId), eq(webhookDeliveries.eventId, eventId)));
  return row;
}

const versionIdOf = async (deckId: string, version: number): Promise<string> => {
  const { rows } = await app.db.pool.query(
    'SELECT id FROM presentation_versions WHERE presentation_id = $1 AND version = $2',
    [deckId, version]
  );
  return rows[0].id as string;
};

const flushThumbnails = async () => {
  for (let i = 0; i < 3; i++) {
    await app.tool.thumbnails.idle();
    await fake.settle();
  }
};

// ── Boot ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (raw += chunk));
    req.on('end', () => {
      try {
        received.push({ url: req.url ?? '', headers: req.headers, raw, body: JSON.parse(raw) as Envelope });
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
    await createDatabase(container, 'deck_webhooks'),
    { WEBHOOKS_ALLOW_PRIVATE_NETWORKS: 'true' },
    {
      webhookDials: { listenerTtlMs: 0, retryLimit: 1, retryDelaySeconds: 1 },
      email: mail,
      tool: { rendererClient: fake }
    }
  );
  const setup = await app.app.request('/api/v1/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() },
    body: JSON.stringify({ setupToken: 'integration-test-setup-token', instanceName: 'Hooks', owner: OWNER })
  });
  expect(setup.status).toBe(201);
  workspaceId = (await readJson(setup)).workspaceId;
  ownerCookie = extractCookie(
    await app.app.request('/api/v1/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() },
      body: JSON.stringify({ email: OWNER.email, password: OWNER.password })
    })
  );
  projectId = (await expectStatus(await send('POST', '/projects', { name: 'Launch' }), 201)).id;
  all = await createEndpoint({ url: `${base}/all`, events: ['*'], description: 'Everything' });
}, 180_000);

afterAll(async () => {
  await app?.stop();
  await container?.stop();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
});

// ── The catalog and the endpoint ─────────────────────────────────────────────

describe('the catalog and the endpoint', () => {
  it('GET /webhooks/events lists the 24 deck events with the chassis’s, and the project subject as projectIds', async () => {
    const catalog = await expectStatus(await send('GET', '/webhooks/events'), 200);
    const types = catalog.events.map((e: { type: string }) => e.type) as string[];
    expect(DECK_WEBHOOK_EVENT_TYPES).toHaveLength(24);
    for (const type of DECK_WEBHOOK_EVENT_TYPES) expect(types, type).toContain(type);
    for (const type of ['webhook.ping', 'project.created']) expect(types, type).toContain(type);
    expect(catalog.subjects).toEqual(
      expect.arrayContaining([
        // The project subject is a list on every event (verifier round 1, MN2); the other two are one id.
        expect.objectContaining({ key: 'project', field: 'projectIds', list: true }),
        expect.objectContaining({ key: 'deck', field: 'deckId', list: false }),
        expect.objectContaining({ key: 'link', field: 'shareLinkId', list: false })
      ])
    );
  });

  it('a subscription is checked against the catalog: an unknown type and an unknown subject key are 400, nothing stored (verifier round 1, MN1)', async () => {
    const before = (await expectStatus(await send('GET', '/webhooks'), 200)).webhooks.length as number;
    const typo = await send('POST', '/webhooks', { url: `${base}/typo`, events: ['deck.nonexistent'] });
    expect(typo.status).toBe(400);
    expect((await readJson(typo)).error.code).toBe('unknown_event');
    const family = await send('POST', '/webhooks', { url: `${base}/typo`, events: ['nothing.*'] });
    expect(family.status).toBe(400);
    expect((await readJson(family)).error.code).toBe('unknown_event');
    const subject = await send('POST', '/webhooks', {
      url: `${base}/typo`,
      events: ['deck.*'],
      filters: { bogus: ['x'] }
    });
    expect(subject.status).toBe(400);
    expect((await readJson(subject)).error.code).toBe('unknown_subject');
    expect((await expectStatus(await send('GET', '/webhooks'), 200)).webhooks).toHaveLength(before);
  });

  it('the webhook.create audit row never carries the secret', async () => {
    const rows = await waitFor('the webhook.create audit row', async () => {
      const { rows } = await app.db.pool.query(`SELECT * FROM audit_log WHERE action = 'webhook.create'`);
      return rows.length > 0 ? rows : undefined;
    });
    for (const row of rows) {
      expect(JSON.stringify(row)).not.toContain('whsec_');
      expect(JSON.stringify(row)).not.toContain(all.secret);
    }
  });
});

// ── Every event of the catalog ───────────────────────────────────────────────

let deckId = '';
let otherProjectId = '';

describe('the deck events', () => {
  it('deck.created and deck.project_linked: a push into a project', async () => {
    deckId = await pushDeck('Hooked Deck', { projectIds: [projectId] });
    const created = await expectEvent('deck.created', (e) => e.data.deckId === deckId, {
      deckId,
      projectIds: [projectId]
    });
    expect(Array.isArray(created.subjects.projectIds), 'deck.created: projectIds is a list').toBe(true);
    expect(created.data).toMatchObject({
      title: 'Hooked Deck',
      version: 1,
      projectIds: [projectId],
      remixedFrom: null
    });
    const linked = await expectEvent('deck.project_linked', (e) => e.data.deckId === deckId, {
      deckId,
      projectIds: [projectId]
    });
    expect(linked.data).toEqual({ deckId, projectId });
  });

  it('deck.version_committed: a second commit', async () => {
    await expectStatus(await commitVersion(deckId, 1, 'Hooked Deck v2'), 201);
    const event = await expectEvent(
      'deck.version_committed',
      (e) => e.data.deckId === deckId && e.data.version === 2,
      { deckId, projectIds: [projectId] }
    );
    expect(event.data).toMatchObject({ version: 2, authorRole: 'owner' });
  });

  it('deck.updated: the title', async () => {
    await expectStatus(await send('PATCH', `/presentations/${deckId}`, { title: 'Renamed Deck' }), 200);
    const event = await expectEvent('deck.updated', (e) => e.data.deckId === deckId, {
      deckId,
      projectIds: [projectId]
    });
    expect(event.data.fields).toEqual(['title']);
  });

  it('deck.project_linked and deck.project_unlinked: the link and unlink routes', async () => {
    otherProjectId = (await expectStatus(await send('POST', '/projects', { name: 'Second' }), 201)).id;
    await expectStatus(await send('PUT', `/presentations/${deckId}/projects/${otherProjectId}`), 200);
    await expectEvent(
      'deck.project_linked',
      (e) => e.data.deckId === deckId && e.data.projectId === otherProjectId,
      { deckId, projectIds: [projectId, otherProjectId] }
    );
    const unlink = await send('DELETE', `/presentations/${deckId}/projects/${otherProjectId}`);
    expect(unlink.status).toBeLessThan(300);
    // The project the deck left is still named in the subject.
    const event = await expectEvent(
      'deck.project_unlinked',
      (e) => e.data.deckId === deckId && e.data.projectId === otherProjectId,
      { deckId, projectIds: [projectId, otherProjectId] }
    );
    expect(event.data).toEqual({ deckId, projectId: otherProjectId });
  });

  it('deck.deleted', async () => {
    const doomed = await pushDeck('Doomed Deck', { projectIds: [projectId] });
    const del = await send('DELETE', `/presentations/${doomed}`);
    expect(del.status).toBeLessThan(300);
    const event = await expectEvent('deck.deleted', (e) => e.data.deckId === doomed, {
      deckId: doomed,
      projectIds: [projectId]
    });
    expect(event.data).toEqual({ deckId: doomed, title: 'Doomed Deck' });
  });
});

describe('the share link events', () => {
  let link: { id: string; secret: string };

  it('share_link.created, .updated, .revoked; a preview link mints none', async () => {
    link = await mintLink(deckId, { name: 'Client' });
    const created = await expectEvent('share_link.created', (e) => e.data.linkId === link.id, {
      deckId,
      projectIds: [projectId],
      shareLinkId: link.id
    });
    expect(created.data).toMatchObject({ deckId, linkId: link.id, name: 'Client', purpose: 'share' });

    await expectStatus(
      await send('PATCH', `/presentations/${deckId}/tokens/${link.id}`, { name: 'Client B' }),
      200
    );
    const updated = await expectEvent('share_link.updated', (e) => e.data.linkId === link.id, {
      deckId,
      projectIds: [projectId],
      shareLinkId: link.id
    });
    expect(updated.data.name).toBe('Client B');
    expect(updated.data.changed).toContain('name');

    const doomed = await mintLink(deckId, { name: 'Doomed link' });
    await expectStatus(await send('DELETE', `/presentations/${deckId}/tokens/${doomed.id}`), 200);
    await expectEvent('share_link.revoked', (e) => e.data.linkId === doomed.id, {
      deckId,
      projectIds: [projectId],
      shareLinkId: doomed.id
    });

    const preview = await expectStatus(await send('POST', `/presentations/${deckId}/preview-token`, {}), 201);
    const previewId = preview.shareToken.id as string;
    // A positive control after it: once this link's event is in, the preview's would be too.
    const after = await mintLink(deckId, { name: 'After preview' });
    await waitFor(
      'the control link’s event',
      () => at('/all', 'share_link.created', (e) => e.data.linkId === after.id)[0]
    );
    await settle(1000);
    expect(at('/all', 'share_link.created', (e) => e.data.linkId === previewId)).toHaveLength(0);
    expect(received.filter((r) => r.body.subjects.shareLinkId === previewId)).toHaveLength(0);
  });

  it('share_link.sent: a delivering mail driver, the recipient named', async () => {
    const sent = await mintLink(deckId, { name: 'Mailed' });
    const res = await expectStatus(
      await send('POST', `/presentations/${deckId}/tokens/${sent.id}/send`, { email: 'client@example.org' }),
      200
    );
    expect(res.emailSent).toBe(true);
    const event = await expectEvent('share_link.sent', (e) => e.data.linkId === sent.id, {
      deckId,
      projectIds: [projectId],
      shareLinkId: sent.id
    });
    expect(event.data.recipient).toBe('client@example.org');
  });

  it('share_link.updated names the request’s fields: password, then name, never passwordHash (verifier round 1, N4)', async () => {
    const l = await mintLink(deckId, { name: 'Changed fields' });
    const subjects = { deckId, projectIds: [projectId], shareLinkId: l.id };
    await expectStatus(
      await send('PATCH', `/presentations/${deckId}/tokens/${l.id}`, { password: 'a-long-password' }),
      200
    );
    const pw = await expectEvent(
      'share_link.updated',
      (e) => e.data.linkId === l.id && e.data.name === 'Changed fields',
      subjects
    );
    expect(pw.data.changed).toEqual(['password']);
    expect(pw.data.hasPassword).toBe(true);
    await expectStatus(await send('PATCH', `/presentations/${deckId}/tokens/${l.id}`, { name: 'x' }), 200);
    const nm = await expectEvent(
      'share_link.updated',
      (e) => e.data.linkId === l.id && e.data.name === 'x',
      subjects
    );
    expect(nm.data.changed).toEqual(['name']);
  });

  it('a preview link’s revoke emits nothing (verifier round 1, S1)', async () => {
    const preview = await expectStatus(await send('POST', `/presentations/${deckId}/preview-token`, {}), 201);
    const previewId = preview.shareToken.id as string;
    const revoked = await expectStatus(
      await send('DELETE', `/presentations/${deckId}/tokens/${previewId}`),
      200
    );
    expect(revoked.revokedAt).toBeTruthy();
    // A positive control after it: once this link's revoke is in, the preview's would be too.
    const control = await mintLink(deckId, { name: 'Revoke control' });
    await expectStatus(await send('DELETE', `/presentations/${deckId}/tokens/${control.id}`), 200);
    await waitFor(
      'the control link’s revoke',
      () => at('/all', 'share_link.revoked', (e) => e.data.linkId === control.id)[0]
    );
    await settle(3000);
    expect(at('/all', 'share_link.revoked', (e) => e.data.linkId === previewId)).toHaveLength(0);
    expect(received.filter((r) => r.body.subjects.shareLinkId === previewId)).toHaveLength(0);
  });

  it('share_link.viewed: a counted view sends the first event at once', async () => {
    const res = await app.app.request(`/v/${link.secret}/`, {
      headers: { accept: 'text/html', 'x-forwarded-for': nextIp() }
    });
    expect(res.status).toBe(200);
    const event = await expectEvent('share_link.viewed', (e) => e.data.linkId === link.id, {
      deckId,
      projectIds: [projectId],
      shareLinkId: link.id
    });
    expect(event.data).toMatchObject({ views: 1, version: 2 });
  });

  it('attachment.downloaded: one file by name, then the bundle with name null', async () => {
    const file = await app.app.request(`/v/${link.secret}/downloads/a.csv`, {
      headers: { 'x-forwarded-for': nextIp() }
    });
    expect(file.status).toBe(200);
    const one = await expectEvent(
      'attachment.downloaded',
      (e) => e.data.linkId === link.id && e.data.name === 'a.csv',
      { deckId, projectIds: [projectId], shareLinkId: link.id }
    );
    expect(one.data).toEqual({ deckId, linkId: link.id, version: 2, name: 'a.csv' });

    const zip = await app.app.request(`/v/${link.secret}/downloads.zip`, {
      headers: { 'x-forwarded-for': nextIp() }
    });
    expect(zip.status).toBe(200);
    const bundle = await expectEvent(
      'attachment.downloaded',
      (e) => e.data.linkId === link.id && e.data.name === null,
      { deckId, projectIds: [projectId], shareLinkId: link.id }
    );
    expect(bundle.data).toEqual({ deckId, linkId: link.id, version: 2, name: null });
  });
});

describe('the form events', () => {
  let link: { id: string; secret: string };
  let fileId = '';
  let responseId = '';
  let editSecret = '';

  it('form.file_uploaded: the viewer upload route', async () => {
    link = await mintLink(deckId, { name: 'Forms', remembersResponses: false });
    const bytes = new Uint8Array(16).fill(7);
    const qs = new URLSearchParams({ field: 'docs', name: 'passport.pdf', type: 'application/pdf' });
    const res = await app.app.request(`/api/v1/viewer/${link.secret}/forms/kyc/uploads?${qs.toString()}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(bytes.length),
        origin: 'null',
        'x-forwarded-for': nextIp()
      },
      body: bytes
    });
    const body = await expectStatus(res, 201);
    fileId = body.file.id;
    const event = await expectEvent('form.file_uploaded', (e) => e.data.uploadId === fileId, {
      deckId,
      projectIds: [projectId],
      shareLinkId: link.id
    });
    expect(event.data).toEqual({
      deckId,
      formName: 'kyc',
      linkId: link.id,
      uploadId: fileId,
      name: 'passport.pdf',
      sizeBytes: 16
    });
  });

  it('form.response_submitted: the answers verbatim and the file', async () => {
    const answers = { who: 'Ada Lovelace', tags: ['a', 'b'] };
    const res = await viewer('POST', `/${link.secret}/forms/kyc/responses`, {
      payload: answers,
      files: { docs: [fileId] }
    });
    const body = await expectStatus(res, 201);
    responseId = body.response.id;
    editSecret = body.editSecret;
    const event = await expectEvent('form.response_submitted', (e) => e.data.responseId === responseId, {
      deckId,
      projectIds: [projectId],
      shareLinkId: link.id
    });
    expect(event.data).toMatchObject({ formName: 'kyc', revision: 1, linkId: link.id, version: 2 });
    expect(event.data.answers).toEqual(answers);
    expect(event.data.files).toEqual([{ id: fileId, name: 'passport.pdf', sizeBytes: 16 }]);
  });

  it('form.response_edited: the edit route with the edit secret', async () => {
    expect(editSecret).toBeTruthy();
    const res = await viewer(
      'PUT',
      `/${link.secret}/forms/kyc/responses/me`,
      { payload: { who: 'Ada King', tags: ['b'] }, files: { docs: [fileId] } },
      { 'x-slideless-response': editSecret }
    );
    expect(res.status).toBe(200);
    const event = await expectEvent('form.response_edited', (e) => e.data.responseId === responseId, {
      deckId,
      projectIds: [projectId],
      shareLinkId: link.id
    });
    expect(event.data).toMatchObject({ revision: 2, answers: { who: 'Ada King', tags: ['b'] } });
  });

  it('form.response_deleted: the owner’s delete', async () => {
    await expectStatus(await send('DELETE', `/presentations/${deckId}/responses/${responseId}`), 200);
    const event = await expectEvent('form.response_deleted', (e) => e.data.responseId === responseId, {
      deckId,
      projectIds: [projectId]
    });
    expect(event.data).toEqual({ deckId, responseId });
  });
});

describe('the collaborator events', () => {
  let collaboratorId = '';

  it('collaborator.invited, .claimed, .revoked', async () => {
    const invited = await expectStatus(
      await send('POST', `/presentations/${deckId}/collaborators`, { email: COLLAB.email }),
      201
    );
    collaboratorId = invited.collaborator.id;
    const inv = await expectEvent('collaborator.invited', (e) => e.data.collaboratorId === collaboratorId, {
      deckId,
      projectIds: [projectId]
    });
    expect(inv.data).toEqual({ deckId, collaboratorId, email: COLLAB.email, userId: null });

    const token = (invited.claimUrl as string).split('/collab/')[1];
    const claimed = await expectStatus(
      await app.app.request('/api/v1/collaborators/claim', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() },
        body: JSON.stringify({ token, name: COLLAB.name, password: COLLAB.password })
      }),
      200
    );
    const cl = await expectEvent('collaborator.claimed', (e) => e.data.collaboratorId === collaboratorId, {
      deckId,
      projectIds: [projectId]
    });
    expect(cl.data).toEqual({ deckId, collaboratorId, email: COLLAB.email, userId: claimed.userId });

    await expectStatus(await send('DELETE', `/presentations/${deckId}/collaborators/${collaboratorId}`), 200);
    const rv = await expectEvent('collaborator.revoked', (e) => e.data.collaboratorId === collaboratorId, {
      deckId,
      projectIds: [projectId]
    });
    expect(rv.data).toMatchObject({ deckId, collaboratorId, email: COLLAB.email });
  });

  it('a member’s removal revokes their deck grant, and the revoke is delivered (verifier round 1, S13)', async () => {
    const email = 'colleague@hooks.test';
    const signedUp = await app.auth.api.signUpEmail({
      body: { email, password: 'colleague-pass-0001', name: 'Colleague' }
    });
    const [member] = await app.db.db
      .insert(workspaceMembers)
      .values({ workspaceId, userId: signedUp.user.id, role: 'member', origin: 'local' })
      .returning({ id: workspaceMembers.id });
    const invited = await expectStatus(
      await send('POST', `/presentations/${deckId}/collaborators`, { email }),
      201
    );
    const grantId = invited.collaborator.id as string;
    await expectStatus(await send('POST', `/members/${member!.id}/remove`), 200);
    const rv = await expectEvent('collaborator.revoked', (e) => e.data.collaboratorId === grantId, {
      deckId,
      projectIds: [projectId]
    });
    expect(rv.data).toMatchObject({ deckId, collaboratorId: grantId, email });
  });
});

describe('the annotation events', () => {
  it('annotation.created by a viewer (the link named), then .resolved and .deleted by the owner', async () => {
    const link = await mintLink(deckId, { name: 'Reviewer', canAnnotate: true });
    const created = await expectStatus(
      await viewer('POST', `/${link.secret}/annotations`, {
        body: 'The chart is unclear',
        authorName: 'Alice',
        selection: { type: 'text', quote: 'Hooked' },
        version: 2
      }),
      201
    );
    const annotationId = created.id as string;
    const ev = await expectEvent('annotation.created', (e) => e.data.annotationId === annotationId, {
      deckId,
      projectIds: [projectId],
      shareLinkId: link.id
    });
    expect(ev.data).toEqual({ deckId, version: 2, annotationId, linkId: link.id, authorName: 'Alice' });

    await expectStatus(
      await send('PATCH', `/presentations/${deckId}/annotations/${annotationId}`, { status: 'resolved' }),
      200
    );
    await expectEvent('annotation.resolved', (e) => e.data.annotationId === annotationId, {
      deckId,
      projectIds: [projectId]
    });
    await expectStatus(await send('DELETE', `/presentations/${deckId}/annotations/${annotationId}`), 200);
    await expectEvent('annotation.deleted', (e) => e.data.annotationId === annotationId, {
      deckId,
      projectIds: [projectId]
    });
  });
});

describe('the thumbnail events', () => {
  it('thumbnail.rendered: the deck’s image is ready', async () => {
    await flushThumbnails();
    const v2 = await versionIdOf(deckId, 2);
    const event = await expectEvent('thumbnail.rendered', (e) => e.data.versionId === v2, {
      deckId,
      projectIds: [projectId]
    });
    expect(event.data).toEqual({ deckId, versionId: v2, version: 2 });
  });

  it(`thumbnail.failed: a capture failed ${MAX_ATTEMPTS} times is given up, and said once`, async () => {
    const failing = await pushDeck('Failing', { label: 'thumb-fail' });
    await flushThumbnails();
    const vid = await versionIdOf(failing, 1);
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      await app.db.pool.query(
        "UPDATE presentation_version_thumbnails SET lease_until = now() - interval '1 second' WHERE version_id = $1",
        [vid]
      );
      await app.tool.thumbnails.sweep();
      await flushThumbnails();
    }
    const { rows } = await app.db.pool.query(
      'SELECT state FROM presentation_version_thumbnails WHERE version_id = $1',
      [vid]
    );
    expect(rows[0]?.state).toBe('failed');
    const event = await expectEvent('thumbnail.failed', (e) => e.data.versionId === vid, {
      deckId: failing,
      projectIds: []
    });
    expect(event.data).toEqual({ deckId: failing, versionId: vid, version: 1 });
    // A retry is not a failure: one event for the version, never one per attempt.
    await settle(1500);
    expect(at('/all', 'thumbnail.failed', (e) => e.data.versionId === vid)).toHaveLength(1);
  });
});

describe('a write that did not land says nothing', () => {
  it('an upload session commit refused with missing_blobs emits no deck.created; the same session committed emits one', async () => {
    const lone: Blob = {
      path: 'index.html',
      bytes: htmlOf('Never uploaded at first'),
      contentType: 'text/html'
    };
    const r = await reserve();
    const refused = await send('POST', `/presentations/uploads/${r.sessionId}/commit`, {
      title: 'Late',
      entryPath: 'index.html',
      manifest: [entryOf(lone)],
      projectIds: [projectId]
    });
    expect(refused.status).toBe(400);
    expect((await readJson(refused)).error.code).toBe('missing_blobs');

    // The positive control: the same session, the blob now there.
    await upload(lone);
    await expectStatus(
      await send('POST', `/presentations/uploads/${r.sessionId}/commit`, {
        title: 'Late',
        entryPath: 'index.html',
        manifest: [entryOf(lone)],
        projectIds: [projectId]
      }),
      201
    );
    await expectEvent('deck.created', (e) => e.data.deckId === r.deckId, {
      deckId: r.deckId,
      projectIds: [projectId]
    });
    await settle();
    expect(at('/all', 'deck.created', (e) => e.data.deckId === r.deckId)).toHaveLength(1);
    expect(at('/all', 'deck.project_linked', (e) => e.data.deckId === r.deckId)).toHaveLength(1);
  });

  it('two commits racing on one base: the loser’s 409 emits no deck.version_committed', async () => {
    const racer = await pushDeck('Racer');
    for (const label of ['Race A', 'Race B']) await upload(deckBlobs(label)[0]!);
    const [a, b] = await Promise.all([
      commitVersion(racer, 1, 'Race A', false),
      commitVersion(racer, 1, 'Race B', false)
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    await waitFor(
      'the winner’s event',
      () => at('/all', 'deck.version_committed', (e) => e.data.deckId === racer)[0]
    );
    await settle();
    expect(at('/all', 'deck.version_committed', (e) => e.data.deckId === racer)).toHaveLength(1);
  });
});

describe('the chassis’s project events carry the project subject as a list (verifier round 1, MN2)', () => {
  it('project.created and project.archived: subjects.projectIds is an array of the one project', async () => {
    const created = await expectStatus(await send('POST', '/projects', { name: 'Listed' }), 201);
    const id = created.id as string;
    await expectStatus(await send('POST', `/projects/${id}/archive`), 200);
    for (const type of ['project.created', 'project.archived']) {
      const hit = await waitFor(`${type} at /all`, () => at('/all', type, (e) => e.data.projectId === id)[0]);
      const headers = {
        id: hit.headers['webhook-id'] as string,
        timestamp: hit.headers['webhook-timestamp'] as string,
        signature: hit.headers['webhook-signature'] as string
      };
      expect(verifyWebhookSignature(all.secret, headers, hit.raw), `${type}: signature`).toBe(true);
      expect(hit.body.workspaceId).toBe(workspaceId);
      expect(Array.isArray(hit.body.subjects.projectIds), `${type}: projectIds is a list`).toBe(true);
      expect(hit.body.subjects, `${type}: subjects`).toEqual({ projectIds: [id] });
      expect(hit.body.data).toMatchObject({ projectId: id, name: 'Listed' });
    }
  });
});

describe('the subject filters', () => {
  it('an endpoint filtered on another deck never hears this deck, and hears its own; a project filter excludes a deck outside it', async () => {
    const otherDeck = await pushDeck('Other Deck');
    const onlyOther = await createEndpoint({
      url: `${base}/only-other`,
      events: ['deck.*'],
      filters: { deck: [otherDeck] }
    });
    const onlyProject = await createEndpoint({
      url: `${base}/only-project`,
      events: ['deck.*'],
      filters: { project: [projectId] }
    });

    // This deck (in the project): the catch-all is the witness of the fan-out.
    const before = at('/all', 'deck.updated', (e) => e.data.deckId === deckId).length;
    await expectStatus(await send('PATCH', `/presentations/${deckId}`, { title: 'Filtered A' }), 200);
    const mine = await waitFor(
      'this deck’s update at /all',
      () => at('/all', 'deck.updated', (e) => e.data.deckId === deckId)[before]?.body
    );
    await waitFor('the fan-out row at /all', () => deliveryFor(all.id, mine.id));
    expect(await deliveryFor(onlyOther.id, mine.id)).toBeUndefined();
    await waitFor(
      'the project-filtered endpoint hears this deck',
      () => at('/only-project', 'deck.updated', (e) => e.id === mine.id)[0]
    );

    // The other deck (in no project).
    await expectStatus(await send('PATCH', `/presentations/${otherDeck}`, { title: 'Filtered B' }), 200);
    const theirs = await waitFor(
      'the other deck’s update at /only-other',
      () => at('/only-other', 'deck.updated', (e) => e.data.deckId === otherDeck)[0]
    );
    await waitFor('the fan-out row at /all', () => deliveryFor(all.id, theirs.body.id));
    expect(await deliveryFor(onlyProject.id, theirs.body.id)).toBeUndefined();
    expect(received.filter((r) => r.url === '/only-other' && r.body.data.deckId !== otherDeck)).toEqual([]);
    expect(received.filter((r) => r.url === '/only-project' && r.body.data.deckId === otherDeck)).toEqual([]);
  });
});

describe('the scope rule and the plan value on self-hosted', () => {
  it('a key with read and write only is refused GET /webhooks; the catalog stays open to it', async () => {
    const minted = await expectStatus(
      await send('POST', '/api-keys', {
        name: 'no-hooks',
        scopes: ['presentations:read', 'presentations:write']
      }),
      201
    );
    const auth = { authorization: `Bearer ${minted.key}` };
    const refused = await app.app.request('/api/v1/webhooks', {
      headers: { ...auth, 'x-forwarded-for': nextIp() }
    });
    expect(refused.status).toBe(403);
    expect((await readJson(refused)).error.code).toBe('insufficient_scope');
    const catalog = await app.app.request('/api/v1/webhooks/events', {
      headers: { ...auth, 'x-forwarded-for': nextIp() }
    });
    expect(catalog.status).toBe(200);
  });

  it('the CLI key carries webhooks:manage and lists the endpoints', async () => {
    const ip = nextIp();
    const requested = await app.app.request('/api/v1/cli/auth/request', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify({ email: OWNER.email })
    });
    expect(requested.status).toBe(200);
    const otpMail = [...mail.sent].reverse().find((m) => m.to === OWNER.email && /^\d{6} /.test(m.subject));
    const otp = /^(\d{6}) /.exec(otpMail?.subject ?? '')?.[1];
    expect(otp).toBeTruthy();
    const completed = await expectStatus(
      await app.app.request('/api/v1/cli/auth/complete', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
        body: JSON.stringify({ email: OWNER.email, otp, keyName: 'cli' })
      }),
      201
    );
    expect(completed.apiKey.scopes).toContain('webhooks:manage');
    const list = await app.app.request('/api/v1/webhooks', {
      headers: { authorization: `Bearer ${completed.key}`, 'x-forwarded-for': nextIp() }
    });
    const body = await expectStatus(list, 200);
    expect(body.webhooks.map((w: { id: string }) => w.id)).toContain(all.id);
  });

  it('the endpoints per workspace are unlimited on self-hosted: a sixth is 201', async () => {
    const listed = await expectStatus(await send('GET', '/webhooks'), 200);
    let count = listed.webhooks.length as number;
    while (count < 6) {
      await createEndpoint({ url: `${base}/ping-${count}`, events: ['webhook.ping'] });
      count++;
    }
    const seventh = await send('POST', '/webhooks', { url: `${base}/ping-more`, events: ['webhook.ping'] });
    expect(seventh.status).toBe(201);
    const after = await expectStatus(await send('GET', '/webhooks'), 200);
    expect(after.webhooks.length).toBeGreaterThan(5);
  });
});

describe('the whole catalog', () => {
  it('every one of the 24 event types was received, signed, and matched its contract', () => {
    expect([...asserted].sort()).toEqual([...DECK_WEBHOOK_EVENT_TYPES].sort());
  });
});
