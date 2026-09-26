import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';
import { createLog, type Log } from '../src/log.js';
import {
  CaptureQueue,
  DEADLINE_MESSAGE,
  UNREACHABLE_MESSAGE,
  failureLine,
  type QueuedJob
} from '../src/queue.js';
import { SandboxUnavailableError, type CaptureInput } from '../src/renderer.js';
import { isSelfCheckEntry } from '../src/selfcheck.js';
import { createRendererServer } from '../src/server.js';
import { FILE_MAX_BYTES, SlidelessClient, encodeManifestPath } from '../src/slideless.js';

/**
 * The renderer's own surface (PRDCT-2725) without Chromium: `POST /capture`
 * and `/healthz`, the queue's outcomes, and the three calls back to a fake
 * Slideless under the job's key. The capture function is injected.
 */

const SECRET = 'a-shared-secret-of-32-characters';
const JOB = '33333333-3333-4333-8333-333333333333';
const TOKEN = 'A'.repeat(21) + '_' + 'b'.repeat(20) + '-';
const WEBP = Buffer.concat([Buffer.from('RIFF\0\0\0\0WEBPVP8 '), Buffer.alloc(16)]);

const silent: Log = createLog('error', () => {});

function listen(server: Server): Promise<string> {
  return new Promise((r) =>
    server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))
  );
}
const close = (s: Server) =>
  new Promise<void>((r) => {
    s.closeAllConnections();
    s.close(() => r());
  });

function job(over: Partial<QueuedJob> = {}): QueuedJob {
  return {
    job: JOB,
    token: TOKEN,
    entryPath: 'index.html',
    deadline: new Date(Date.now() + 60_000).toISOString(),
    ...over
  };
}

/** A fake Slideless: the version's files, and every callback it received. */
interface Received {
  method: string;
  path: string;
  auth: string | undefined;
  contentType: string | undefined;
  body: Buffer;
}
function fakeSlideless(
  files: Record<string, string | Buffer>,
  opts: { refuseKey?: boolean; fileStatus?: number } = {}
) {
  const received: Received[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const path = req.url ?? '';
      received.push({
        method: req.method ?? '',
        path,
        auth: req.headers.authorization,
        contentType: req.headers['content-type'],
        body: Buffer.concat(chunks)
      });
      if (req.headers.authorization !== `Bearer ${TOKEN}` || opts.refuseKey) {
        res.writeHead(401);
        res.end();
        return;
      }
      const prefix = `/internal/renderer/jobs/${JOB}/`;
      if (!path.startsWith(prefix)) {
        res.writeHead(404);
        res.end();
        return;
      }
      const rest = path.slice(prefix.length);
      if (rest.startsWith('files/')) {
        if (opts.fileStatus) {
          res.writeHead(opts.fileStatus);
          res.end();
          return;
        }
        const name = rest.slice(6).split('/').map(decodeURIComponent).join('/');
        const f = files[name];
        if (f === undefined) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, {
          'content-type': name.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8'
        });
        res.end(f);
        return;
      }
      res.writeHead(204);
      res.end();
    });
  });
  return { server, received };
}

describe('config', () => {
  const chromium = process.execPath; // any file that exists
  it('reads the defaults and normalises the Slideless URL', () => {
    const c = loadConfig({
      SLIDELESS_URL: 'http://app:3000/',
      SLIDELESS_RENDERER_SECRET: SECRET,
      RENDERER_CHROMIUM_PATH: chromium
    });
    expect(c).toMatchObject({
      slidelessUrl: 'http://app:3000',
      port: 3100,
      host: '0.0.0.0',
      logLevel: 'info',
      queueDepth: 4,
      captureTimeoutMs: 20_000,
      chromiumPath: chromium
    });
  });

  it('refuses the boot with one line per problem', () => {
    try {
      loadConfig({
        SLIDELESS_URL: 'ftp://x',
        SLIDELESS_RENDERER_SECRET: 'short',
        PORT: 'abc',
        LOG_LEVEL: 'loud',
        RENDERER_CHROMIUM_PATH: '/nope/chromium',
        RENDERER_QUEUE_DEPTH: '0'
      });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).problems).toHaveLength(6);
    }
    expect(() => loadConfig({ RENDERER_CHROMIUM_PATH: chromium })).toThrow(
      /SLIDELESS_URL is required[\s\S]*SLIDELESS_RENDERER_SECRET is required/
    );
  });
});

describe('POST /capture and /healthz', () => {
  let base = '';
  let server: Server;
  let isReady = true;
  const pushed: QueuedJob[] = [];
  let full = false;
  const queue = {
    push: (j: QueuedJob) => (full ? false : (pushed.push(j), true)),
    get size() {
      return pushed.length;
    }
  };

  beforeAll(async () => {
    server = createRendererServer({ config: { secret: SECRET }, queue, log: silent, ready: () => isReady });
    base = await listen(server);
  });
  afterAll(() => close(server));
  afterEach(() => {
    isReady = true;
    full = false;
    pushed.length = 0;
  });

  const post = (body: unknown, auth: string | null = `Bearer ${SECRET}`) =>
    fetch(`${base}/capture`, {
      method: 'POST',
      headers: { ...(auth ? { authorization: auth } : {}), 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body)
    });

  it('queues a valid job with the right secret: 202, no-store JSON', async () => {
    const res = await post({ v: 1, ...job() });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ queued: 1 });
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(pushed[0]).toEqual(job({ deadline: pushed[0]!.deadline }));
  });

  it('401 without the secret, with a wrong one, or with a prefix of it', async () => {
    for (const auth of [null, 'Bearer nope', `Bearer ${SECRET.slice(0, -1)}`, SECRET, 'Bearer ']) {
      const res = await post({ v: 1, ...job() }, auth);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'unauthorized' });
    }
    expect(pushed).toHaveLength(0);
  });

  it('400 invalid_job on every malformed field', async () => {
    const bad: unknown[] = [
      'not json',
      [],
      { ...job() },
      { v: 2, ...job() },
      { v: 1, ...job({ job: 'x' }) },
      { v: 1, ...job({ token: 'short' }) },
      { v: 1, ...job({ token: 'A'.repeat(42) + '=' }) },
      { v: 1, ...job({ entryPath: '' }) },
      { v: 1, ...job({ entryPath: '/etc/passwd' }) },
      { v: 1, ...job({ entryPath: 'a'.repeat(1025) }) },
      { v: 1, ...job({ deadline: 'tomorrow' }) }
    ];
    for (const b of bad) {
      const res = await post(b);
      expect(res.status, JSON.stringify(b).slice(0, 80)).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_job' });
    }
    expect(pushed).toHaveLength(0);
  });

  it('413 past 16 KiB', async () => {
    const res = await post({ v: 1, ...job(), pad: 'x'.repeat(17 * 1024) });
    expect(res.status).toBe(413);
  });

  it('503 starting before the self-check passed, 503 busy when the queue is full', async () => {
    isReady = false;
    let res = await post({ v: 1, ...job() });
    expect([res.status, await res.json()]).toEqual([503, { error: 'starting' }]);
    res = await fetch(`${base}/healthz`);
    expect([res.status, await res.json()]).toEqual([503, { ok: false }]);
    isReady = true;
    full = true;
    res = await post({ v: 1, ...job() });
    expect([res.status, await res.json()]).toEqual([503, { error: 'busy' }]);
  });

  it('/healthz answers 200 with the queue size when ready; 404 elsewhere, 405 on a wrong method', async () => {
    let res = await fetch(`${base}/healthz`);
    expect([res.status, await res.json()]).toEqual([200, { ok: true, queued: 0 }]);
    res = await fetch(`${base}/capture`);
    expect(res.status).toBe(405);
    res = await fetch(`${base}/healthz`, { method: 'POST' });
    expect(res.status).toBe(405);
    res = await fetch(`${base}/index.html`);
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('the queue and the calls back to Slideless', () => {
  function queueWith(
    url: string,
    capture: (input: CaptureInput) => Promise<Buffer>,
    onSandboxLost = vi.fn()
  ) {
    const slideless = new SlidelessClient({ baseUrl: url, log: silent });
    return {
      q: new CaptureQueue({ renderer: { capture }, slideless, log: silent, depth: 2, onSandboxLost }),
      onSandboxLost
    };
  }

  it('fetches the files under the key, segment-encoded, and PUTs the image', async () => {
    const s = fakeSlideless({ 'index.html': '<h1>x</h1>', 'my dir/a#b.css': 'body{}' });
    const url = await listen(s.server);
    try {
      const { q } = queueWith(url, async ({ entryPath, resolve }) => {
        expect((await resolve(entryPath))?.body.toString()).toBe('<h1>x</h1>');
        const css = await resolve('my dir/a#b.css');
        expect(css?.contentType).toBe('text/css');
        expect(await resolve('missing.png')).toBeNull();
        return WEBP;
      });
      expect(q.push(job())).toBe(true);
      await q.drain();
      expect(s.received.map((r) => `${r.method} ${r.path}`)).toEqual([
        `GET /internal/renderer/jobs/${JOB}/files/index.html`,
        `GET /internal/renderer/jobs/${JOB}/files/${encodeManifestPath('my dir/a#b.css')}`,
        `GET /internal/renderer/jobs/${JOB}/files/missing.png`,
        `PUT /internal/renderer/jobs/${JOB}/image`
      ]);
      expect(s.received.every((r) => r.auth === `Bearer ${TOKEN}`)).toBe(true);
      const put = s.received.at(-1)!;
      expect(put.contentType).toBe('image/webp');
      expect(put.body.equals(WEBP)).toBe(true);
    } finally {
      await close(s.server);
    }
  });

  it('a refused key ends the job: nothing more fetched, nothing reported', async () => {
    const s = fakeSlideless({}, { refuseKey: true });
    const url = await listen(s.server);
    try {
      const { q } = queueWith(url, async ({ resolve }) => {
        // The renderer turns a throwing resolve into a 404 for the page.
        await resolve('index.html').catch(() => null);
        expect(await resolve('s.css')).toBeNull();
        return WEBP;
      });
      q.push(job());
      await q.drain();
      expect(s.received.map((r) => r.method)).toEqual(['GET']);
    } finally {
      await close(s.server);
    }
  });

  it('a file Slideless cannot serve reports a transient failure, never an incomplete image', async () => {
    const s = fakeSlideless({}, { fileStatus: 500 });
    const url = await listen(s.server);
    try {
      const { q } = queueWith(url, async ({ resolve }) => {
        await resolve('index.html').catch(() => null);
        return WEBP;
      });
      q.push(job());
      await q.drain();
      const last = s.received.at(-1)!;
      expect(`${last.method} ${last.path}`).toBe(`POST /internal/renderer/jobs/${JOB}/failure`);
      expect(JSON.parse(last.body.toString())).toEqual({ error: UNREACHABLE_MESSAGE, transient: true });
    } finally {
      await close(s.server);
    }
  });

  it('a job past its deadline is reported transient without a capture; an error reports its first line', async () => {
    const s = fakeSlideless({ 'index.html': 'x' });
    const url = await listen(s.server);
    try {
      const capture = vi.fn(async () => {
        throw new Error(`page crashed ${'y'.repeat(400)}\nstack line`);
      });
      const { q } = queueWith(url, capture);
      q.push(job({ deadline: new Date(Date.now() - 1000).toISOString() }));
      q.push(job());
      await q.drain();
      expect(capture).toHaveBeenCalledTimes(1);
      const bodies = s.received.filter((r) => r.method === 'POST').map((r) => JSON.parse(r.body.toString()));
      expect(bodies[0]).toEqual({ error: DEADLINE_MESSAGE, transient: true });
      expect(bodies[1].transient).toBe(false);
      expect(bodies[1].error).toHaveLength(300);
      expect(bodies[1].error).not.toContain('stack line');
    } finally {
      await close(s.server);
    }
  });

  it('a lost sandbox stops the renderer and reports nothing', async () => {
    const s = fakeSlideless({});
    const url = await listen(s.server);
    try {
      const { q, onSandboxLost } = queueWith(url, async () => {
        throw new SandboxUnavailableError(new Error('No usable sandbox!'));
      });
      q.push(job());
      q.push(job());
      await q.drain();
      expect(onSandboxLost).toHaveBeenCalledTimes(1);
      expect(s.received).toHaveLength(0);
      expect(q.push(job())).toBe(false);
    } finally {
      await close(s.server);
    }
  });

  it('holds at most its depth, the running job included; stop() refuses further jobs', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const s = fakeSlideless({});
    const url = await listen(s.server);
    try {
      const { q } = queueWith(url, async () => {
        await gate;
        return WEBP;
      });
      expect(q.push(job())).toBe(true);
      expect(q.push(job())).toBe(true);
      expect(q.push(job())).toBe(false);
      expect(q.size).toBe(2);
      q.stop();
      release();
      await q.drain();
      expect(q.size).toBe(0);
      expect(q.push(job())).toBe(false);
      expect(s.received.filter((r) => r.method === 'PUT')).toHaveLength(1);
    } finally {
      await close(s.server);
    }
  });
});

describe('the Slideless client', () => {
  it('refuses a malformed job or key before building a URL, and follows no redirect', async () => {
    const fetchImpl = vi.fn();
    const c = new SlidelessClient({ baseUrl: 'http://app:3000', log: silent, fetchImpl });
    await expect(c.fileFor('../../x', TOKEN, 'a')).rejects.toThrow('invalid job id');
    await expect(c.fileFor(JOB, 'short', 'a')).rejects.toThrow('invalid job key');
    expect(fetchImpl).not.toHaveBeenCalled();

    const redirecting = createServer((_req, res) => {
      res.writeHead(302, { location: 'http://127.0.0.1:9/' });
      res.end();
    });
    const url = await listen(redirecting);
    try {
      const real = new SlidelessClient({ baseUrl: url, log: silent });
      await expect(real.fileFor(JOB, TOKEN, 'index.html')).rejects.toThrow(/could not be read/);
    } finally {
      await close(redirecting);
    }
  });

  it('a file past the per-file cap is answered as missing', async () => {
    const huge = {
      headers: new Headers({ 'content-length': String(FILE_MAX_BYTES + 1) }),
      status: 200,
      body: null
    } as unknown as Response;
    const c = new SlidelessClient({ baseUrl: 'http://app:3000', log: silent, fetchImpl: async () => huge });
    expect(await c.fileFor(JOB, TOKEN, 'big.mp4')).toBeNull();
  });
});

describe('small rules', () => {
  it('failureLine keeps the first line, at most 300 characters', () => {
    expect(failureLine(new Error('a\nb'))).toBe('a');
    expect(failureLine('x'.repeat(500))).toHaveLength(300);
    expect(failureLine(new Error(''))).toBe('the capture failed');
  });

  it('the self-check CLI runs only as its own entry script', () => {
    expect(isSelfCheckEntry('/app/dist/selfcheck.js')).toBe(true);
    expect(isSelfCheckEntry('/repo/apps/renderer/src/selfcheck.ts')).toBe(true);
    expect(isSelfCheckEntry('/app/dist/index.js')).toBe(false);
    expect(isSelfCheckEntry(undefined)).toBe(false);
  });
});
