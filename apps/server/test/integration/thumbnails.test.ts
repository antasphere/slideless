import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createStorageDriver } from '@antasphere/chassis-server/storage';
import {
  createDatabase,
  createTestApp,
  extractCookie,
  readJson,
  RecordingEmailDriver,
  startPostgres,
  type TestApp
} from './helpers.js';
import {
  SandboxUnavailableError,
  type CaptureInput,
  type ResolvedFile,
  type ThumbnailRenderer
} from '../../src/thumbnails/renderer.js';
import { MAX_ATTEMPTS, ThumbnailService } from '../../src/thumbnails/service.js';

/**
 * The still image of each deck version (PRDCT-2725), end to end over the real
 * app with a FAKE renderer (the real Chromium one is the unit suite's,
 * thumbnail-renderer.test.ts): the push starts the capture, the read route
 * serves it under the deck's own read rule (ADR 013 + ADR 026, 404 never
 * 403), the queue retries and gives up, a sandbox that cannot start turns
 * capture off without burning attempts, an api-only process (renderer null)
 * captures nothing, the sweep backfills decks older than the feature, and two
 * drains at once never capture one version twice.
 */

/** A small fixed WebP-shaped body: the route serves bytes, it never decodes them. */
const FAKE_WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0x20, 0, 0, 0]),
  Buffer.from('WEBPVP8 '),
  Buffer.alloc(24, 0x5a)
]);

interface FakeCall {
  entryPath: string;
  /** The entry document's text, as `resolve` returned it: tells the decks apart. */
  entry: string;
  resolve: (path: string) => Promise<ResolvedFile | null>;
}

/** Records every capture and its `resolve`; `mode` switches what it does. */
class FakeRenderer implements ThumbnailRenderer {
  calls: FakeCall[] = [];
  mode: 'ok' | 'throw' | 'sandbox' = 'ok';
  delayMs = 0;

  async capture(input: CaptureInput): Promise<Buffer> {
    const entry = await input.resolve(input.entryPath);
    this.calls.push({
      entryPath: input.entryPath,
      entry: entry?.body.toString() ?? '',
      resolve: input.resolve
    });
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.mode === 'sandbox') throw new SandboxUnavailableError('No usable sandbox!');
    if (this.mode === 'throw') throw new Error('the page never loaded');
    return FAKE_WEBP;
  }

  callsFor(label: string): FakeCall[] {
    return this.calls.filter((c) => c.entry.includes(label));
  }
}

const PASSWORD = 'thumbnails-pass-0001';
const OWNER = { email: 'owner@thumbs.test', name: 'Thumbs Owner', password: PASSWORD };
const PLAIN = { email: 'plain@thumbs.test', name: 'Plain Member', password: PASSWORD };
const VIEWER = { email: 'viewer@thumbs.test', name: 'Project Viewer', password: PASSWORD };
const COLLAB = { email: 'collab@outside.test', name: 'Outside Reviewer', password: PASSWORD };

const UNKNOWN_DECK = '00000000-0000-4000-8000-0000000000ab';

const shaOf = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const htmlOf = (label: string) =>
  Buffer.from(
    `<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><h1>${label}</h1></body></html>`
  );
type Blob = { path: string; bytes: Buffer; contentType: string };
const entryOf = (b: Blob) => ({
  path: b.path,
  sha256: shaOf(b.bytes),
  sizeBytes: b.bytes.length,
  contentType: b.contentType
});

let container: StartedPostgreSqlContainer;

let ipCounter = 0;
const nextIp = () => `10.81.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

/** One booted app and the requests against it. */
function client(getApp: () => TestApp) {
  const send = (
    method: string,
    path: string,
    cookie: string,
    body?: unknown,
    headers: Record<string, string> = {}
  ) =>
    getApp().app.request(`/api/v1${path}`, {
      method,
      headers: {
        ...headers,
        cookie,
        'x-forwarded-for': nextIp(),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {})
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });

  const upload = async (cookie: string, b: Blob) => {
    const form = new FormData();
    form.set('sha256', shaOf(b.bytes));
    form.set('file', new Blob([new Uint8Array(b.bytes)], { type: b.contentType }), b.path);
    const res = await getApp().app.request('/api/v1/presentations/assets', {
      method: 'POST',
      headers: { cookie, 'x-forwarded-for': nextIp() },
      body: form
    });
    expect(res.status).toBe(201);
  };

  /** Reserve + commit a new deck; returns its id. */
  const pushDeck = async (cookie: string, title: string, blobs: Blob[]): Promise<string> => {
    for (const b of blobs) await upload(cookie, b);
    const reserve = await readJson(await send('POST', '/presentations/uploads', cookie));
    const res = await send('POST', `/presentations/uploads/${reserve.uploadSession.id}/commit`, cookie, {
      title,
      entryPath: 'index.html',
      manifest: blobs.map(entryOf)
    });
    expect(res.status).toBe(201);
    return (await readJson(res)).presentation.id as string;
  };

  /** A new version on an existing deck. */
  const pushVersion = async (cookie: string, id: string, base: number, blobs: Blob[]): Promise<void> => {
    for (const b of blobs) await upload(cookie, b);
    const res = await send('POST', `/presentations/${id}/versions`, cookie, {
      expectedBaseVersion: base,
      entryPath: 'index.html',
      manifest: blobs.map(entryOf)
    });
    expect(res.status).toBe(201);
  };

  const thumb = (cookie: string, id: string, version: number, headers: Record<string, string> = {}) =>
    send('GET', `/presentations/${id}/versions/${version}/thumbnail`, cookie, undefined, headers);

  const versionId = async (id: string, version: number): Promise<string> => {
    const { rows } = await getApp().db.pool.query(
      'SELECT id FROM presentation_versions WHERE presentation_id = $1 AND version = $2',
      [id, version]
    );
    return rows[0].id as string;
  };

  const row = async (vid: string) => {
    const { rows } = await getApp().db.pool.query(
      'SELECT state, attempts, lease_until, storage_key FROM presentation_version_thumbnails WHERE version_id = $1',
      [vid]
    );
    return rows[0] as
      { state: string; attempts: number; lease_until: Date | null; storage_key: string | null } | undefined;
  };

  const setup = async (instanceName: string): Promise<string> => {
    const res = await getApp().app.request('/api/v1/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() },
      body: JSON.stringify({ setupToken: 'integration-test-setup-token', instanceName, owner: OWNER })
    });
    expect(res.status).toBe(201);
    return signIn(OWNER.email);
  };

  const signIn = async (email: string): Promise<string> => {
    const res = await getApp().app.request('/api/v1/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() },
      body: JSON.stringify({ email, password: PASSWORD })
    });
    expect(res.status).toBe(200);
    return extractCookie(res);
  };

  return { send, upload, pushDeck, pushVersion, thumb, versionId, row, setup, signIn };
}

async function expectError(res: Response, status: number, code: string): Promise<void> {
  const body = await readJson(res.clone());
  expect({ status: res.status, code: body?.error?.code }).toEqual({ status, code });
  expect(res.headers.get('cache-control')).toBe('no-store');
}

beforeAll(async () => {
  container = await startPostgres();
}, 240_000);

afterAll(async () => {
  await container?.stop();
});

describe('capture on (a fake renderer)', () => {
  let app: TestApp;
  const fake = new FakeRenderer();
  const c = client(() => app);
  let ownerCookie = '';
  let plainCookie = '';
  let viewerCookie = '';
  let collabCookie = '';
  let viewerUserId = '';

  let deck = '';
  const DECK_HTML = htmlOf('deck-one');
  const CSS = Buffer.from('h1 { color: tomato; }');
  const CSV = Buffer.from('a,b\n1,2\n');
  const deckBlobs: Blob[] = [
    { path: 'index.html', bytes: DECK_HTML, contentType: 'text/plain' },
    { path: 'style.css', bytes: CSS, contentType: 'text/css' },
    { path: 'downloads/a.csv', bytes: CSV, contentType: 'text/csv' }
  ];

  beforeAll(async () => {
    const mail = new RecordingEmailDriver();
    app = await createTestApp(
      await createDatabase(container, 'thumbs_on'),
      {},
      {
        email: mail,
        tool: { thumbnailRenderer: fake }
      }
    );
    ownerCookie = await c.setup('Thumbnails');

    const join = async (p: typeof PLAIN): Promise<string> => {
      const invited = await readJson(
        await c.send('POST', '/invitations', ownerCookie, { email: p.email, role: 'member' })
      );
      const accept = await app.app.request('/api/v1/invitations/accept', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() },
        body: JSON.stringify({
          token: invited.acceptUrl.split('/invite/')[1],
          name: p.name,
          password: PASSWORD
        })
      });
      expect(accept.status).toBe(200);
      return c.signIn(p.email);
    };
    plainCookie = await join(PLAIN);
    viewerCookie = await join(VIEWER);
    viewerUserId = (await readJson(await c.send('GET', '/me', viewerCookie))).user.id;

    deck = await c.pushDeck(ownerCookie, 'Deck one', deckBlobs);
    await app.tool.thumbnails.idle();
  }, 240_000);

  afterAll(async () => {
    await app?.stop();
  });

  it('a push captures the version, and the route serves the image with its cache headers; If-None-Match answers 304', async () => {
    expect(fake.callsFor('deck-one')).toHaveLength(1);
    const vid = await c.versionId(deck, 1);
    const res = await c.thumb(ownerCookie, deck, 1);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(FAKE_WEBP);
    expect(res.headers.get('content-type')).toBe('image/webp');
    expect(res.headers.get('content-length')).toBe(String(FAKE_WEBP.length));
    expect(res.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(res.headers.get('etag')).toBe(`"${vid}"`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-disposition')).toBe('inline; filename="v1.webp"');

    const again = await c.thumb(ownerCookie, deck, 1, { 'if-none-match': `"${vid}"` });
    expect(again.status).toBe(304);
    expect(again.headers.get('etag')).toBe(`"${vid}"`);
    expect(again.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect((await again.arrayBuffer()).byteLength).toBe(0);
  });

  it('resolve serves the version’s own files only: the entry as HTML, an asset with its type, nothing else', async () => {
    const [call] = fake.callsFor('deck-one');
    const entry = await call!.resolve('index.html');
    // The manifest said text/plain: the entry still renders as a document.
    expect(entry).toEqual({ contentType: 'text/html; charset=utf-8', body: DECK_HTML });
    expect(await call!.resolve('style.css')).toEqual({ contentType: 'text/css', body: CSS });
    expect(await call!.resolve('../x')).toBeNull();
    expect(await call!.resolve('downloads/a.csv')).toBeNull();
    expect(await call!.resolve('nope.css')).toBeNull();
  });

  it('an older version is queued when asked for: pending first, the image once the drain ran', async () => {
    await c.pushVersion(ownerCookie, deck, 1, [
      { path: 'index.html', bytes: htmlOf('deck-one-v2'), contentType: 'text/html' },
      { path: 'style.css', bytes: CSS, contentType: 'text/css' }
    ]);
    await app.tool.thumbnails.idle();
    expect((await c.thumb(ownerCookie, deck, 2)).status).toBe(200);

    // Version 1 as a deck older than the feature holds it: no row at all.
    const v1 = await c.versionId(deck, 1);
    await app.db.pool.query('DELETE FROM presentation_version_thumbnails WHERE version_id = $1', [v1]);
    await expectError(await c.thumb(ownerCookie, deck, 1), 404, 'thumbnail_pending');
    expect((await c.row(v1))?.state).toBeDefined();
    await app.tool.thumbnails.idle();
    expect((await c.row(v1))?.state).toBe('ready');
    expect((await c.thumb(ownerCookie, deck, 1)).status).toBe(200);
  });

  it('an unknown version of a readable deck is not_found', async () => {
    await expectError(await c.thumb(ownerCookie, deck, 99), 404, 'not_found');
  });

  describe('who reads it: everyone who reads the deck, and nobody else can tell it exists', () => {
    let collaboratorId = '';

    beforeAll(async () => {
      const invited = await readJson(
        await c.send('POST', `/presentations/${deck}/collaborators`, ownerCookie, { email: COLLAB.email })
      );
      collaboratorId = invited.collaborator.id;
      const claim = await app.app.request('/api/v1/collaborators/claim', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() },
        body: JSON.stringify({
          token: invited.claimUrl.split('/collab/')[1],
          name: COLLAB.name,
          password: COLLAB.password
        })
      });
      expect(claim.status).toBe(200);
      collabCookie = await c.signIn(COLLAB.email);

      const project = (await readJson(await c.send('POST', '/projects', ownerCookie, { name: 'Launch' }))).id;
      const added = await c.send('POST', `/projects/${project}/members`, ownerCookie, {
        userId: viewerUserId,
        role: 'viewer'
      });
      expect(added.status).toBe(201);
      expect((await c.send('PUT', `/presentations/${deck}/projects/${project}`, ownerCookie)).status).toBe(
        200
      );
    });

    it('an active dev collaborator reads it', async () => {
      expect((await c.thumb(collabCookie, deck, 1)).status).toBe(200);
    });

    it('a project member of a linked project reads it', async () => {
      expect((await c.thumb(viewerCookie, deck, 1)).status).toBe(200);
    });

    it('a plain member with no grant gets the same bytes as for a deck that does not exist', async () => {
      const real = await c.thumb(plainCookie, deck, 1);
      const unknown = await c.thumb(plainCookie, UNKNOWN_DECK, 1);
      expect(real.status).toBe(404);
      expect(unknown.status).toBe(404);
      expect(real.headers.get('cache-control')).toBe('no-store');
      const realBody = await real.text();
      expect(realBody).toBe(await unknown.text());
      expect(JSON.parse(realBody).error.code).toBe('not_found');
    });

    it('revoking the collaborator cuts the image at once', async () => {
      const revoke = await c.send(
        'DELETE',
        `/presentations/${deck}/collaborators/${collaboratorId}`,
        ownerCookie
      );
      expect(revoke.status).toBe(200);
      await expectError(await c.thumb(collabCookie, deck, 1), 404, 'not_found');
    });
  });

  it(`a capture that keeps failing is given up after ${MAX_ATTEMPTS} attempts, and says so`, async () => {
    fake.mode = 'throw';
    try {
      const failing = await c.pushDeck(ownerCookie, 'Failing', [
        { path: 'index.html', bytes: htmlOf('deck-failing'), contentType: 'text/html' }
      ]);
      await app.tool.thumbnails.idle();
      const vid = await c.versionId(failing, 1);
      expect(fake.callsFor('deck-failing')).toHaveLength(1);
      await expectError(await c.thumb(ownerCookie, failing, 1), 404, 'thumbnail_pending');

      // Each retry waits out its delay: fast-forward the lease, then sweep.
      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        await app.db.pool.query(
          "UPDATE presentation_version_thumbnails SET lease_until = now() - interval '1 second' WHERE version_id = $1",
          [vid]
        );
        await app.tool.thumbnails.sweep();
      }
      expect((await c.row(vid))?.state).toBe('failed');
      expect(fake.callsFor('deck-failing')).toHaveLength(MAX_ATTEMPTS);
      await expectError(await c.thumb(ownerCookie, failing, 1), 404, 'thumbnail_failed');
    } finally {
      fake.mode = 'ok';
    }
  });

  it('the sweep backfills a live deck’s current version that was never queued, never a deleted deck’s', async () => {
    const old = await c.pushDeck(ownerCookie, 'Older than the feature', [
      { path: 'index.html', bytes: htmlOf('deck-backfill'), contentType: 'text/html' }
    ]);
    const gone = await c.pushDeck(ownerCookie, 'Deleted', [
      { path: 'index.html', bytes: htmlOf('deck-deleted'), contentType: 'text/html' }
    ]);
    await app.tool.thumbnails.idle();
    expect((await c.send('DELETE', `/presentations/${gone}`, ownerCookie)).status).toBe(200);
    const oldVid = await c.versionId(old, 1);
    const goneVid = await c.versionId(gone, 1);
    await app.db.pool.query('DELETE FROM presentation_version_thumbnails WHERE version_id = ANY($1)', [
      [oldVid, goneVid]
    ]);
    const before = fake.callsFor('deck-backfill').length;

    await app.tool.thumbnails.sweep();

    expect(fake.callsFor('deck-backfill')).toHaveLength(before + 1);
    expect((await c.row(oldVid))?.state).toBe('ready');
    expect(await c.row(goneVid)).toBeUndefined();
    expect(fake.callsFor('deck-deleted')).toHaveLength(1); // its push only
  });

  it('two drains at once never capture one version twice', async () => {
    const labels = ['deck-race-1', 'deck-race-2', 'deck-race-3'];
    const decks: string[] = [];
    for (const label of labels) {
      decks.push(
        await c.pushDeck(ownerCookie, label, [
          { path: 'index.html', bytes: htmlOf(label), contentType: 'text/html' }
        ])
      );
    }
    await app.tool.thumbnails.idle();
    // Back to "never captured": both drains seed and claim the same three.
    const vids = await Promise.all(decks.map((d) => c.versionId(d, 1)));
    await app.db.pool.query('DELETE FROM presentation_version_thumbnails WHERE version_id = ANY($1)', [vids]);
    const before = labels.map((l) => fake.callsFor(l).length);

    const other = new FakeRenderer();
    other.delayMs = 30;
    fake.delayMs = 30;
    const second = new ThumbnailService({
      db: app.db.db,
      storage: createStorageDriver(app.env),
      logger: app.logger,
      renderer: other
    });
    try {
      await Promise.all([app.tool.thumbnails.sweep(), second.sweep()]);
    } finally {
      fake.delayMs = 0;
    }

    const captured = labels.map((l, i) => fake.callsFor(l).length - before[i]! + other.callsFor(l).length);
    expect(captured).toEqual([1, 1, 1]);
    for (const vid of vids) expect((await c.row(vid))?.state).toBe('ready');
  });
});

describe('Chromium’s sandbox cannot start', () => {
  let app: TestApp;
  const fake = new FakeRenderer();
  fake.mode = 'sandbox';
  const c = client(() => app);
  let cookie = '';

  beforeAll(async () => {
    app = await createTestApp(
      await createDatabase(container, 'thumbs_sandbox'),
      {},
      {
        tool: { thumbnailRenderer: fake }
      }
    );
    cookie = await c.setup('Sandbox down');
  }, 240_000);

  afterAll(async () => {
    await app?.stop();
  });

  it('capture turns off in the process, the row keeps its attempts, and the route says unavailable', async () => {
    const deck = await c.pushDeck(cookie, 'Sandboxed', [
      { path: 'index.html', bytes: htmlOf('deck-sandbox'), contentType: 'text/html' }
    ]);
    await app.tool.thumbnails.idle();
    expect(app.tool.thumbnails.capturing).toBe(false);
    const vid = await c.versionId(deck, 1);
    const r = await c.row(vid);
    expect(r?.state).toBe('pending');
    expect(r?.attempts).toBe(0);
    await expectError(await c.thumb(cookie, deck, 1), 404, 'thumbnail_unavailable');

    await app.tool.thumbnails.sweep();
    await app.tool.thumbnails.sweep();
    expect(fake.calls).toHaveLength(1);
  });
});

describe('capture off (no renderer: switched off, or an api-only replica)', () => {
  let app: TestApp;
  const c = client(() => app);
  let cookie = '';

  beforeAll(async () => {
    app = await createTestApp(
      await createDatabase(container, 'thumbs_off'),
      {},
      {
        tool: { thumbnailRenderer: null }
      }
    );
    cookie = await c.setup('Capture off');
  }, 240_000);

  afterAll(async () => {
    await app?.stop();
  });

  it('the route answers unavailable and the version waits in the queue for a process that captures', async () => {
    const deck = await c.pushDeck(cookie, 'Off', [
      { path: 'index.html', bytes: htmlOf('deck-off'), contentType: 'text/html' }
    ]);
    await app.tool.thumbnails.sweep();
    expect(app.tool.thumbnails.capturing).toBe(false);
    await expectError(await c.thumb(cookie, deck, 1), 404, 'thumbnail_unavailable');
    const r = await c.row(await c.versionId(deck, 1));
    expect(r?.state).toBe('pending');
    expect(r?.attempts).toBe(0);
    expect(r?.storage_key).toBeNull();
  });

  it('an api-only replica of an instance whose worker captures answers pending, never unavailable', async () => {
    const deck = await c.pushDeck(cookie, 'Api replica', [
      { path: 'index.html', bytes: htmlOf('deck-api-replica'), contentType: 'text/html' }
    ]);
    const versionId = await c.versionId(deck, 1);
    const apiReplica = new ThumbnailService({
      db: app.db.db,
      storage: createStorageDriver(app.env),
      logger: app.logger,
      renderer: null,
      capturedElsewhere: true
    });
    const ws = (await app.db.pool.query('SELECT workspace_id FROM presentations WHERE id = $1', [deck]))
      .rows[0].workspace_id as string;
    expect(await apiReplica.status({ workspaceId: ws, presentationId: deck, versionId })).toEqual({
      state: 'pending'
    });
  });
});
