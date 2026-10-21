import { Worker } from 'node:worker_threads';
import type { DataValidationIssue, ExtractedBindings } from '@slideless/contract';

/**
 * A TIME BUDGET on every regular expression a template's schema makes the
 * server run (verifier round 3, F7). A JSON Schema `pattern` runs with the
 * native engine, which backtracks: a static check refuses the obvious
 * shapes (`(a+)+`, safe-regex2 at push) but cannot decide the class
 * (`(a|a)*` passes it and takes minutes at thirty characters). So the two
 * operations that evaluate a schema's patterns against author or writer
 * input, the validation of data and the extraction of a page's bindings,
 * run in worker threads with a budget per job: a job over it is killed with
 * its worker, a warm replacement takes its seat, and the caller is told the
 * schema took too long. The request thread never waits on a regular
 * expression.
 *
 * A small POOL of workers (verifier round 4): one worker serialized every
 * write of the instance behind a crafted request; with several seats a slow
 * job costs its own seat for the budget and nothing else. Every worker is
 * WARMED before it takes a job (it loads the contract package, ~200 ms on a
 * cold start, round 4's F1: counted against the budget, that cold start
 * refused the honest write that followed a timeout), and a killed worker is
 * replaced in the background, warmed, before the next job needs it. The
 * worker loads the contract package by name, which the runtime node_modules
 * carries (every bare import is external to the server bundle).
 */

export type BudgetedResult<T> =
  { ok: true; value: T } | { ok: false; reason: 'timeout' | 'failed'; message: string };

type Job =
  | { op: 'validate'; schema: Record<string, unknown>; data: unknown }
  | { op: 'extract'; source: string; schema: Record<string, unknown>; file: string };

type Reply = { ok: true; value: unknown } | { ok: false; message: string } | { warm: true };

/** The worker's own code: it warms once, then answers one message with one reply. */
const WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads');
let contract = null;
const load = async () => (contract ??= await import('@slideless/contract'));
parentPort.on('message', async (job) => {
  if (job.op === 'warm') {
    try { await load(); parentPort.postMessage({ warm: true }); }
    catch (e) { parentPort.postMessage({ ok: false, message: e instanceof Error ? e.message : String(e) }); }
    return;
  }
  try {
    const c = await load();
    if (job.op === 'validate') {
      parentPort.postMessage({ ok: true, value: c.validateDataAgainstSchema(job.schema, job.data) });
    } else {
      const { parsed, errors } = c.parseBindings(job.source, job.file);
      if (errors.length > 0) parentPort.postMessage({ ok: true, value: { errors } });
      else parentPort.postMessage({ ok: true, value: { extracted: c.extractBindings(parsed, job.schema, job.file) } });
    }
  } catch (e) {
    parentPort.postMessage({ ok: false, message: e instanceof Error ? e.message : String(e) });
  }
});
`;

/** How long one validation or one page's extraction may take, once its worker is warm. */
export const VALIDATION_BUDGET_MS = 250;
/** How many workers judge at once; a slow job costs one seat for the budget. */
export const VALIDATION_WORKERS = 3;
/** How long a worker may take to warm (the contract import) before it is given up on. */
const WARM_MS = 10_000;

interface Seat {
  worker: Worker;
  /** Resolves once the worker loaded the contract; rejects when it could not. */
  warm: Promise<void>;
  /** True once `warm` resolved: a job posted here starts at once. */
  ready: boolean;
  busy: boolean;
  dead: boolean;
}

export class ValidationBudget {
  private readonly seats: Seat[] = [];
  private readonly waiting: ((seat: Seat) => void)[] = [];
  private closed = false;

  constructor(
    private readonly budgetMs: number = VALIDATION_BUDGET_MS,
    private readonly size: number = VALIDATION_WORKERS
  ) {}

  /** The data against the schema: the issues, or the budget's refusal. */
  validate(schema: Record<string, unknown>, data: unknown): Promise<BudgetedResult<DataValidationIssue[]>> {
    return this.run<DataValidationIssue[]>({ op: 'validate', schema, data });
  }

  /** A page's bindings against the schema: the parse errors or the extraction, or the budget's refusal. */
  extract(
    source: string,
    schema: Record<string, unknown>,
    file: string
  ): Promise<
    BudgetedResult<
      { errors: { file?: string; line: number; message: string }[] } | { extracted: ExtractedBindings }
    >
  > {
    return this.run({ op: 'extract', source, schema, file });
  }

  private async run<T>(job: Job): Promise<BudgetedResult<T>> {
    let seat: Seat;
    try {
      seat = await this.take();
    } catch (e) {
      return { ok: false, reason: 'failed', message: (e as Error).message };
    }
    try {
      await seat.warm;
    } catch (e) {
      this.release(seat, true);
      return {
        ok: false,
        reason: 'failed',
        message: `the validation worker could not start: ${(e as Error).message}`
      };
    }
    return new Promise((resolve) => {
      const { worker } = seat;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        worker.removeAllListeners('message');
        worker.removeAllListeners('error');
        // The job is killed with its worker; a warm replacement takes the seat.
        this.release(seat, true);
        resolve({
          ok: false,
          reason: 'timeout',
          message: `the schema took more than ${this.budgetMs} ms to judge this input; its patterns are too costly`
        });
      }, this.budgetMs);
      const done = (reply: Reply, died = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        worker.removeAllListeners('message');
        worker.removeAllListeners('error');
        this.release(seat, died);
        if ('warm' in reply)
          resolve({ ok: false, reason: 'failed', message: 'the worker answered out of turn' });
        else if (reply.ok) resolve({ ok: true, value: reply.value as T });
        else resolve({ ok: false, reason: 'failed', message: reply.message });
      };
      worker.once('message', (reply: Reply) => done(reply));
      worker.once('error', (err: Error) => done({ ok: false, message: err.message }, true));
      worker.postMessage(job);
    });
  }

  /** An idle seat, a warm one first, spawning up to `size`, else the next one freed (arrival order). */
  private take(): Promise<Seat> {
    if (this.closed) return Promise.reject(new Error('the validation pool is closed'));
    const idle =
      this.seats.find((s) => !s.busy && !s.dead && s.ready) ?? this.seats.find((s) => !s.busy && !s.dead);
    if (idle) {
      idle.busy = true;
      return Promise.resolve(idle);
    }
    if (this.seats.filter((s) => !s.dead).length < this.size) {
      const seat = this.spawn();
      seat.busy = true;
      return Promise.resolve(seat);
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  /** Frees a seat (or replaces a dead one, warmed in the background) and hands it to the next waiter. */
  private release(seat: Seat, died: boolean): void {
    let next: Seat = seat;
    if (died) {
      seat.dead = true;
      void seat.worker.terminate();
      const i = this.seats.indexOf(seat);
      if (i !== -1) this.seats.splice(i, 1);
      if (this.closed) return;
      next = this.spawn();
    }
    const waiter = this.waiting.shift();
    if (waiter) {
      next.busy = true;
      waiter(next);
    } else {
      next.busy = false;
    }
  }

  private spawn(): Seat {
    const worker = new Worker(WORKER_SOURCE, { eval: true, resourceLimits: { maxOldGenerationSizeMb: 256 } });
    worker.unref();
    const seat: Seat = { worker, busy: false, dead: false, ready: false, warm: Promise.resolve() };
    seat.warm = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no answer within ${WARM_MS} ms`)), WARM_MS);
      worker.once('message', (reply: Reply) => {
        clearTimeout(timer);
        if ('warm' in reply) resolve();
        else reject(new Error('ok' in reply && !reply.ok ? reply.message : 'unexpected first answer'));
      });
      worker.once('error', (err: Error) => {
        clearTimeout(timer);
        reject(err);
      });
      worker.postMessage({ op: 'warm' });
    });
    seat.warm.then(
      () => {
        seat.ready = true;
      },
      () => undefined
    );
    worker.on('exit', () => {
      if (!seat.dead) {
        seat.dead = true;
        const i = this.seats.indexOf(seat);
        if (i !== -1) this.seats.splice(i, 1);
      }
    });
    this.seats.push(seat);
    return seat;
  }

  /** The seats as they stand: what a test reads to see which seat a job took (round 6, F1). */
  inspect(): { ready: boolean; busy: boolean }[] {
    return this.seats.filter((s) => !s.dead).map((s) => ({ ready: s.ready, busy: s.busy }));
  }

  /** The seats warmed ahead of the first write (the boot may call it; a test may not). A closed pool reopens. */
  async warm(): Promise<void> {
    this.closed = false;
    while (this.seats.filter((s) => !s.dead).length < this.size) this.spawn();
    await Promise.allSettled(this.seats.map((s) => s.warm));
  }

  /** For the boot's shutdown: the waiters are told, the seats terminated. */
  async close(): Promise<void> {
    this.closed = true;
    const waiters = this.waiting.splice(0);
    const all = this.seats.splice(0);
    for (const s of all) s.dead = true;
    await Promise.all(all.map((s) => s.worker.terminate()));
    for (const waiter of waiters)
      waiter({
        worker: all[0]?.worker ?? new Worker('', { eval: true }),
        warm: Promise.reject(new Error('the validation pool is closed')),
        ready: false,
        busy: true,
        dead: true
      });
  }
}

let shared: ValidationBudget | null = null;
/** The process's one pool, made on first use. */
export function validationBudget(): ValidationBudget {
  return (shared ??= new ValidationBudget());
}
