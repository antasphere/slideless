import { SandboxUnavailableError, type CaptureInput } from './renderer.js';
import { KeyRefusedError, SlidelessUnreachableError, type SlidelessApi } from './slideless.js';
import type { Log } from './log.js';

/** One job as `POST /capture` accepted it (the `v` field dropped). */
export interface QueuedJob {
  job: string;
  token: string;
  entryPath: string;
  deadline: string;
}

export interface Capturer {
  capture(input: CaptureInput): Promise<Buffer>;
}

export interface CaptureQueueOptions {
  renderer: Capturer;
  slideless: SlidelessApi;
  log: Log;
  /** Jobs held at once, the running one included (Slideless keeps at most 4 claims in flight). */
  depth: number;
  /** Called when Chromium's sandbox is gone under a running process. Defaults to exiting 3. */
  onSandboxLost?: (err: SandboxUnavailableError) => void;
}

export const DEADLINE_MESSAGE = 'the renderer did not start this capture before its deadline';
export const UNREACHABLE_MESSAGE = 'the renderer could not read every file of this version from Slideless';

/** The first line of an error message, capped: what Slideless stores as the reason. */
export function failureLine(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const first = (msg.split('\n')[0] ?? '').trim() || 'the capture failed';
  return first.length > 300 ? first.slice(0, 300) : first;
}

/**
 * The renderer's FIFO of jobs and its one worker: one capture at a time (the
 * Chromium renderer refuses to overlap), jobs in the order they arrived.
 * Every outcome goes back to Slideless under the job's own key; a key
 * Slideless refuses ends the job silently (the claim is gone).
 */
export class CaptureQueue {
  private readonly waiting: QueuedJob[] = [];
  private running: Promise<void> | null = null;
  private busy = false;
  private stopped = false;
  private readonly onSandboxLost: (err: SandboxUnavailableError) => void;

  constructor(private readonly opts: CaptureQueueOptions) {
    this.onSandboxLost =
      opts.onSandboxLost ??
      (() => {
        process.exit(3);
      });
  }

  /** Jobs held, the running one included. */
  get size(): number {
    return this.waiting.length + (this.busy ? 1 : 0);
  }

  /** Queue a job; false when the queue is full or stopped. */
  push(job: QueuedJob): boolean {
    if (this.stopped || this.size >= this.opts.depth) return false;
    this.waiting.push(job);
    if (!this.running) this.running = this.loop().finally(() => (this.running = null));
    return true;
  }

  /** No further job starts; the waiting ones are dropped (their leases run out and Slideless hands them off again). */
  stop(): void {
    this.stopped = true;
    this.waiting.length = 0;
  }

  /** Resolves when the current job (if any) and the loop have ended. */
  async drain(): Promise<void> {
    while (this.running) await this.running;
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      const job = this.waiting.shift();
      if (!job) return;
      this.busy = true;
      try {
        await this.run(job);
      } finally {
        this.busy = false;
      }
    }
  }

  private async run(job: QueuedJob): Promise<void> {
    const { log, slideless } = this.opts;
    if (Date.now() > Date.parse(job.deadline)) {
      log.warn('job dropped: its deadline passed before it started', { job: job.job });
      await slideless.postFailure(job.job, job.token, DEADLINE_MESSAGE, true);
      return;
    }
    // The renderer turns a resolve that throws into a 404 for the page, so
    // the two refusals that must end the job are recorded here and read once
    // the capture returns. After a refused key nothing more is fetched.
    let keyRefused = false;
    let unreachable = false;
    const started = Date.now();
    log.info('capture started', { job: job.job });
    try {
      const webp = await this.opts.renderer.capture({
        entryPath: job.entryPath,
        resolve: async (path) => {
          if (keyRefused) return null;
          try {
            return await slideless.fileFor(job.job, job.token, path);
          } catch (e) {
            if (e instanceof KeyRefusedError) keyRefused = true;
            else if (e instanceof SlidelessUnreachableError) {
              unreachable = true;
              log.warn('a file could not be read from Slideless', { job: job.job, err: e.message });
            }
            throw e;
          }
        }
      });
      if (keyRefused) throw new KeyRefusedError(job.job);
      if (unreachable) {
        await slideless.postFailure(job.job, job.token, UNREACHABLE_MESSAGE, true);
        return;
      }
      log.info('capture done', { job: job.job, bytes: webp.length, ms: Date.now() - started });
      await slideless.putImage(job.job, job.token, webp);
    } catch (e) {
      if (e instanceof KeyRefusedError || keyRefused) {
        log.info('job ended: Slideless refused its key (the claim is gone)', { job: job.job });
        return;
      }
      if (e instanceof SandboxUnavailableError) {
        log.error(e.message, { job: job.job });
        this.stopped = true;
        this.onSandboxLost(e);
        return;
      }
      if (unreachable) {
        await slideless.postFailure(job.job, job.token, UNREACHABLE_MESSAGE, true);
        return;
      }
      const reason = failureLine(e);
      log.warn('capture failed', { job: job.job, err: reason, ms: Date.now() - started });
      await slideless.postFailure(job.job, job.token, reason, false);
    }
  }
}
