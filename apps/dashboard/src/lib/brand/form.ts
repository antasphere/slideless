/**
 * A workspace's form: one pattern of the brand's library (animations.js,
 * the same draws the section cards play) rendered small and STILL. One frame,
 * mid-bloom, the centre cell of the pattern's grid cropped to a square, as an
 * alpha mask (black ink) so the colour is CSS's: the tile paints it in the
 * organization's accent, the recipe box in the current one, from the same
 * bitmap. Cached per pattern, size and pixel ratio; nothing here animates.
 */
import { ANIMATIONS, animationByKey } from './animations.js';
import { mulberry32, clamp, TAU } from '$lib/engine/engine.js';

/**
 * The forms a NEW workspace is dealt from, and the list `dealtPattern`
 * indexes by seed. Twelve of the library's nineteen, the ones that read as
 * distinct marks at tile size (the settings pass of 2026-09-19: two ring
 * forms, four line forms, two grids, two dot matrices and two stars were
 * one too many of each). A form retired from the offer stays a valid key,
 * so a workspace that wears one keeps its tile.
 *
 * ORDER AND LENGTH ARE LOAD-BEARING: `dealtPattern` is
 * `PATTERN_KEYS[seed % length]`, so inserting, removing or reordering a key
 * re-deals the starting form of every workspace that has not chosen one.
 * To change what the PICKER offers, edit `OFFERED_PATTERN_KEYS` below.
 */
export const PATTERN_KEYS: string[] = [
  'crosses',
  'blooms',
  'gears',
  'slides',
  'panes',
  'rings',
  'weave',
  'stagger',
  'truss',
  'sonar',
  'diamond',
  'triangle'
];
/**
 * What the picker shows: five forms, not twelve. A dozen small glyphs read
 * as a swatch sheet to work through rather than a choice to make, and at
 * picker size the differences between near neighbours (two rings, two
 * grids) are not the point — five distinct marks are. Each one here is a
 * different family: a cross, a bloom, a pane, a ring and a diamond.
 *
 * This is the OFFER only. `PATTERN_KEYS` stays whole, so every existing
 * workspace keeps the form it was dealt or chose, and a person who already
 * wears a form outside this five keeps wearing it (the picker shows it as
 * the current mark; `patternName` and `formMask` work for every library
 * key). Widen the offer by adding a key here, never by reordering above.
 */
export const OFFERED_PATTERN_KEYS: string[] = ['crosses', 'blooms', 'panes', 'rings', 'diamond'];

const LIBRARY_KEYS: string[] = ANIMATIONS.map((a) => a.key);
export function isPatternKey(key: unknown): key is string {
  return typeof key === 'string' && LIBRARY_KEYS.includes(key);
}
/** The library's own name for a pattern (its card title). */
export function patternName(key: string): string {
  return animationByKey(key).name;
}

export interface FormOptions {
  /** Where in the bloom the frame is taken: 0 the resting shape, 1 the full bloom (neighbours then overlap). */
  hover?: number;
  /** The pattern's cell as a fraction of the tile: smaller shows more of the grid. */
  cell?: number;
  /** How much the library's whisper alphas are lifted for a mark this small. */
  gain?: number;
}
const DEFAULTS: Required<FormOptions> = { hover: 0.5, cell: 0.8, gain: 2.4 };

/* The patterns that are a grid of one form per cell: the tile shows the
   centre cell alone, clipped, so it reads as one mark. At mid-bloom the form
   reaches exactly the half-cell line and the neighbours stop exactly there.
   The others are sheets (lines, bands, a lattice) and show a window. */
const CELL_PATTERNS = new Set([
  'crosses',
  'blooms',
  'gears',
  'slides',
  'panes',
  'rings',
  'portico',
  'hexpinch',
  'diamond',
  'triangle'
]);
/* The frame a pattern is taken at where the shared one says less: the cross
   later in its bloom (its arms), the turning forms earlier (before they
   interlace with their neighbours), the sonar's contours nested, and the two
   pixel-pitched matrices with the window centred on one of their points (the
   wavefront's crest brought there, the written ring part-drawn). */
const FRAME: Record<
  string,
  { hover?: number; t?: number; centre?: (W: number, H: number, ratio: number) => [number, number] }
> = {
  crosses: { hover: 0.8 },
  diamond: { hover: 0.35 },
  triangle: { hover: 0.3 },
  hexpinch: { hover: 0.6 },
  sonar: { hover: 1 },
  truss: { hover: 0.8 },
  written: {
    centre: (_W, _H, ratio) => {
      const gap = Math.max(20, Math.round(32 * ratio));
      return [2 * gap, gap];
    }
  },
  wavefront: {
    hover: 1,
    t: 1.28,
    centre: (_W, _H, ratio) => {
      const gap = Math.max(14, Math.round(22 * ratio));
      return [3 * gap, 2 * gap];
    }
  }
};

const lerp = (a: number, b: number, x: number) => a + (b - a) * x;
const ease = (x: number) => {
  const c = clamp(x, 0, 1);
  return c * c * (3 - 2 * c);
};

type Draw = (ctx: CanvasRenderingContext2D, W: number, H: number, u: unknown) => void;

const cache = new Map<string, string>();

/**
 * The form as a PNG data URL, `size` CSS px square at `dpr`: black where the
 * pattern's ink is, transparent elsewhere. '' before there is a document.
 */
export function formMask(pattern: string, size: number, dpr?: number, opts: FormOptions = {}): string {
  if (typeof document === 'undefined') return '';
  const o = { ...DEFAULTS, ...opts };
  const ratio = dpr ?? Math.min(3, window.devicePixelRatio || 1);
  const key = `${pattern}|${size}|${ratio}|${o.hover}|${o.cell}|${o.gain}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const px = Math.round(size * ratio);
  const cell = px * o.cell;
  // the library draws a 5 x 3 grid and bleeds one cell past every edge: the
  // stage is that grid, the tile its centre
  const W = Math.round(cell * 5);
  const H = Math.round(cell * 3);
  const stage = document.createElement('canvas');
  stage.width = W;
  stage.height = H;
  const ctx = stage.getContext('2d');
  if (!ctx) return '';
  const draw = animationByKey(pattern).draw as Draw;
  const frame = FRAME[pattern] ?? {};
  const seed = 7;
  ctx.save();
  if (CELL_PATTERNS.has(pattern)) {
    const r = cell * 0.5;
    ctx.beginPath();
    ctx.roundRect(W / 2 - r, H / 2 - r, 2 * r, 2 * r, r * 0.42);
    ctx.clip();
  }
  draw(ctx, W, H, {
    t: frame.t ?? 0,
    hover: frame.hover ?? o.hover,
    seed,
    rnd: mulberry32(seed),
    DPR: ratio,
    TAU,
    lerp,
    ease,
    ink: (a: number) => 'rgba(0,0,0,' + clamp(a * o.gain, 0, 1).toFixed(3) + ')'
  });
  ctx.restore();

  const out = document.createElement('canvas');
  out.width = px;
  out.height = px;
  const octx = out.getContext('2d');
  if (!octx) return '';
  const [cx, cy] = frame.centre?.(W, H, ratio) ?? [W / 2, H / 2];
  octx.drawImage(stage, Math.round(cx - px / 2), Math.round(cy - px / 2), px, px, 0, 0, px, px);
  const url = out.toDataURL('image/png');
  cache.set(key, url);
  return url;
}
