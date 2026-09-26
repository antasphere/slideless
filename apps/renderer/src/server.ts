import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { RendererConfig } from './config.js';
import type { Log } from './log.js';
import type { QueuedJob } from './queue.js';
import { JOB_RE, TOKEN_RE } from './slideless.js';

/**
 * The renderer's HTTP face (PRDCT-2725): `POST /capture` (Slideless hands a
 * job over, bearer the shared secret) and `GET /healthz`. It never serves a
 * file and never fetches a URL from a request: a job names a version and its
 * entry path, and the files come from SLIDELESS_URL under the job's key.
 */
export const CAPTURE_BODY_MAX_BYTES = 16 * 1024;
export const ENTRY_PATH_MAX = 1024;

export interface JobQueue {
  push(job: QueuedJob): boolean;
  readonly size: number;
}

export interface RendererServerDeps {
  config: Pick<RendererConfig, 'secret'>;
  queue: JobQueue;
  log: Log;
  ready: () => boolean;
}

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest();

function send(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(text)),
    ...extra
  });
  res.end(text);
}

/** The bearer compared in constant time: both sides hashed first, so the lengths match too. */
export function secretMatches(header: string | undefined, secret: string): boolean {
  const presented = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const ok = timingSafeEqual(sha256(presented), sha256(secret));
  return ok && presented.length > 0;
}

/** Read at most `max` bytes; null past it (the rest is not kept). */
function readBody(req: IncomingMessage, max: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? '');
    if (Number.isFinite(declared) && declared > max) {
      req.resume();
      resolve(null);
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let over = false;
    req.on('data', (chunk: Buffer) => {
      if (over) return;
      total += chunk.length;
      if (total > max) {
        over = true;
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!over) resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

/** The job, or null when the body is not `{ v: 1, job, token, entryPath, deadline }` with valid values. */
export function parseJob(bytes: Buffer): QueuedJob | null {
  let body: unknown;
  try {
    body = JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (b.v !== 1) return null;
  const { job, token, entryPath, deadline } = b;
  if (typeof job !== 'string' || !JOB_RE.test(job)) return null;
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
  if (
    typeof entryPath !== 'string' ||
    entryPath.length === 0 ||
    entryPath.length > ENTRY_PATH_MAX ||
    entryPath.startsWith('/')
  ) {
    return null;
  }
  if (typeof deadline !== 'string' || Number.isNaN(Date.parse(deadline))) return null;
  return { job, token, entryPath, deadline };
}

export function createHandler(deps: RendererServerDeps) {
  const { config, queue, log, ready } = deps;

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '/').split('?')[0];

    if (path === '/healthz') {
      if (req.method !== 'GET' && req.method !== 'HEAD')
        return send(res, 405, { error: 'method_not_allowed' }, { allow: 'GET, HEAD' });
      if (!ready()) return send(res, 503, { ok: false });
      return send(res, 200, { ok: true, queued: queue.size });
    }

    if (path === '/capture') {
      if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' }, { allow: 'POST' });
      if (!secretMatches(req.headers.authorization, config.secret)) {
        req.resume();
        return send(res, 401, { error: 'unauthorized' });
      }
      if (!ready()) {
        req.resume();
        return send(res, 503, { error: 'starting' });
      }
      const bytes = await readBody(req, CAPTURE_BODY_MAX_BYTES);
      if (bytes === null) return send(res, 413, { error: 'payload_too_large' }, { connection: 'close' });
      const job = parseJob(bytes);
      if (!job) return send(res, 400, { error: 'invalid_job' });
      if (!queue.push(job)) {
        log.warn('job refused: the queue is full', { job: job.job, queued: queue.size });
        return send(res, 503, { error: 'busy' });
      }
      log.info('job accepted', { job: job.job, queued: queue.size });
      return send(res, 202, { queued: queue.size });
    }

    req.resume();
    return send(res, 404, { error: 'not_found' });
  };
}

export function createRendererServer(deps: RendererServerDeps): Server {
  const handle = createHandler(deps);
  const server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      deps.log.error('request failed', { err: e instanceof Error ? e.message : String(e) });
      if (!res.headersSent) send(res, 500, { error: 'internal' });
      else res.destroy();
    });
  });
  // A job is a line of JSON: nothing legitimate holds a connection open.
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  return server;
}
