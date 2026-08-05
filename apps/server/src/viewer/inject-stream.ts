import { Transform, type Readable, type TransformCallback } from 'node:stream';
import type { InjectionPlan } from './inject.js';

/**
 * STREAMING INJECTION (PRDCT-1333, audit §3).
 *
 * The ADR 020/022 seam used to buffer: the whole deck document was read into
 * a `Buffer[]`, concatenated, stringified and returned. With
 * `can_submit_forms` defaulting ON that path became the default for EVERY
 * share link, and one anonymous unauthenticated GET peaked the server at
 * roughly ten times the document size (measured: 1,374 MiB RSS on a 50 MB
 * deck at 8 concurrent GETs, versus 290 MiB streaming). `/v/{secret}/` has no
 * rate limiter, so that was a one-request OOM on a small VPS.
 *
 * This transform injects the same bytes with a BOUNDED window instead:
 *
 *  - the EARLY stub goes right after the opening `<head>` tag, which is found
 *    inside the first `HEAD_WINDOW_BYTES`; nothing is held past that;
 *  - the RUNTIME goes before the LAST `</body>`, found inside a rolling
 *    `TAIL_WINDOW_BYTES` tail. Everything before the tail is pushed through
 *    as it arrives, so peak memory is the window, not the document.
 *
 * Both searches run over BYTES, never over a decoded string: `<head>` and
 * `</body>` are pure ASCII and UTF-8 continuation bytes are all >= 0x80, so a
 * byte search can neither false-match inside a multi-byte character nor split
 * one (the old `Buffer.concat(...).toString('utf8')` had to decode the whole
 * document to do the same job).
 *
 * Fidelity note vs. the buffered predecessor: the last `</body>` is located
 * within the final window rather than the whole document. A document with
 * more than `TAIL_WINDOW_BYTES` of trailing content after its last `</body>`
 * gets the runtime appended at EOF instead — the same fallback the buffered
 * version already used for documents with no `</body>` at all.
 */

/** How far into the document the opening `<head>` is looked for. */
export const HEAD_WINDOW_BYTES = 64 * 1024;

/** How many trailing bytes are held back to locate the last `</body>`. */
export const TAIL_WINDOW_BYTES = 64 * 1024;

/** ASCII-only lowercase copy — leaves every byte >= 0x80 untouched. */
function asciiLower(buf: Buffer): Buffer {
  const out: Buffer = Buffer.allocUnsafe(buf.length);
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i]!;
    out[i] = b >= 0x41 && b <= 0x5a ? b + 0x20 : b;
  }
  return out;
}

/**
 * Byte offset just PAST the first `<head …>` (else `<body …>`) open tag, or
 * -1 meaning "not here yet" — either more bytes are needed or the document
 * has neither tag. `<header>` and friends are rejected: the tag name must end
 * at `>` or whitespace.
 */
function headInsertionPoint(buf: Buffer): number {
  const lower = asciiLower(buf);
  for (const tag of ['<head', '<body']) {
    for (let at = lower.indexOf(tag); at !== -1; at = lower.indexOf(tag, at + 1)) {
      const after = lower[at + tag.length];
      if (after === undefined) return -1; // truncated mid-tag: wait for more
      if (after !== 0x3e /* > */ && after > 0x20) continue; // <header>, <bodyish>
      const close = lower.indexOf(0x3e, at);
      return close === -1 ? -1 : close + 1;
    }
  }
  return -1;
}

/** Byte offset of the LAST `</body …>` open bracket in the buffer, or -1. */
function bodyCloseOffset(buf: Buffer): number {
  return asciiLower(buf).lastIndexOf('</body>');
}

class InjectingTransform extends Transform {
  private headPending: Buffer | null;
  private readonly headSnippet: Buffer;
  private readonly bodySnippet: Buffer;
  private tail: Buffer = Buffer.alloc(0);

  constructor(plan: InjectionPlan) {
    super();
    this.headSnippet = Buffer.from(plan.head, 'utf8');
    this.bodySnippet = Buffer.from(plan.body, 'utf8');
    this.headPending = plan.head === '' ? null : Buffer.alloc(0);
  }

  /** Feed bytes past the head stage into the rolling tail window. */
  private feed(buf: Buffer): void {
    this.tail = this.tail.length === 0 ? buf : Buffer.concat([this.tail, buf]);
    if (this.tail.length > TAIL_WINDOW_BYTES) {
      const cut = this.tail.length - TAIL_WINDOW_BYTES;
      this.push(this.tail.subarray(0, cut));
      this.tail = this.tail.subarray(cut);
    }
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, done: TransformCallback): void {
    if (this.headPending !== null) {
      this.headPending = Buffer.concat([this.headPending, chunk]);
      const at = headInsertionPoint(this.headPending);
      if (at !== -1) {
        const pending = this.headPending;
        this.headPending = null;
        this.feed(Buffer.concat([pending.subarray(0, at), this.headSnippet, pending.subarray(at)]));
      } else if (this.headPending.length >= HEAD_WINDOW_BYTES) {
        // No head/body open tag in the window: give up on the early stub
        // rather than hold the document (the runtime falls back to reading
        // location.hash itself).
        const pending = this.headPending;
        this.headPending = null;
        this.feed(pending);
      }
      done();
      return;
    }
    this.feed(chunk);
    done();
  }

  override _flush(done: TransformCallback): void {
    if (this.headPending !== null) {
      const pending = this.headPending;
      this.headPending = null;
      this.feed(pending);
    }
    const at = bodyCloseOffset(this.tail);
    if (at === -1) {
      this.push(this.tail);
      this.push(this.bodySnippet);
    } else {
      this.push(this.tail.subarray(0, at));
      this.push(this.bodySnippet);
      this.push(this.tail.subarray(at));
    }
    this.tail = Buffer.alloc(0);
    done();
  }
}

/**
 * Pipe `source` through the injector. The returned stream is destroyed with
 * the source on error so a mid-transfer storage failure never leaks a
 * descriptor or an S3 socket (the serveBlob posture).
 */
export function injectIntoStream(source: Readable, plan: InjectionPlan): Readable {
  const transform = new InjectingTransform(plan);
  source.on('error', (e) => transform.destroy(e));
  source.pipe(transform);
  return transform;
}

/**
 * The buffered equivalent, kept for tests and for callers that already hold
 * the whole document as a string. Injects before the LAST `</body>`.
 */
export function injectIntoHtml(html: string, plan: InjectionPlan): string {
  let buf: Buffer = Buffer.from(html, 'utf8');
  if (plan.head !== '') {
    const at = headInsertionPoint(buf);
    if (at !== -1) {
      buf = Buffer.concat([buf.subarray(0, at), Buffer.from(plan.head, 'utf8'), buf.subarray(at)]);
    }
  }
  const idx = bodyCloseOffset(buf);
  const body = Buffer.from(plan.body, 'utf8');
  return (
    idx === -1 ? Buffer.concat([buf, body]) : Buffer.concat([buf.subarray(0, idx), body, buf.subarray(idx)])
  ).toString('utf8');
}
