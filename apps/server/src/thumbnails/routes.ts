import { Hono, type Context } from 'hono';
import type { Logger } from '@antasphere/chassis-server/logger';
import type { ThumbnailService } from './service.js';

/**
 * The three verbs the renderer container speaks to this instance
 * (PRDCT-2725, thumbnails/renderer-client.ts for the whole protocol), under
 * `/internal/renderer/jobs/{job}/…`. Mounted in the app's public-route slot,
 * OUTSIDE /api/v1: no session, no API key, no OpenAPI entry. The credential
 * is the ONE-TIME KEY the job was handed (`Authorization: Bearer`), looked
 * up by its sha256 on the claimed row, and it opens exactly one version's
 * files and accepts exactly one version's image while the claim's lease
 * lives (ThumbnailService.claimFor). The key is 256 random bits: a wrong
 * key answers 401 with nothing else, and no rate limit is needed to make
 * guessing pointless. The key is judged BEFORE a byte of body is read
 * (verifier round 1, F1): these routes ride the public slot, where no body
 * limit runs, so a request whose key opens nothing costs one indexed read
 * and no buffer; the write itself checks the key again. Every answer is
 * no-store.
 *
 *  GET  …/files/{path}   a manifest file of the version, exact path only
 *  PUT  …/image          the WebP bytes (RIFF/WEBP magic, IMAGE_MAX_BYTES cap)
 *  POST …/failure        `{ error, transient? }`
 */
export const RENDERER_JOBS_PREFIX = '/internal/renderer/jobs';
/** A 960 × 540 WebP is tens of KB; an image past this is refused unread. */
export const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
const FAILURE_MAX_BYTES = 4 * 1024;
const JOB_RE = /^[0-9a-f-]{36}$/;

export interface RendererRouteDeps {
  thumbnails: ThumbnailService;
  logger: Logger;
}

const err = (code: string, message: string) => ({ error: { code, message } });
const NO_STORE = { 'cache-control': 'no-store' } as const;

function bearer(c: Context): string {
  const h = c.req.header('authorization') ?? '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

/** The URL path back to a manifest path, one decode per segment, or null when it does not decode. */
export function decodeDeckPath(rawPath: string): string | null {
  try {
    return rawPath.split('/').map(decodeURIComponent).join('/');
  } catch {
    return null;
  }
}

/** Read a body up to `max` bytes; null when it is longer (the rest is not read). */
async function readBody(c: Context, max: number): Promise<Buffer | null> {
  const declared = Number(c.req.header('content-length') ?? '0');
  if (declared > max) return null;
  const body = c.req.raw.body;
  if (!body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = body.getReader();
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

export function isWebp(b: Buffer): boolean {
  return (
    b.length > 12 &&
    b.subarray(0, 4).toString('latin1') === 'RIFF' &&
    b.subarray(8, 12).toString('latin1') === 'WEBP'
  );
}

export function rendererRoutes({ thumbnails, logger }: RendererRouteDeps): Hono {
  const app = new Hono();

  app.get(`${RENDERER_JOBS_PREFIX}/:job/files/*`, async (c) => {
    const job = c.req.param('job');
    const token = bearer(c);
    if (!JOB_RE.test(job) || !token) return c.json(err('unauthorized', 'No key for this job'), 401, NO_STORE);
    // The RAW pathname, so a file whose own name holds a percent sign is
    // decoded exactly once, segment by segment.
    const prefix = `${RENDERER_JOBS_PREFIX}/${job}/files/`;
    const raw = new URL(c.req.url).pathname;
    const path = raw.startsWith(prefix) ? decodeDeckPath(raw.slice(prefix.length)) : null;
    if (path === null) return c.json(err('not_found', 'Not a file of this version'), 404, NO_STORE);
    const file = await thumbnails.fileFor({ job, token, path });
    if (file === 'unauthorized') return c.json(err('unauthorized', 'No key for this job'), 401, NO_STORE);
    if (!file) return c.json(err('not_found', 'Not a file of this version'), 404, NO_STORE);
    return c.body(new Uint8Array(file.body), 200, {
      ...NO_STORE,
      'content-type': file.contentType,
      'content-length': String(file.body.length),
      'x-content-type-options': 'nosniff'
    });
  });

  /** 401 with the body left unread (and cancelled) when the key opens no claim. */
  async function refuseUnlessHeld(c: Context, job: string, token: string): Promise<Response | null> {
    if (JOB_RE.test(job) && token && (await thumbnails.holdsClaim({ job, token }))) return null;
    await c.req.raw.body?.cancel().catch(() => {});
    return c.json(err('unauthorized', 'No key for this job'), 401, NO_STORE);
  }

  app.put(`${RENDERER_JOBS_PREFIX}/:job/image`, async (c) => {
    const job = c.req.param('job');
    const token = bearer(c);
    const refused = await refuseUnlessHeld(c, job, token);
    if (refused) return refused;
    if ((c.req.header('content-type') ?? '').split(';')[0]!.trim() !== 'image/webp') {
      return c.json(err('not_webp', 'The image must be sent as image/webp'), 415, NO_STORE);
    }
    const bytes = await readBody(c, IMAGE_MAX_BYTES);
    if (bytes === null) return c.json(err('payload_too_large', 'The image exceeds the cap'), 413, NO_STORE);
    if (!isWebp(bytes)) return c.json(err('not_webp', 'The bytes are not a WebP image'), 400, NO_STORE);
    const outcome = await thumbnails.complete({ job, token, webp: bytes });
    if (outcome === 'rejected') {
      logger.warn(
        { job },
        'thumbnails: an image arrived for a claim no key opens (late, replayed, or foreign)'
      );
      return c.json(err('unauthorized', 'No key for this job'), 401, NO_STORE);
    }
    return c.body(null, 204, NO_STORE);
  });

  app.post(`${RENDERER_JOBS_PREFIX}/:job/failure`, async (c) => {
    const job = c.req.param('job');
    const token = bearer(c);
    const refused = await refuseUnlessHeld(c, job, token);
    if (refused) return refused;
    const bytes = await readBody(c, FAILURE_MAX_BYTES);
    let parsed: unknown;
    try {
      parsed = bytes === null ? null : JSON.parse(bytes.toString('utf8'));
    } catch {
      parsed = null;
    }
    const body = parsed as { error?: unknown; transient?: unknown } | null;
    if (!body || typeof body.error !== 'string' || body.error.length === 0) {
      return c.json(err('invalid_body', 'Expected { error: string, transient?: boolean }'), 400, NO_STORE);
    }
    const outcome = await thumbnails.fail({
      job,
      token,
      error: body.error,
      ...(body.transient === true ? { transient: true } : {})
    });
    if (outcome === 'rejected') return c.json(err('unauthorized', 'No key for this job'), 401, NO_STORE);
    return c.body(null, 204, NO_STORE);
  });

  return app;
}
