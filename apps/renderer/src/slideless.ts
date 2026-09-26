import type { ResolvedFile } from './renderer.js';
import type { Log } from './log.js';

/**
 * The renderer's three calls back to Slideless (PRDCT-2725; the protocol is
 * `apps/server/src/thumbnails/renderer-client.ts`, the answering side
 * `apps/server/src/thumbnails/routes.ts`). Every call is made under the JOB's
 * one-time key, never under the shared secret, and goes to SLIDELESS_URL and
 * nowhere else: no URL is ever taken from a job. Redirects are refused.
 */

/** A job id is a version id (a uuid). */
export const JOB_RE = /^[0-9a-f-]{36}$/;
/** A key is base64url of 32 random bytes. */
export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export const FILE_MAX_BYTES = 64 * 1024 * 1024;
export const FILE_TIMEOUT_MS = 15_000;
export const CALLBACK_TIMEOUT_MS = 15_000;

/** Slideless refused the job's key: the claim is gone (late, replaced, or finished). Stop, report nothing. */
export class KeyRefusedError extends Error {
  constructor(job: string) {
    super(`Slideless refused the key of job ${job}`);
    this.name = 'KeyRefusedError';
  }
}

/** Slideless could not be read (network, timeout, an unexpected status): the image would be incomplete. */
export class SlidelessUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SlidelessUnreachableError';
  }
}

export interface SlidelessApi {
  fileFor(job: string, token: string, path: string): Promise<ResolvedFile | null>;
  putImage(job: string, token: string, webp: Buffer): Promise<void>;
  postFailure(job: string, token: string, error: string, transient: boolean): Promise<void>;
}

export function assertJobCredentials(job: string, token: string): void {
  if (!JOB_RE.test(job)) throw new Error('invalid job id');
  if (!TOKEN_RE.test(token)) throw new Error('invalid job key');
}

/** A manifest path as URL segments, each percent-encoded (Slideless decodes once per segment). */
export function encodeManifestPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

async function readCapped(res: Response, max: number): Promise<Buffer | null> {
  const declared = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

export interface SlidelessClientOptions {
  baseUrl: string;
  log: Log;
  fetchImpl?: typeof fetch;
}

export class SlidelessClient implements SlidelessApi {
  private readonly baseUrl: string;
  private readonly log: Log;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: SlidelessClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.log = opts.log;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private jobUrl(job: string, token: string, rest: string): string {
    assertJobCredentials(job, token);
    return `${this.baseUrl}/internal/renderer/jobs/${job}/${rest}`;
  }

  async fileFor(job: string, token: string, path: string): Promise<ResolvedFile | null> {
    const url = this.jobUrl(job, token, `files/${encodeManifestPath(path)}`);
    let res: Response;
    let body: Buffer | null;
    try {
      res = await this.fetchImpl(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
        redirect: 'error',
        signal: AbortSignal.timeout(FILE_TIMEOUT_MS)
      });
      if (res.status === 401) {
        await res.body?.cancel().catch(() => {});
        throw new KeyRefusedError(job);
      }
      if (res.status === 404) {
        await res.body?.cancel().catch(() => {});
        return null;
      }
      if (res.status !== 200) {
        await res.body?.cancel().catch(() => {});
        throw new SlidelessUnreachableError(`Slideless answered ${res.status} for a file`);
      }
      body = await readCapped(res, FILE_MAX_BYTES);
    } catch (e) {
      if (e instanceof KeyRefusedError || e instanceof SlidelessUnreachableError) throw e;
      throw new SlidelessUnreachableError(
        `Slideless could not be read for a file: ${e instanceof Error ? e.message : String(e)}`
      );
    }
    if (body === null) {
      this.log.warn('a file of the version exceeds the per-file cap; answered 404 to the page', {
        job,
        capBytes: FILE_MAX_BYTES
      });
      return null;
    }
    return { contentType: res.headers.get('content-type') ?? 'application/octet-stream', body };
  }

  async putImage(job: string, token: string, webp: Buffer): Promise<void> {
    await this.callback(job, 'image', 'the image', {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'image/webp' },
      body: new Uint8Array(webp),
      url: this.jobUrl(job, token, 'image')
    });
  }

  async postFailure(job: string, token: string, error: string, transient: boolean): Promise<void> {
    await this.callback(job, 'failure', 'the failure', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ error, transient }),
      url: this.jobUrl(job, token, 'failure')
    });
  }

  private async callback(
    job: string,
    leg: 'image' | 'failure',
    what: string,
    req: { method: string; headers: Record<string, string>; body: string | Uint8Array; url: string }
  ): Promise<void> {
    try {
      const res = await this.fetchImpl(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body,
        redirect: 'error',
        signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS)
      });
      await res.body?.cancel().catch(() => {});
      if (res.status === 204) {
        this.log.info(leg === 'image' ? 'the image landed' : 'the failure was reported', { job });
        return;
      }
      // 401: the claim ran out or was replaced. No retry either way: the
      // lease's end hands the version off again.
      this.log.warn(`Slideless did not take ${what}`, { job, status: res.status });
    } catch (e) {
      this.log.warn(`Slideless could not be reached with ${what}`, {
        job,
        err: e instanceof Error ? e.message : String(e)
      });
    }
  }
}
