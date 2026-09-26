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
import type { RendererClient, RendererJob, SubmitOutcome } from '../../src/thumbnails/renderer-client.js';
import { MAX_ATTEMPTS, MAX_IN_FLIGHT, ThumbnailService } from '../../src/thumbnails/service.js';
import { IMAGE_MAX_BYTES } from '../../src/thumbnails/routes.js';

/**
 * The still image of each deck version (PRDCT-2725), end to end over the real
 * app with a FAKE RENDERER that plays the renderer container's side of the
 * protocol over the app's own routes (the real Chromium renderer is
 * apps/renderer's suite): the push hands the version off, the renderer pulls
 * the version's files with its one-time key and puts the image back with it,
 * the read route serves it under the deck's own read rule (ADR 013 + ADR
 * 026, 404 never 403), the key opens one version and dies with the outcome,
 * the queue retries and gives up, a renderer that is busy or down costs no
 * attempt, the sweep backfills decks older than the feature, the in-flight
 * cap holds, and two drains at once never hand one version off twice.
 */

/** A small fixed WebP-shaped body: the route serves bytes, it never decodes them. */
const FAKE_WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0x20, 0, 0, 0]),
  Buffer.from('WEBPVP8 '),
  Buffer.alloc(24, 0x5a)
]);

type FakeJob = RendererJob & { entry: string };
type FakeMode = 'ok' | 'fail' | 'transient' | 'busy' | 'unreachable' | 'hold';

const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');

/**
 * The renderer container as Slideless sees it, minus Chromium: takes the job,
 * then, a moment later and on its own, pulls the entry (and the stylesheet
 * when the page names one) through the app's internal routes with the job's
 * key and puts the image back the same way. `mode` switches what it does;
 * `hold` takes the job and answers nothing until `finish`.
 */
class FakeRenderer implements RendererClient {
  jobs: FakeJob[] = [];
  mode: FakeMode = 'ok';
  delayMs = 0;
  private readonly inflight = new Set<Promise<void>>();
  private readonly held: FakeJob[] = [];

  constructor(private readonly getApp: () => TestApp) {}

  async submit(job: RendererJob): Promise<SubmitOutcome> {
    if (this.mode === 'busy') return 'busy';
    if (this.mode === 'unreachable') return 'unreachable';
    const fake: FakeJob = { ...job, entry: '' };
    this.jobs.push(fake);
    if (this.mode === 'hold') {
      this.held.push(fake);
      // The entry is read now so the job can be told apart by its label.
      this.track(this.readEntry(fake));
      return 'queued';
    }
    this.track(
      (async () => {
        if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
        await this.render(fake);
      })()
    );
    return 'queued';
  }

  private track(p: Promise<void>): void {
    const tracked = p.finally(() => this.inflight.delete(tracked));
    this.inflight.add(tracked);
  }

  /** Wait until every render the fake started has answered. */
  async settle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.all([...this.inflight]);
  }

  /** `hold` mode: answer one held job now. Throws when the key no longer opens the job. */
  async finish(job: FakeJob): Promise<void> {
    const i = this.held.indexOf(job);
    if (i < 0) throw new Error('not a held job');
    this.held.splice(i, 1);
    const res = await this.put(job, FAKE_WEBP);
    if (res.status !== 204) throw new Error(`finish: the image was refused with ${res.status}`);
  }

  isHeld(job: FakeJob): boolean {
    return this.held.includes(job);
  }

  jobsFor(label: string): FakeJob[] {
    return this.jobs.filter((j) => j.entry.includes(label));
  }

  private async readEntry(job: FakeJob): Promise<void> {
    const res = await this.get(job, job.entryPath);
    job.entry = res.status === 200 ? await res.text() : `<status ${res.status}>`;
  }

  private async render(job: FakeJob): Promise<void> {
    await this.readEntry(job);
    if (job.entry.includes('style.css')) await this.get(job, 'style.css');
    if (this.mode === 'fail') {
      await this.failure(job, { error: 'the page never loaded' });
      return;
    }
    if (this.mode === 'transient') {
      await this.failure(job, { error: 'the browser would not start', transient: true });
      return;
    }
    await this.put(job, FAKE_WEBP);
  }

  async get(job: RendererJob, path: string, token = job.token): Promise<Response> {
    return this.getApp().app.request(`/internal/renderer/jobs/${job.job}/files/${encodePath(path)}`, {
      headers: { authorization: `Bearer ${token}` }
    });
  }

  async put(
    job: RendererJob,
    bytes: Buffer,
    opts: { token?: string; contentType?: string } = {}
  ): Promise<Response> {
    return this.getApp().app.request(`/internal/renderer/jobs/${job.job}/image`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${opts.token ?? job.token}`,
        'content-type': opts.contentType ?? 'image/webp',
        'content-length': String(bytes.length)
      },
      body: new Uint8Array(bytes)
    });
  }

  async failure(job: RendererJob, body: unknown, token = job.token): Promise<Response> {
    return this.getApp().app.request(`/internal/renderer/jobs/${job.job}/failure`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
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
      'SELECT state, attempts, lease_until, storage_key, claim_token_hash, error FROM presentation_version_thumbnails WHERE version_id = $1',
      [vid]
    );
    return rows[0] as
      | {
          state: string;
          attempts: number;
          lease_until: Date | null;
          storage_key: string | null;
          claim_token_hash: string | null;
          error: string | null;
        }
      | undefined;
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

describe('a renderer takes the jobs (a fake playing the protocol)', () => {
  let app: TestApp;
  const fake = new FakeRenderer(() => app);
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

  /** The handoff, the fake's answer, and the drain the answer kicks. */
  const flush = async () => {
    for (let i = 0; i < 3; i++) {
      await app.tool.thumbnails.idle();
      await fake.settle();
    }
  };

  const expireLease = (vid: string) =>
    app.db.pool.query(
      "UPDATE presentation_version_thumbnails SET lease_until = now() - interval '1 second' WHERE version_id = $1",
      [vid]
    );

  beforeAll(async () => {
    const mail = new RecordingEmailDriver();
    app = await createTestApp(
      await createDatabase(container, 'thumbs_on'),
      {},
      {
        email: mail,
        tool: { rendererClient: fake }
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
    await flush();
  }, 240_000);

  afterAll(async () => {
    await app?.stop();
  });

  it('a push hands the version off, the image lands, and the route serves it with its cache headers; If-None-Match answers 304', async () => {
    expect(fake.jobsFor('deck-one')).toHaveLength(1);
    const vid = await c.versionId(deck, 1);
    expect(fake.jobsFor('deck-one')[0]!.job).toBe(vid);
    const res = await c.thumb(ownerCookie, deck, 1);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(FAKE_WEBP);
    expect(res.headers.get('content-type')).toBe('image/webp');
    expect(res.headers.get('content-length')).toBe(String(FAKE_WEBP.length));
    expect(res.headers.get('cache-control')).toBe('private, no-cache');
    expect(res.headers.get('etag')).toBe(`"${vid}"`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-disposition')).toBe('inline; filename="v1.webp"');

    const again = await c.thumb(ownerCookie, deck, 1, { 'if-none-match': `"${vid}"` });
    expect(again.status).toBe(304);
    expect(again.headers.get('etag')).toBe(`"${vid}"`);
    expect(again.headers.get('cache-control')).toBe('private, no-cache');
    expect((await again.arrayBuffer()).byteLength).toBe(0);

    // The key died with the image: nothing opens under it any more.
    const [job] = fake.jobsFor('deck-one');
    expect((await fake.get(job!, 'index.html')).status).toBe(401);
    expect((await fake.put(job!, FAKE_WEBP)).status).toBe(401);
    expect((await fake.failure(job!, { error: 'late' })).status).toBe(401);
    const row = await c.row(vid);
    expect(row?.state).toBe('ready');
    expect(row?.claim_token_hash).toBeNull();
  });

  describe('the files leg: the version’s own files under the job’s key, nothing else', () => {
    let held = '';
    let job: FakeJob;

    beforeAll(async () => {
      fake.mode = 'hold';
      held = await c.pushDeck(
        ownerCookie,
        'Held',
        deckBlobs.map((b) => ({ ...b, bytes: b.path === 'index.html' ? htmlOf('deck-held') : b.bytes }))
      );
      await flush();
      job = fake.jobsFor('deck-held')[0]!;
    });

    afterAll(async () => {
      fake.mode = 'ok';
      await fake.finish(job);
      await flush();
      expect((await c.thumb(ownerCookie, held, 1)).status).toBe(200);
    });

    it('serves the entry as HTML whatever the manifest claims, and an asset with its type, no-store and nosniff', async () => {
      const entry = await fake.get(job, 'index.html');
      expect(entry.status).toBe(200);
      expect(entry.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(entry.headers.get('cache-control')).toBe('no-store');
      expect(entry.headers.get('x-content-type-options')).toBe('nosniff');
      expect(Buffer.from(await entry.arrayBuffer())).toEqual(htmlOf('deck-held'));
      const css = await fake.get(job, 'style.css');
      expect(css.status).toBe(200);
      expect(css.headers.get('content-type')).toBe('text/css');
      expect(Buffer.from(await css.arrayBuffer())).toEqual(CSS);
    });

    it('refuses a traversal, an attachment under downloads/, and a path the manifest does not hold', async () => {
      // A `..` never survives a URL parser, so the traversal rule is met at
      // the service, where a path arrives however it was spelled.
      expect(await app.tool.thumbnails.fileFor({ job: job.job, token: job.token, path: '../x' })).toBeNull();
      expect(
        await app.tool.thumbnails.fileFor({ job: job.job, token: job.token, path: '/index.html' })
      ).toBeNull();
      expect((await fake.get(job, 'downloads/a.csv')).status).toBe(404);
      expect((await fake.get(job, 'nope.css')).status).toBe(404);
      expect(
        (
          await app.app.request(`/internal/renderer/jobs/${job.job}/files/%ZZ`, {
            headers: { authorization: `Bearer ${job.token}` }
          })
        ).status
      ).toBe(404);
    });

    it('a wrong key, a key on another job, or no key answers 401 with nothing else', async () => {
      const wrong = await fake.get(job, 'index.html', 'x'.repeat(43));
      expect(wrong.status).toBe(401);
      expect(await readJson(wrong)).toEqual({
        error: { code: 'unauthorized', message: 'No key for this job' }
      });
      const otherVersion = await c.versionId(deck, 1);
      const foreign = await fake.get({ ...job, job: otherVersion }, 'index.html');
      expect(foreign.status).toBe(401);
      expect((await fake.get(job, 'index.html', '')).status).toBe(401);
      expect((await fake.get(job, 'index.html', 'short')).status).toBe(401);
    });

    it('the image leg refuses bytes that are not a WebP, a wrong media type, an oversize body, and a foreign key; the row stays pending', async () => {
      expect((await fake.put(job, Buffer.from('<html>not an image</html>'))).status).toBe(400);
      expect((await fake.put(job, FAKE_WEBP, { contentType: 'image/png' })).status).toBe(415);
      // The cap is 2 MiB on the wire, as a number (verifier round 1, F4): a
      // test that derives it from the constant would follow the constant up.
      expect(IMAGE_MAX_BYTES).toBe(2 * 1024 * 1024);
      const big = Buffer.alloc(2 * 1024 * 1024 + 1, 0x5a);
      big.write('RIFF', 0, 'latin1');
      big.write('WEBP', 8, 'latin1');
      expect((await fake.put(job, big)).status).toBe(413);
      const justUnder = Buffer.alloc(2 * 1024 * 1024 - 64, 0x5a);
      justUnder.write('RIFF', 0, 'latin1');
      justUnder.write('WEBP', 8, 'latin1');
      // Under the cap the bytes are read and judged (a WebP-shaped body of the
      // right type is accepted); the same body under a WRONG key is refused
      // before a byte is read (verifier round 1, F1): 401, never 400 or 413.
      expect((await fake.put(job, big, { token: 'y'.repeat(43) })).status).toBe(401);
      expect((await fake.put(job, Buffer.from('<html>'), { token: 'y'.repeat(43) })).status).toBe(401);
      expect(
        (await fake.put(job, FAKE_WEBP, { token: 'y'.repeat(43), contentType: 'image/png' })).status
      ).toBe(401);
      expect((await fake.failure(job, 'not json', 'y'.repeat(43))).status).toBe(401);
      expect((await fake.put(job, FAKE_WEBP, { token: 'y'.repeat(43) })).status).toBe(401);
      const otherVersion = await c.versionId(deck, 1);
      expect((await fake.put({ ...job, job: otherVersion }, FAKE_WEBP)).status).toBe(401);
      const row = await c.row(job.job);
      expect(row?.state).toBe('pending');
      expect(row?.claim_token_hash).not.toBeNull();
      await expectError(await c.thumb(ownerCookie, held, 1), 404, 'thumbnail_pending');
    });

    it('a failure report needs a body with an error line', async () => {
      expect((await fake.failure(job, { nope: 1 })).status).toBe(400);
      expect((await fake.failure(job, 'not json at all')).status).toBe(400);
      expect((await c.row(job.job))?.state).toBe('pending');
    });
  });

  it('an older version is queued when asked for: pending first, then handed off, then the image', async () => {
    await c.pushVersion(ownerCookie, deck, 1, [
      { path: 'index.html', bytes: htmlOf('deck-one-v2'), contentType: 'text/html' },
      { path: 'style.css', bytes: CSS, contentType: 'text/css' }
    ]);
    await flush();
    expect((await c.thumb(ownerCookie, deck, 2)).status).toBe(200);

    // Version 1 as a deck older than the feature holds it: no row at all.
    const v1 = await c.versionId(deck, 1);
    await app.db.pool.query('DELETE FROM presentation_version_thumbnails WHERE version_id = $1', [v1]);
    const before = fake.jobsFor('deck-one').length;
    await expectError(await c.thumb(ownerCookie, deck, 1), 404, 'thumbnail_pending');
    expect((await c.row(v1))?.state).toBe('pending');
    await flush();
    expect(fake.jobsFor('deck-one')).toHaveLength(before + 1);
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

  it(`a capture the renderer keeps failing is given up after ${MAX_ATTEMPTS} attempts, and says so`, async () => {
    fake.mode = 'fail';
    try {
      const failing = await c.pushDeck(ownerCookie, 'Failing', [
        { path: 'index.html', bytes: htmlOf('deck-failing'), contentType: 'text/html' }
      ]);
      await flush();
      const vid = await c.versionId(failing, 1);
      expect(fake.jobsFor('deck-failing')).toHaveLength(1);
      await expectError(await c.thumb(ownerCookie, failing, 1), 404, 'thumbnail_pending');
      let row = await c.row(vid);
      expect(row?.attempts).toBe(1);
      expect(row?.error).toBe('the page never loaded');
      expect(row?.claim_token_hash).toBeNull();

      // Each retry waits out its delay: fast-forward the lease, then sweep.
      for (let i = 1; i < MAX_ATTEMPTS; i++) {
        await expireLease(vid);
        await app.tool.thumbnails.sweep();
        await flush();
      }
      row = await c.row(vid);
      expect(row?.state).toBe('failed');
      expect(fake.jobsFor('deck-failing')).toHaveLength(MAX_ATTEMPTS);
      await expectError(await c.thumb(ownerCookie, failing, 1), 404, 'thumbnail_failed');
      // Given up: a sweep hands it off no more.
      await app.tool.thumbnails.sweep();
      await flush();
      expect(fake.jobsFor('deck-failing')).toHaveLength(MAX_ATTEMPTS);
    } finally {
      fake.mode = 'ok';
    }
  });

  it('a transient failure counts the attempt and is retried sooner', async () => {
    fake.mode = 'transient';
    try {
      const d = await c.pushDeck(ownerCookie, 'Transient', [
        { path: 'index.html', bytes: htmlOf('deck-transient'), contentType: 'text/html' }
      ]);
      await flush();
      const vid = await c.versionId(d, 1);
      const row = await c.row(vid);
      expect(row?.state).toBe('pending');
      expect(row?.attempts).toBe(1);
      expect(row?.error).toBe('the browser would not start');
      expect(row?.claim_token_hash).toBeNull();
      const wait = row!.lease_until!.getTime() - Date.now();
      expect(wait).toBeGreaterThan(0);
      expect(wait).toBeLessThan(60_000);
      fake.mode = 'ok';
      await expireLease(vid);
      await app.tool.thumbnails.sweep();
      await flush();
      expect((await c.row(vid))?.state).toBe('ready');
      expect((await c.row(vid))?.attempts).toBe(2);
    } finally {
      fake.mode = 'ok';
    }
  });

  it(`transient failures alone give up after ${MAX_ATTEMPTS} attempts too`, async () => {
    fake.mode = 'transient';
    try {
      const d = await c.pushDeck(ownerCookie, 'Always transient', [
        { path: 'index.html', bytes: htmlOf('deck-always-transient'), contentType: 'text/html' }
      ]);
      await flush();
      const vid = await c.versionId(d, 1);
      for (let i = 1; i < MAX_ATTEMPTS; i++) {
        await expireLease(vid);
        await app.tool.thumbnails.sweep();
        await flush();
      }
      expect((await c.row(vid))?.state).toBe('failed');
      expect(fake.jobsFor('deck-always-transient')).toHaveLength(MAX_ATTEMPTS);
    } finally {
      fake.mode = 'ok';
    }
  });

  it('a renderer that is busy or unreachable costs no attempt: the claim is given back with a backoff', async () => {
    for (const mode of ['busy', 'unreachable'] as const) {
      fake.mode = mode;
      try {
        const d = await c.pushDeck(ownerCookie, `Renderer ${mode}`, [
          { path: 'index.html', bytes: htmlOf(`deck-${mode}`), contentType: 'text/html' }
        ]);
        await flush();
        const vid = await c.versionId(d, 1);
        const row = await c.row(vid);
        expect(row?.state).toBe('pending');
        expect(row?.attempts).toBe(0);
        expect(row?.claim_token_hash).toBeNull();
        expect(row?.lease_until!.getTime()).toBeGreaterThan(Date.now());
        await expectError(await c.thumb(ownerCookie, d, 1), 404, 'thumbnail_pending');
        fake.mode = 'ok';
        await expireLease(vid);
        await app.tool.thumbnails.sweep();
        await flush();
        expect((await c.row(vid))?.state).toBe('ready');
        expect((await c.row(vid))?.attempts).toBe(1);
      } finally {
        fake.mode = 'ok';
      }
    }
  });

  it('a lease that runs out is handed off again under a NEW key, and the old key opens nothing', async () => {
    fake.mode = 'hold';
    try {
      const d = await c.pushDeck(ownerCookie, 'Lost renderer', [
        { path: 'index.html', bytes: htmlOf('deck-lost'), contentType: 'text/html' }
      ]);
      await flush();
      const vid = await c.versionId(d, 1);
      const first = fake.jobsFor('deck-lost')[0]!;
      await expireLease(vid);
      await app.tool.thumbnails.sweep();
      await flush();
      const jobs = fake.jobsFor('deck-lost');
      expect(jobs).toHaveLength(2);
      const second = jobs[1]!;
      expect(second.token).not.toBe(first.token);
      expect((await fake.put(first, FAKE_WEBP)).status).toBe(401);
      expect((await c.row(vid))?.state).toBe('pending');
      expect((await fake.put(second, FAKE_WEBP)).status).toBe(204);
      expect((await c.row(vid))?.state).toBe('ready');
      // The first (lost) renderer answering late changes nothing.
      expect((await fake.put(first, FAKE_WEBP)).status).toBe(401);
      expect((await fake.put(second, FAKE_WEBP)).status).toBe(401);
    } finally {
      fake.mode = 'ok';
      await fake.settle();
    }
  });

  it('a lease that ran out opens nothing under its key, even before anyone claims the version again', async () => {
    fake.mode = 'hold';
    try {
      const d = await c.pushDeck(ownerCookie, 'Late renderer', [
        { path: 'index.html', bytes: htmlOf('deck-late'), contentType: 'text/html' }
      ]);
      await flush();
      const vid = await c.versionId(d, 1);
      const job = fake.jobsFor('deck-late')[0]!;
      expect((await fake.get(job, 'index.html')).status).toBe(200);
      // The lease runs out; nobody has claimed the version again (the hash is still this key's).
      await expireLease(vid);
      expect((await c.row(vid))?.claim_token_hash).not.toBeNull();
      expect((await fake.get(job, 'index.html')).status).toBe(401);
      expect((await fake.put(job, FAKE_WEBP)).status).toBe(401);
      expect((await fake.failure(job, { error: 'late' })).status).toBe(401);
      const row = await c.row(vid);
      expect(row?.state).toBe('pending');
      expect(row?.storage_key).toBeNull();
      // The sweep hands it off again under a new key, which works.
      await app.tool.thumbnails.sweep();
      await flush();
      const again = fake.jobsFor('deck-late')[1]!;
      expect((await fake.put(again, FAKE_WEBP)).status).toBe(204);
      expect((await c.row(vid))?.state).toBe('ready');
    } finally {
      fake.mode = 'ok';
    }
  });

  it('a claim re-issued between the read of a key and the write of its image leaves the row to the new holder', async () => {
    fake.mode = 'hold';
    try {
      const d = await c.pushDeck(ownerCookie, 'Raced renderer', [
        { path: 'index.html', bytes: htmlOf('deck-raced'), contentType: 'text/html' }
      ]);
      await flush();
      const vid = await c.versionId(d, 1);
      const first = fake.jobsFor('deck-raced')[0]!;
      // A service whose storage write is where the race lands: while the
      // first holder's image is being written, its lease runs out and the
      // version is handed off again under a new key.
      const base = createStorageDriver(app.env);
      const other = new FakeRenderer(() => app);
      other.mode = 'hold';
      const second = new ThumbnailService({
        db: app.db.db,
        storage: base,
        logger: app.logger,
        renderer: other
      });
      const racing = new ThumbnailService({
        db: app.db.db,
        storage: {
          ...base,
          put: async (key, data, opts) => {
            await expireLease(vid);
            await second.sweep();
            await other.settle();
            return base.put(key, data, opts);
          }
        } as typeof base,
        logger: app.logger,
        renderer: fake
      });
      expect(await racing.complete({ job: vid, token: first.token, webp: FAKE_WEBP })).toBe('rejected');
      const row = await c.row(vid);
      expect(row?.state).toBe('pending');
      const newHolder = other.jobsFor('deck-raced')[0]!;
      expect(newHolder.token).not.toBe(first.token);
      expect((await fake.put(newHolder, FAKE_WEBP)).status).toBe(204);
      const ready = await c.row(vid);
      expect(ready?.state).toBe('ready');
      // The row names the winner's object, not the loser's late write.
      expect(ready?.storage_key).toContain(`${vid}-`);
      expect((await c.thumb(ownerCookie, d, 1)).status).toBe(200);
    } finally {
      fake.mode = 'ok';
    }
  });

  it(`at most ${MAX_IN_FLIGHT} versions are handed off at once; an answer lets the next one through`, async () => {
    fake.mode = 'hold';
    try {
      const labels = Array.from({ length: MAX_IN_FLIGHT + 2 }, (_, i) => `deck-cap-${i}`);
      for (const label of labels) {
        await c.pushDeck(ownerCookie, label, [
          { path: 'index.html', bytes: htmlOf(label), contentType: 'text/html' }
        ]);
      }
      await flush();
      const handed = () => labels.filter((l) => fake.jobsFor(l).length > 0).length;
      const heldJobs = () => labels.flatMap((l) => fake.jobsFor(l)).filter((j) => fake.isHeld(j));
      expect(handed()).toBe(MAX_IN_FLIGHT);
      await fake.finish(heldJobs()[0]!);
      await flush();
      expect(handed()).toBe(MAX_IN_FLIGHT + 1);
      await fake.finish(heldJobs()[0]!);
      await flush();
      expect(handed()).toBe(MAX_IN_FLIGHT + 2);
      for (const j of heldJobs()) await fake.finish(j);
      await flush();
      for (const l of labels) expect((await c.row(fake.jobsFor(l)[0]!.job))?.state).toBe('ready');
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
    await flush();
    expect((await c.send('DELETE', `/presentations/${gone}`, ownerCookie)).status).toBe(200);
    const oldVid = await c.versionId(old, 1);
    const goneVid = await c.versionId(gone, 1);
    await app.db.pool.query('DELETE FROM presentation_version_thumbnails WHERE version_id = ANY($1)', [
      [oldVid, goneVid]
    ]);
    const before = fake.jobsFor('deck-backfill').length;

    await app.tool.thumbnails.sweep();
    await flush();

    expect(fake.jobsFor('deck-backfill')).toHaveLength(before + 1);
    expect((await c.row(oldVid))?.state).toBe('ready');
    expect(await c.row(goneVid)).toBeUndefined();
    expect(fake.jobsFor('deck-deleted')).toHaveLength(1); // its push only
  });

  it('two drains at once never hand one version off twice', async () => {
    const labels = ['deck-race-1', 'deck-race-2', 'deck-race-3'];
    const decks: string[] = [];
    for (const label of labels) {
      decks.push(
        await c.pushDeck(ownerCookie, label, [
          { path: 'index.html', bytes: htmlOf(label), contentType: 'text/html' }
        ])
      );
    }
    await flush();
    // Back to "never captured": both drains seed and claim the same three.
    const vids = await Promise.all(decks.map((d) => c.versionId(d, 1)));
    await app.db.pool.query('DELETE FROM presentation_version_thumbnails WHERE version_id = ANY($1)', [vids]);
    const before = labels.map((l) => fake.jobsFor(l).length);

    const other = new FakeRenderer(() => app);
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
      await flush();
      await other.settle();
      await second.idle();
    } finally {
      fake.delayMs = 0;
    }

    const handed = labels.map((l, i) => fake.jobsFor(l).length - before[i]! + other.jobsFor(l).length);
    expect(handed).toEqual([1, 1, 1]);
    for (const vid of vids) expect((await c.row(vid))?.state).toBe('ready');
  });
});

describe('no renderer configured', () => {
  let app: TestApp;
  const c = client(() => app);
  let cookie = '';

  beforeAll(async () => {
    app = await createTestApp(
      await createDatabase(container, 'thumbs_off'),
      {},
      { tool: { rendererClient: null } }
    );
    cookie = await c.setup('No renderer');
  }, 240_000);

  afterAll(async () => {
    await app?.stop();
  });

  it('the route answers unavailable and the version waits in the queue, untouched, for a renderer configured later', async () => {
    const deck = await c.pushDeck(cookie, 'Off', [
      { path: 'index.html', bytes: htmlOf('deck-off'), contentType: 'text/html' }
    ]);
    await app.tool.thumbnails.sweep();
    expect(app.tool.thumbnails.enabled).toBe(false);
    await expectError(await c.thumb(cookie, deck, 1), 404, 'thumbnail_unavailable');
    const r = await c.row(await c.versionId(deck, 1));
    expect(r?.state).toBe('pending');
    expect(r?.attempts).toBe(0);
    expect(r?.storage_key).toBeNull();
    expect(r?.claim_token_hash).toBeNull();
  });

  it('the internal routes answer 401 to any key: nothing was ever handed out', async () => {
    const deck = await c.pushDeck(cookie, 'Off two', [
      { path: 'index.html', bytes: htmlOf('deck-off-2'), contentType: 'text/html' }
    ]);
    const vid = await c.versionId(deck, 1);
    const res = await app.app.request(`/internal/renderer/jobs/${vid}/files/index.html`, {
      headers: { authorization: `Bearer ${'a'.repeat(43)}` }
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});
