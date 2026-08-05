import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_JSON_DEPTH } from '../../src/middleware/json-depth.js';

/**
 * SL-B5, asserted where it actually bites: INSIDE THE SHIPPED IMAGE.
 *
 * `JSON.stringify` is recursive, so a deep-enough structure raises
 * `RangeError: Maximum call stack size exceeded`. The depth at which that
 * happens is a property of the V8 build, and it does NOT reproduce on a modern
 * host Node — measured here, `node:22-alpine` (v22.23.1) throws at depth 5000
 * while host Node 25 stringifies the same value happily. A regression test run
 * only on the developer's machine therefore proves nothing about the container
 * we ship.
 *
 * This test asserts two things against the image the Dockerfile actually
 * builds on:
 *
 *  1. the premise is real — stringify DOES throw at the depth the finding
 *     names, so the 500-plus-stack-trace it caused was not imagined;
 *  2. `MAX_JSON_DEPTH` sits comfortably below the breaking depth, so the
 *     edge guard rejects every payload that could reach it.
 *
 * If a future Node bump removes the recursion limit, assertion (1) fails and
 * someone gets to decide deliberately whether the guard is still wanted —
 * rather than the guard quietly becoming untested.
 */

/** The runtime base image from the Dockerfile's LAST `FROM` — what we ship. */
function runtimeBaseImage(): string {
  const dockerfile = readFileSync(join(import.meta.dirname, '../../../../Dockerfile'), 'utf8');
  const froms = [...dockerfile.matchAll(/^FROM\s+(\S+)/gm)].map((m) => m[1]!);
  const last = froms.at(-1);
  if (!last) throw new Error('no FROM in Dockerfile');
  return last;
}

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Probe run inside the image. Prints one JSON line so the assertions read the
 * image's real behaviour rather than an exit code.
 */
const PROBE = `
const depths = { guard: ${MAX_JSON_DEPTH}, breaking: 5000 };
const out = { version: process.version };
for (const [label, d] of Object.entries(depths)) {
  const text = '['.repeat(d) + '1' + ']'.repeat(d);
  const value = JSON.parse(text);
  try { JSON.stringify(value); out[label] = 'ok'; }
  catch (e) { out[label] = e.constructor.name + ': ' + e.message; }
}
console.log(JSON.stringify(out));
`;

describe.skipIf(!dockerAvailable())('deep JSON inside the shipped image', () => {
  it('stringify breaks at the depth the finding names, and MAX_JSON_DEPTH is safely below it', () => {
    const image = runtimeBaseImage();
    const raw = execFileSync('docker', ['run', '--rm', '--network', 'none', image, 'node', '-e', PROBE], {
      encoding: 'utf8',
      timeout: 180_000
    });
    const result = JSON.parse(raw.trim().split('\n').at(-1)!) as Record<string, string>;

    // (1) The premise: the shipped runtime really does blow the stack.
    expect(
      result.breaking,
      `image ${image} (${result.version}) no longer throws — re-read the note above`
    ).toMatch(/RangeError: Maximum call stack size exceeded/);

    // (2) The guard's cap is nowhere near the cliff, so nothing the edge lets
    //     through can reach a stringify that throws.
    expect(result.guard).toBe('ok');
  }, 240_000);
});
