import { describe, expect, it } from 'vitest';
import { duplicateTitle } from '../../src/presentations/service.js';

/**
 * The copy's default title (PRDCT-2279): the source title suffixed, cut by
 * CODE POINT to fit the 300-unit wire cap. A unit-wise slice split a
 * surrogate pair on a 150-emoji title (verifier round 1).
 */
/** A high surrogate without its low, or a low without its high: a string Postgres would not take as-is. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('duplicateTitle', () => {
  it('suffixes a short title untouched', () => {
    expect(duplicateTitle('Quarterly review')).toBe('Quarterly review (copy)');
  });

  it('fits a 300-unit ASCII title under the cap by dropping the tail', () => {
    const t = duplicateTitle('a'.repeat(300));
    expect(t).toBe(`${'a'.repeat(293)} (copy)`);
    expect(t.length).toBe(300);
  });

  it('never splits a surrogate pair: a 150-emoji title keeps whole emoji and stays well-formed', () => {
    const t = duplicateTitle('😀'.repeat(150));
    expect(LONE_SURROGATE.test(t)).toBe(false);
    expect(t.length).toBeLessThanOrEqual(300);
    expect(t.endsWith(' (copy)')).toBe(true);
    expect(Array.from(t.slice(0, -' (copy)'.length))).toEqual(Array(146).fill('😀'));
  });

  it('keeps every code point when the suffixed title already fits', () => {
    expect(duplicateTitle('😀'.repeat(10))).toBe(`${'😀'.repeat(10)} (copy)`);
  });
});
