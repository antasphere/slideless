import { describe, expect, it } from 'vitest';
import { MOTION_EASING } from '@slideless/contract';
import { cubicBezier, motionDuration, motionEase, parseCubicBezier } from './reveal';

describe('the fold reads the product motion', () => {
  it('parses the contract easing', () => {
    expect(parseCubicBezier(MOTION_EASING)).toEqual([0.2, 0, 0, 1]);
    expect(parseCubicBezier('ease-out')).toBeNull();
  });

  it('solves a bezier: fixed ends, monotonic, linear when the handles say so', () => {
    expect(motionEase(0)).toBe(0);
    expect(motionEase(1)).toBe(1);
    let last = 0;
    for (let i = 1; i <= 20; i += 1) {
      const v = motionEase(i / 20);
      expect(v).toBeGreaterThanOrEqual(last);
      last = v;
    }
    // the product's curve is an ease-out: well past half way at the midpoint
    expect(motionEase(0.5)).toBeGreaterThan(0.8);
    const linear = cubicBezier(0.25, 0.25, 0.75, 0.75);
    expect(linear(0.3)).toBeCloseTo(0.3, 3);
  });

  it('keeps the duration outside a browser, scaled', () => {
    expect(motionDuration()).toBe(160);
    expect(motionDuration(1.25)).toBe(200);
  });
});
