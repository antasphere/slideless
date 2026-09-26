import type { Logger } from '@antasphere/chassis-server/logger';

/**
 * The handoff of a deck version to the renderer container (PRDCT-2725), as
 * Slideless sees it. The renderer (`apps/renderer`) is a separate, optional
 * process: it holds a sandboxed Chromium and nothing else, no database, no
 * storage, no secret but the one this client presents.
 *
 * The protocol, in three legs, all of them JSON or raw bytes over HTTP:
 *
 *  1. Slideless → renderer, `POST {SLIDELESS_RENDERER_URL}/capture`, bearer
 *     `SLIDELESS_RENDERER_SECRET`, a body the size of a line: the job id (the
 *     version id), a ONE-TIME KEY minted for this claim, the entry path and
 *     the deadline (the claim's lease). 202 = queued, 503 = the renderer's
 *     queue is full, 401 = the secrets differ. Nothing about the deck's
 *     content travels here.
 *  2. Renderer → Slideless, `GET /internal/renderer/jobs/{job}/files/{path}`,
 *     bearer THE KEY, for each file the page asks for: Slideless serves the
 *     version's own manifest files and nothing else (thumbnails/routes.ts).
 *  3. Renderer → Slideless, `PUT /internal/renderer/jobs/{job}/image` (the
 *     WebP bytes) or `POST .../failure` (why it failed), bearer THE KEY.
 *
 * The key is what bounds the renderer: it opens ONE version's files and
 * accepts ONE version's image, only while the claim's lease lives, and dies
 * with the outcome. A renderer that were ever taken over (it opens
 * user-authored HTML) could write the images of the versions it was handed
 * and read nothing else; the shared secret never travels back to Slideless.
 * Nothing on the push path waits on any leg: the push queues, `kick` hands
 * off, the callback lands whenever it lands, and a lease that runs out is
 * handed off again (up to the attempts).
 */
export interface RendererJob {
  /** The version id, the one name both sides use for this capture. */
  job: string;
  /** The one-time key, base64url of 32 random bytes; only its sha256 is stored. */
  token: string;
  /** The version's entry document, a manifest path (`index.html`, `deck/start.html`). */
  entryPath: string;
  /** ISO 8601: the claim's lease end. The renderer drops a job it cannot start before it. */
  deadline: string;
}

export type SubmitOutcome = 'queued' | 'busy' | 'unauthorized' | 'unreachable';

export interface RendererClient {
  /** Hand one job to the renderer. Never throws: the outcome says what happened. */
  submit(job: RendererJob): Promise<SubmitOutcome>;
}

export interface HttpRendererClientOptions {
  baseUrl: string;
  secret: string;
  logger: Logger;
  /** The whole submit, connect to answer. The renderer only queues here; it never renders inside this call. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class HttpRendererClient implements RendererClient {
  private readonly captureUrl: string;
  private readonly secret: string;
  private readonly logger: Logger;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HttpRendererClientOptions) {
    this.captureUrl = new URL('/capture', opts.baseUrl).toString();
    this.secret = opts.secret;
    this.logger = opts.logger;
    this.timeoutMs = opts.timeoutMs ?? 5_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async submit(job: RendererJob): Promise<SubmitOutcome> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.captureUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.secret}`,
          'content-type': 'application/json',
          accept: 'application/json'
        },
        body: JSON.stringify({ v: 1, ...job }),
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'error'
      });
    } catch (err) {
      this.logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'thumbnails: renderer unreachable'
      );
      return 'unreachable';
    }
    // The body is not read: nothing in it is needed, and a renderer answering
    // at length must not hold a connection here.
    await res.body?.cancel().catch(() => {});
    if (res.status === 202) return 'queued';
    if (res.status === 503) return 'busy';
    if (res.status === 401 || res.status === 403) return 'unauthorized';
    this.logger.warn({ status: res.status }, 'thumbnails: renderer answered an unexpected status');
    return 'unreachable';
  }
}
