import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MOTION_DURATION_MS, MOTION_EASING } from '@slideless/contract';

/**
 * The one motion (PRDCT-2308): the dashboard's tokens carry the contract's
 * duration and easing verbatim. CSS cannot import the constant, so this is
 * the mirror's pin — change packages/contract/src/motion.ts without
 * carrying it into tokens.css and this goes red. The viewer bar's mirror is
 * pinned on the server side (test/unit/viewer-topbar-runtime.test.ts).
 */
describe('the motion tokens mirror the contract', () => {
  const tokens = readFileSync(fileURLToPath(new URL('./tokens.css', import.meta.url)), 'utf8');

  it('carries the duration once, as a millisecond value', () => {
    expect(tokens).toContain(`--motion-duration: ${MOTION_DURATION_MS}ms;`);
  });

  it('carries the easing verbatim', () => {
    expect(tokens).toContain(`--motion-ease: ${MOTION_EASING};`);
  });

  it('zeroes the duration under prefers-reduced-motion', () => {
    expect(tokens).toMatch(/prefers-reduced-motion: reduce\)\s*\{\s*:root\s*\{\s*--motion-duration: 0ms;/);
  });
});
