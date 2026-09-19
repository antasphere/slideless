/**
 * The look of the dashboard: a fact of the WORKSPACE.
 *
 * One of the brand's ten themes, one pattern of the brand's library, how
 * much of the field's gradient reaches the page and how much grain sits on
 * it: all four are kept on the workspace row (`/me` carries them for every
 * workspace the person belongs to), changed from the workspace settings by
 * an owner or an admin, and the same on every member's screen. The theme and
 * the form moved there first (the settings pass of 2026-09-19; before that
 * they lived in this browser only, PRDCT-2439, so a colleague never saw the
 * colour you picked); the gradient and the grain followed the same day,
 * after a first cut had wrongly made them the person's. The old per-browser
 * values are not read.
 *
 * What stays the PERSON's is the language and the dark set (theme.svelte.ts,
 * ADR 007): how they read, not what the workspace looks like.
 *
 * A theme writes the brand's four slots and nothing else (tokens.css), plus
 * the shadcn triplets that mirror the accent, so every selected state,
 * button and focus ring follows. The page field is derived from the accent
 * rather than taken from the theme's own palette: the console's palettes are
 * made for a hero, and an app a person reads all day wants the same hue as
 * a whisper, so each field is the paper with the accent pooled into it at
 * low strengths.
 */
import type { WorkspaceLook } from '@antasphere/chassis-contract';
import { PALETTES, THEMES } from '$lib/brand/recipe.js';
import { isPatternKey, PATTERN_KEYS } from '$lib/brand/form';
import { seedOf } from '$lib/brand/seed';

export type ThemeKey = keyof typeof THEMES;
export const THEME_KEYS = Object.keys(THEMES) as ThemeKey[];
export function isThemeKey(key: unknown): key is ThemeKey {
  return typeof key === 'string' && THEME_KEYS.includes(key as ThemeKey);
}

/** The workspace's look: what the tile, the accent and the page are made of. */
export interface Look {
  theme: ThemeKey;
  /** The workspace's form: a key of the brand's pattern library, drawn still on its tile. */
  pattern: string;
  /** 0..1, how much of the field's gradient shows (the canvas's opacity). */
  field: number;
  /** 0..1, the film grain on the field and over the app; 0.5 is the brand's constant. */
  grain: number;
}

/**
 * The brand's own constants for the two levels — what `fieldLevel` measures
 * against and what the settings sliders tick as "the brand's". These are a
 * FIXED REFERENCE, not a starting value: move them and every workspace's
 * gradient is rescaled, because `fieldLevel` is `field / BRAND_LOOK.field`.
 */
export const BRAND_LOOK = { field: 0.7, grain: 0.5 } as const;

/**
 * What a NEW workspace starts with. The two levels open quieter than the
 * brand's constant on purpose: a fresh workspace should read as paper with
 * a breath of colour, and a person who wants more has the sliders. Changing
 * these is safe — they are only the starting point, and every workspace
 * that has saved a look keeps its own.
 */
export const DEFAULT_LOOK: Look = { theme: 'paper', pattern: 'rings', field: 0.25, grain: 0.7 };

/**
 * The gradient's level against the brand's constant: 0 when the workspace
 * turned it off, 1 at the constant, a little over when it asked for more.
 * Everything the accent pools into follows it — the page's field (its
 * opacity is the level itself), the page's own base and the hero band — so
 * at 0 the page is the plain paper and the accent is left to the marks.
 */
export function gradientLevel(look: Look): number {
  return look.field / BRAND_LOOK.field;
}

/** Two looks are the same look (what the settings page asks before it offers Save). */
export function sameLook(a: Look, b: Look): boolean {
  return a.theme === b.theme && a.pattern === b.pattern && a.field === b.field && a.grain === b.grain;
}

/** The form a workspace starts with: dealt from its id, so two workspaces never start alike. */
export function dealtPattern(workspaceId: string): string {
  return workspaceId ? PATTERN_KEYS[seedOf(workspaceId) % PATTERN_KEYS.length] : DEFAULT_LOOK.pattern;
}
/** A theme dealt from a name: what the create dialog proposes before the person picks. */
export function dealtTheme(seedKey: string): ThemeKey {
  const coloured = THEME_KEYS.filter((k) => k !== 'paper');
  return coloured[seedOf(seedKey || 'workspace') % coloured.length] ?? DEFAULT_LOOK.theme;
}
/** The default look of one workspace: the shared defaults with its dealt form. */
export function defaultLookFor(workspaceId: string): Look {
  return { ...DEFAULT_LOOK, pattern: dealtPattern(workspaceId) };
}

/**
 * The look a workspace wears, from what the server keeps for it: each key
 * is used when this dashboard knows it, else the default (a retired theme
 * never breaks a workspace; the server does not validate against the
 * catalogue).
 */
export function resolveLook(workspaceId: string, wire: WorkspaceLook | null | undefined): Look {
  const fallback = defaultLookFor(workspaceId);
  return {
    theme: isThemeKey(wire?.theme) ? wire.theme : fallback.theme,
    pattern: isPatternKey(wire?.pattern) ? wire.pattern : fallback.pattern,
    field: clamp01(wire?.field, fallback.field),
    grain: clamp01(wire?.grain, fallback.grain)
  };
}

const PAPER = { light: '#F7F4EC', dark: '#1F1B17' };

function rgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}
function mix(a: string, b: string, t: number): string {
  const [x, y] = [rgb(a), rgb(b)];
  return (
    '#' +
    x
      .map((v, i) =>
        Math.round(v + (y[i] - v) * t)
          .toString(16)
          .padStart(2, '0')
      )
      .join('')
  );
}
/** `H S% L%`, the form tailwind's hsl(var(--x) / alpha) composes. */
function triplet(hex: string): string {
  const [r, g, b] = rgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d) {
    s = d / (1 - Math.abs(2 * l - 1));
    h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h = Math.round(h * 60 + (h < 0 ? 360 : 0));
  }
  return `${h} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
}

/** The page field of a theme: the paper, with the accent pooled into it. Registered once per theme and mode. */
export function fieldPalette(theme: ThemeKey, dark: boolean): string {
  // the beige is not derived: it is the website's own home-screen field
  if (theme === 'paper') return dark ? 'paper-dark' : 'paper';
  const name = `look-${theme}${dark ? '-dark' : ''}`;
  if (!PALETTES[name]) {
    const accent = THEMES[theme].accent;
    const paper = dark ? PAPER.dark : PAPER.light;
    const pools = dark ? [0.02, 0.06, 0.12, 0.2, 0.3, 0.04, 0.4] : [0.02, 0.06, 0.12, 0.2, 0.3, 0.04, 0.42];
    PALETTES[name] = {
      light: !dark,
      base: mix(paper, accent, dark ? 0.07 : 0.08),
      hues: pools.map((p) => mix(paper, accent, p))
    };
  }
  return name;
}

/** The overview's hero: the theme in full colour (a hero may be loud where the page is a whisper). */
export function heroPalette(theme: ThemeKey, dark: boolean): string {
  const name = `hero-${theme}${dark ? '-dark' : ''}`;
  if (!PALETTES[name]) {
    const accent = THEMES[theme].accent;
    const paper = dark ? '#17120E' : '#FBF6EE';
    const pools = dark
      ? [0.05, 0.1, 0.18, 0.27, 0.36, 0.07, 0.46]
      : [0.02, 0.07, 0.13, 0.2, 0.28, 0.04, 0.36];
    PALETTES[name] = {
      light: !dark,
      base: mix(paper, accent, dark ? 0.12 : 0.08),
      hues: pools.map((x) => mix(paper, accent, x))
    };
  }
  return name;
}

/**
 * A theme's accent as the app shows it, with the ink that sits on it and the
 * wash it pools into: what `apply` writes to `--accent`, `--accent-ink` and
 * `--accent-soft`, factored so a workspace's tile carries the same colours as
 * its selected state. At night the accent is lifted toward the paper so it
 * keeps its contrast on a dark ground.
 */
export function accentOf(
  theme: ThemeKey,
  dark: boolean
): { accent: string; ink: string; soft: string; hairline: string } {
  const t = THEMES[theme];
  const accent = dark ? mix(t.accent, '#F7F4EC', 0.28) : t.accent;
  const [r, g, b] = rgb(accent);
  return {
    accent,
    ink: dark ? mix(t.accent, '#14100C', 0.78) : t.accentInk,
    soft: `rgba(${r}, ${g}, ${b}, ${dark ? 0.17 : 0.13})`,
    hairline: `rgba(${r}, ${g}, ${b}, ${dark ? 0.4 : 0.32})`
  };
}

/**
 * A theme as the inline variables of ONE surface: the create dialog wears the
 * colour being chosen, so the person sees it on the drawing, the marks and
 * the focus rings before the workspace exists. The same slots `apply` writes
 * on <html>, scoped to whatever element carries the string.
 */
export function tintStyle(theme: ThemeKey, dark: boolean): string {
  const t = THEMES[theme];
  const { accent, ink, soft } = accentOf(theme, dark);
  const deep = dark ? mix(t.accent, '#F7F4EC', 0.6) : mix(t.accent, '#1C1915', 0.32);
  return [
    `--accent: ${accent}`,
    `--accent-ink: ${ink}`,
    `--accent-soft: ${soft}`,
    `--accent-deep: ${deep}`,
    `--primary: ${triplet(accent)}`,
    `--ring: ${triplet(accent)}`,
    `--primary-foreground: ${triplet(ink)}`
  ].join('; ');
}

function clamp01(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback;
}

class LookStore {
  /** The active workspace's look, as the server keeps it (or as the settings page is trying it). */
  value = $state<Look>({ ...DEFAULT_LOOK });
  /** The workspace whose look `value` is ('' before `use`, or when the session has none). */
  workspaceId = $state('');

  /**
   * Make a workspace's look the current one, from what `/me` says about it.
   * Called from an effect that also reads `value`; re-running it for the
   * same workspace and the same wire look is a no-op, so a live try on the
   * settings page is not undone by the effect.
   */
  use(workspaceId: string, wire: WorkspaceLook | null | undefined): void {
    const next = resolveLook(workspaceId, wire);
    const wireKey = [wire?.theme, wire?.pattern, wire?.field, wire?.grain].map((v) => v ?? '').join('|');
    if (this.workspaceId !== workspaceId || this.#wireKey !== wireKey) {
      this.workspaceId = workspaceId;
      this.#wireKey = wireKey;
      this.value = next;
    }
  }
  #wireKey = '';

  /** The current workspace's default look (its dealt form): what a reset returns to. */
  get defaults(): Look {
    return defaultLookFor(this.workspaceId);
  }

  /**
   * Try a look on the whole shell, at once. The settings page calls it as
   * the person picks, so the sidebar and the field answer live; what is
   * saved is the server's business (the page's Save), and the page puts
   * the saved look back on a cancel.
   */
  try(patch: Partial<Look>): void {
    this.value = { ...this.value, ...patch };
  }

  /** Write the theme's slots on <html>. Called from an effect, so it re-runs on a theme or mode change. */
  apply(dark: boolean): void {
    const t = THEMES[this.value.theme];
    const { accent, ink, soft } = accentOf(this.value.theme, dark);
    const root = document.documentElement.style;
    root.setProperty('--accent', accent);
    root.setProperty('--accent-ink', ink);
    root.setProperty('--accent-soft', soft);
    root.setProperty('--accent-deep', dark ? mix(t.accent, '#F7F4EC', 0.6) : mix(t.accent, '#1C1915', 0.32));
    // the page's base carries the accent as far as the gradient is asked for:
    // none of it at 0, where the page lands on the paper itself
    const tint = 0.08 * gradientLevel(this.value);
    root.setProperty('--field-base', mix(dark ? PAPER.dark : PAPER.light, t.accent, tint));
    for (const name of ['--primary', '--ring', '--sidebar-ring']) root.setProperty(name, triplet(accent));
    root.setProperty('--primary-foreground', triplet(ink));
  }
}

export const look = new LookStore();
