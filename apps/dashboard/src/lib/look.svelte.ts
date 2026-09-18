/**
 * The look a person picks for their dashboard (PRDCT-2439): one of the brand's
 * ten themes, how much of the page field reaches them, and how much grain sits
 * on it. It is the brand console's recipe box, reduced to what an app needs.
 *
 * A theme writes the brand's four slots and nothing else (tokens.css), plus the
 * shadcn triplets that mirror the accent, so every selected state, button and
 * focus ring follows. The page field is derived from the accent rather than
 * taken from the theme's own palette: the console's palettes are made for a
 * hero, and an app a person reads all day wants the same hue as a whisper, so
 * each field is the paper with the accent pooled into it at low strengths.
 * Kept in this browser, like the language (ADR 007): it is the person's.
 */
import { PALETTES, THEMES } from '$lib/brand/recipe.js';

export type ThemeKey = keyof typeof THEMES;
export const THEME_KEYS = Object.keys(THEMES) as ThemeKey[];

export interface Look {
  theme: ThemeKey;
  /** 0..1, how much of the field's gradient shows (the canvas's opacity). */
  field: number;
  /** 0..1, the film grain on the field and over the app; 0.5 is the brand's constant. */
  grain: number;
}

export const DEFAULT_LOOK: Look = { theme: 'paper', field: 0.7, grain: 0.5 };
const KEY = 'slideless.look';

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
    const pools = dark ? [0.08, 0.18, 0.3, 0.44, 0.58, 0.12, 0.7] : [0.04, 0.14, 0.26, 0.4, 0.56, 0.08, 0.7];
    PALETTES[name] = {
      light: !dark,
      base: mix(paper, accent, dark ? 0.2 : 0.16),
      hues: pools.map((x) => mix(paper, accent, x))
    };
  }
  return name;
}

class LookStore {
  value = $state<Look>({ ...DEFAULT_LOOK });
  #loaded = false;

  load(): void {
    if (this.#loaded || typeof localStorage === 'undefined') return;
    this.#loaded = true;
    try {
      const stored = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Look> | null;
      if (stored && typeof stored === 'object') {
        this.value = {
          theme: THEME_KEYS.includes(stored.theme as ThemeKey)
            ? (stored.theme as ThemeKey)
            : DEFAULT_LOOK.theme,
          field: clamp01(stored.field, DEFAULT_LOOK.field),
          grain: clamp01(stored.grain, DEFAULT_LOOK.grain)
        };
      }
    } catch {
      /* privacy modes, a hand-edited value: the default look */
    }
  }

  set(patch: Partial<Look>): void {
    this.value = { ...this.value, ...patch };
    try {
      localStorage.setItem(KEY, JSON.stringify(this.value));
    } catch {
      /* not persisted, still applied */
    }
  }

  /** Write the theme's slots on <html>. Called from an effect, so it re-runs on a theme or mode change. */
  apply(dark: boolean): void {
    const t = THEMES[this.value.theme];
    // at night the accent is lifted toward the paper so it keeps its contrast on a dark ground
    const accent = dark ? mix(t.accent, '#F7F4EC', 0.28) : t.accent;
    const ink = dark ? mix(t.accent, '#14100C', 0.78) : t.accentInk;
    const [r, g, b] = rgb(accent);
    const root = document.documentElement.style;
    root.setProperty('--accent', accent);
    root.setProperty('--accent-ink', ink);
    root.setProperty('--accent-soft', `rgba(${r}, ${g}, ${b}, ${dark ? 0.17 : 0.13})`);
    root.setProperty('--accent-deep', dark ? mix(t.accent, '#F7F4EC', 0.6) : mix(t.accent, '#1C1915', 0.32));
    root.setProperty('--field-base', mix(dark ? PAPER.dark : PAPER.light, t.accent, 0.08));
    for (const name of ['--primary', '--ring', '--sidebar-ring']) root.setProperty(name, triplet(accent));
    root.setProperty('--primary-foreground', triplet(ink));
  }
}

function clamp01(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback;
}

export const look = new LookStore();
