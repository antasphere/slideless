import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  HEAD_WINDOW_BYTES,
  TAIL_WINDOW_BYTES,
  injectIntoHtml,
  injectIntoStream
} from '../../src/viewer/inject-stream.js';
import type { InjectionPlan } from '../../src/viewer/inject.js';

/**
 * PRDCT-1333 — the injection seam streams instead of buffering. These pin
 * the two properties the buffered predecessor gave for free and that a
 * windowed injector could plausibly break: byte fidelity (including UTF-8
 * across chunk boundaries) and bounded memory.
 */

const PLAN: InjectionPlan = { head: '<script data-head></script>', body: '\n<script data-body></script>\n' };

/** Feed a source in fixed-size chunks so boundaries land mid-token. */
function chunked(bytes: Buffer, size: number): Readable {
  let at = 0;
  return new Readable({
    read() {
      if (at >= bytes.length) {
        this.push(null);
        return;
      }
      this.push(bytes.subarray(at, at + size));
      at += size;
    }
  });
}

async function inject(html: string | Buffer, chunkSize = 7): Promise<string> {
  const bytes = Buffer.isBuffer(html) ? html : Buffer.from(html, 'utf8');
  const out: Buffer[] = [];
  for await (const chunk of injectIntoStream(chunked(bytes, chunkSize), PLAN)) {
    out.push(chunk as Buffer);
  }
  return Buffer.concat(out).toString('utf8');
}

describe('streaming injection', () => {
  it('injects after <head> and before the LAST </body>, byte-identical otherwise', async () => {
    const src = '<!doctype html><html><head><title>t</title></head><body><p>hi</p></body></html>';
    const streamed = await inject(src);
    expect(streamed).toBe(injectIntoHtml(src, PLAN));
    expect(streamed).toContain('<head><script data-head></script><title>t</title>');
    expect(streamed.indexOf('data-body')).toBeLessThan(streamed.lastIndexOf('</body>'));
    // The deck's own bytes survive untouched.
    expect(streamed.replace(PLAN.head, '').replace(PLAN.body, '')).toBe(src);
  });

  it('never splits a multi-byte character across chunk boundaries', async () => {
    // Emoji + accents straddling every 3-byte read: a naive per-chunk
    // toString('utf8') corrupts these into U+FFFD.
    const src = `<html><head></head><body>${'héllo 🌍 漢字 '.repeat(200)}</body></html>`;
    const streamed = await inject(src, 3);
    expect(streamed).not.toContain('�');
    expect(streamed.replace(PLAN.head, '').replace(PLAN.body, '')).toBe(src);
  });

  it('handles the last </body> of several, and case variants', async () => {
    const src = '<html><head></head><body><pre>&lt;/body&gt;</pre></BODY></html>';
    const streamed = await inject(src);
    expect(streamed).toBe(injectIntoHtml(src, PLAN));
    expect(streamed.indexOf('data-body')).toBeLessThan(streamed.indexOf('</BODY>'));
  });

  it('appends when the document has no </body> at all', async () => {
    const streamed = await inject('<html><head></head><p>fragment');
    expect(streamed.endsWith(PLAN.body)).toBe(true);
  });

  it('falls back to <body> when there is no <head>, and to nothing when there is neither', async () => {
    expect(await inject('<html><body>x</body></html>')).toContain('<body><script data-head></script>x');
    const headless = await inject('<p>bare fragment</p>');
    expect(headless).not.toContain('data-head');
    expect(headless).toContain('data-body');
  });

  it('holds only its window: a document far larger than both windows still injects once', async () => {
    // 4x the tail window of filler, in 64 KiB reads — the buffered
    // predecessor would have held all of it (that WAS the DoS).
    const filler = 'x'.repeat(TAIL_WINDOW_BYTES * 4);
    const src = `<html><head></head><body>${filler}</body></html>`;
    const streamed = await inject(src, 64 * 1024);
    expect(streamed.length).toBe(src.length + PLAN.head.length + PLAN.body.length);
    expect(streamed.split('data-body')).toHaveLength(2);
    expect(streamed.indexOf('data-body')).toBeLessThan(streamed.lastIndexOf('</body>'));
  });

  it('gives up on the early stub rather than buffer a document with no head in the window', async () => {
    const src = `<!-- ${'c'.repeat(HEAD_WINDOW_BYTES + 10)} --><body>x</body>`;
    const streamed = await inject(src, 8 * 1024);
    expect(streamed).not.toContain('data-head');
    expect(streamed).toContain('data-body');
  });

  it('propagates a source error instead of silently truncating', async () => {
    const boom = new Readable({
      read() {
        this.destroy(new Error('storage gone'));
      }
    });
    await expect(
      (async () => {
        for await (const _ of injectIntoStream(boom, PLAN)) void _;
      })()
    ).rejects.toThrow('storage gone');
  });
});
