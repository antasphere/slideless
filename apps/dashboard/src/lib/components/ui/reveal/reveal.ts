import { MOTION_DURATION_MS, MOTION_EASING } from '@slideless/contract';
import type { TransitionConfig } from 'svelte/transition';

/**
 * The fold: how a block that depends on a choice (a checkbox, a select, an
 * error under a field) enters and leaves. Its height opens from nothing, its
 * margins and paddings with it so the form around it never jumps, and the
 * content fades in a little later than the room is made for it. One duration
 * and one easing, the product's (packages/contract/src/motion.ts); a reader
 * who asked for no motion gets the block at once.
 */

/** Parses `cubic-bezier(a, b, c, d)` into its four numbers; null when it is not one. */
export function parseCubicBezier(value: string): [number, number, number, number] | null {
  const m = /^cubic-bezier\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)$/.exec(
    value.trim()
  );
  if (!m) return null;
  const n = m.slice(1, 5).map(Number);
  if (n.some((x) => Number.isNaN(x))) return null;
  return [n[0]!, n[1]!, n[2]!, n[3]!];
}

/** A cubic bezier timing function as `t => progress`, solved by bisection (monotonic in x). */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const at = (a: number, b: number, s: number) =>
    3 * a * s * (1 - s) * (1 - s) + 3 * b * s * s * (1 - s) + s * s * s;
  return (t) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 24; i += 1) {
      const mid = (lo + hi) / 2;
      if (at(x1, x2, mid) < t) lo = mid;
      else hi = mid;
    }
    return at(y1, y2, (lo + hi) / 2);
  };
}

const bezier = parseCubicBezier(MOTION_EASING);
/** The product's easing as a function, for the transitions CSS cannot express alone. */
export const motionEase: (t: number) => number = bezier ? cubicBezier(...bezier) : (t) => t;

/** The product's duration, or zero for a reader who asked for no motion. */
export function motionDuration(scale = 1): number {
  const reduced =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  return reduced ? 0 : Math.round(MOTION_DURATION_MS * scale);
}

export interface RevealParams {
  /** Multiplies the product's duration: a tall block may take a breath more. */
  scale?: number;
  delay?: number;
}

/**
 * The Svelte transition behind `Reveal`, usable directly on any element
 * (`transition:reveal`): a list row, an error line, a banner.
 */
export function reveal(node: Element, { scale = 1.25, delay = 0 }: RevealParams = {}): TransitionConfig {
  const style = getComputedStyle(node);
  const opacity = Number(style.opacity);
  const px = (v: string) => Number.parseFloat(v) || 0;
  const height = px(style.height);
  const paddingTop = px(style.paddingTop);
  const paddingBottom = px(style.paddingBottom);
  const marginTop = px(style.marginTop);
  const marginBottom = px(style.marginBottom);
  const borderTop = px(style.borderTopWidth);
  const borderBottom = px(style.borderBottomWidth);
  return {
    delay,
    duration: motionDuration(scale),
    easing: motionEase,
    css: (t) => {
      // the content arrives once there is room for it: nothing before 35 %
      const fade = Math.max(0, (t - 0.35) / 0.65);
      return (
        'overflow: hidden;' +
        `opacity: ${fade * opacity};` +
        `height: ${t * height}px;` +
        `padding-top: ${t * paddingTop}px;` +
        `padding-bottom: ${t * paddingBottom}px;` +
        `margin-top: ${t * marginTop}px;` +
        `margin-bottom: ${t * marginBottom}px;` +
        `border-top-width: ${t * borderTop}px;` +
        `border-bottom-width: ${t * borderBottom}px;`
      );
    }
  };
}

/**
 * For a block that REPLACES another (sign in / create account, a form and its
 * "sent" state): the old one leaves at once, the new one settles in. No
 * height is animated, since both are never in the page together.
 * Use as `in:appear`.
 */
export function appear(_node: Element, { scale = 1.25, delay = 0 }: RevealParams = {}): TransitionConfig {
  return {
    delay,
    duration: motionDuration(scale),
    easing: motionEase,
    css: (t) => `opacity: ${t}; transform: translateY(${(1 - t) * 4}px);`
  };
}
