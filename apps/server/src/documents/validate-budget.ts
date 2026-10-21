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
 * run in ONE worker thread with a budget per job: a job over it is killed
 * with the worker, the worker replaced, and the caller told the schema took
 * too long. The request thread never waits on a regular expression.
 *
 * One worker per process, jobs one at a time (a second slow job queues
 * behind the first and meets the same budget once it starts). The worker
 * loads the contract package by name, which the runtime node_modules carries
 * (every bare import is external to the server bundle).
 */

export type BudgetedResult<T> =
  { ok: true; value: T } | { ok: false; reason: 'timeout' | 'failed'; message: string };

type Job =
  | { op: 'validate'; schema: Record<string, unknown>; data: unknown }
  | { op: 'extract'; source: string; schema: Record<string, unknown>; file: string };

type Reply = { ok: true; value: unknown } | { ok: false; message: string };

/** The worker's own code: it answers one message with one reply. */
const WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads');
let contract = null;
const load = async () => (contract ??= await import('@slideless/contract'));
parentPort.on('message', async (job) => {
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

/** How long one validation or one page's extraction may take. */
export const VALIDATION_BUDGET_MS = 250;

export class ValidationBudget {
  private worker: Worker | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly budgetMs: number = VALIDATION_BUDGET_MS) {}

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

  /** Jobs run one after the other on the one worker. */
  private run<T>(job: Job): Promise<BudgetedResult<T>> {
    const next = this.chain.then(() => this.once<T>(job));
    this.chain = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  private once<T>(job: Job): Promise<BudgetedResult<T>> {
    return new Promise((resolve) => {
      const worker = this.workerOrSpawn();
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        worker.removeAllListeners('message');
        worker.removeAllListeners('error');
        // The job is killed with its thread; the next job gets a fresh one.
        void worker.terminate();
        this.worker = null;
        resolve({
          ok: false,
          reason: 'timeout',
          message: `the schema took more than ${this.budgetMs} ms to judge this input; its patterns are too costly`
        });
      }, this.budgetMs);
      const done = (reply: Reply) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        worker.removeAllListeners('message');
        worker.removeAllListeners('error');
        if (reply.ok) resolve({ ok: true, value: reply.value as T });
        else resolve({ ok: false, reason: 'failed', message: reply.message });
      };
      worker.once('message', (reply: Reply) => done(reply));
      worker.once('error', (err: Error) => {
        this.worker = null;
        done({ ok: false, message: err.message });
      });
      worker.postMessage(job);
    });
  }

  private workerOrSpawn(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(WORKER_SOURCE, { eval: true, resourceLimits: { maxOldGenerationSizeMb: 256 } });
    worker.unref();
    worker.on('exit', () => {
      if (this.worker === worker) this.worker = null;
    });
    this.worker = worker;
    return worker;
  }

  /** For the boot's shutdown: nothing waits on it. */
  async close(): Promise<void> {
    const w = this.worker;
    this.worker = null;
    if (w) await w.terminate();
  }
}

let shared: ValidationBudget | null = null;
/** The process's one budget (one worker), made on first use. */
export function validationBudget(): ValidationBudget {
  return (shared ??= new ValidationBudget());
}
