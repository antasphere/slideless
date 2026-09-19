/**
 * The look a person picks for their dashboard (PRDCT-2439): one of the brand's
 * ten themes, how much of the page field reaches them, how much grain sits on
 * it, and the workspace's form (one pattern of the brand's library, drawn
 * still on its tile). It is the brand console's recipe box, reduced to what
 * an app needs.
 *
 * A theme writes the brand's four slots and nothing else (tokens.css), plus the
 * shadcn triplets that mirror the accent, so every selected state, button and
 * focus ring follows. The page field is derived from the accent rather than
 * taken from the theme's own palette: the console's palettes are made for a
 * hero, and an app a person reads all day wants the same hue as a whisper, so
 * each field is the paper with the accent pooled into it at low strengths.
 * Kept in this browser, like the language (ADR 007): it is the person's.
 *
 * The look is PER WORKSPACE, the way the hub keeps it per organization. Each
 * workspace the person belongs to keeps its own look in this browser
 * (`slideless.look.<workspaceId>`), the switcher's tiles carry each
 * workspace's accent and form, and switching workspace switches the look. A
 * look stored under the old single key (`slideless.look`) becomes the look of
 * the first workspace loaded, so nobody loses what they picked.
 */
import { PALETTES, THEMES } from '$lib/brand/recipe.js';
import { isPatternKey, PATTERN_KEYS } from '$lib/brand/form';
import { seedOf } from '$lib/brand/seed';

export type ThemeKey = keyof typeof THEMES;
export const THEME_KEYS = Object.keys(THEMES) as ThemeKey[];

export interface Look {
  theme: ThemeKey;
  /** 0..1, how much of the field's gradient shows (the canvas's opacity). */
  field: number;
  /** 0..1, the film grain on the field and over the app; 0.5 is the brand's constant. */
  grain: number;
  /** The workspace's form: a key of the brand's pattern library, drawn still on its tile. */
  pattern: string;
}

export const DEFAULT_LOOK: Look = { theme: 'paper', field: 0.7, grain: 0.5, pattern: 'rings' };
/** The form a workspace starts with: dealt from its id, so two workspaces never start alike. */
export function dealtPattern(workspaceId: string): string {
  return workspaceId ? PATTERN_KEYS[seedOf(workspaceId) % PATTERN_KEYS.length] : DEFAULT_LOOK.pattern;
}
/** The default look of one workspace: the shared defaults with its dealt form. */
export function defaultLookFor(workspaceId: string): Look {
  return { ...DEFAULT_LOOK, pattern: dealtPattern(workspaceId) };
}
/** The pre-workspace key: read once as the first workspace's look, then removed. */
const LEGACY_KEY = 'slideless.look';
/** Where a workspace's look lives; no workspace (a session /me listed none) keeps the legacy key. */
function keyOf(workspaceId: string): string {
  return workspaceId ? `${LEGACY_KEY}.${workspaceId}` : LEGACY_KEY;
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

/** A stored value read back as a Look for one workspace, or null when there is none or it is not one. */
function parseLook(raw: string | null, workspaceId: string): Look | null {
  try {
    const stored = JSON.parse(raw ?? 'null') as Partial<Look> | null;
    if (!stored || typeof stored !== 'object') return null;
    return {
      theme: THEME_KEYS.includes(stored.theme as ThemeKey) ? (stored.theme as ThemeKey) : DEFAULT_LOOK.theme,
      field: clamp01(stored.field, DEFAULT_LOOK.field),
      grain: clamp01(stored.grain, DEFAULT_LOOK.grain),
      pattern: isPatternKey(stored.pattern) ? stored.pattern : dealtPattern(workspaceId)
    };
  } catch {
    /* a hand-edited value: no look */
    return null;
  }
}

/**
 * The look a workspace has in this browser, read only: what is stored for
 * it, or its default. For the switcher's other rows; the active workspace's
 * look is `look.value`, which follows the panel live.
 */
export function lookOf(workspaceId: string): Look {
  if (typeof localStorage === 'undefined') return defaultLookFor(workspaceId);
  try {
    return parseLook(localStorage.getItem(keyOf(workspaceId)), workspaceId) ?? defaultLookFor(workspaceId);
  } catch {
    /* privacy modes: the default look */
    return defaultLookFor(workspaceId);
  }
}

/**
 * Store a look for a workspace this browser has not loaded yet: the look a
 * person picked in the create dialog, written under the new workspace's id
 * the moment it exists, before the switch into it.
 */
export function saveLook(workspaceId: string, value: Look): void {
  try {
    localStorage.setItem(keyOf(workspaceId), JSON.stringify(value));
  } catch {
    /* not persisted: the workspace starts with its dealt look */
  }
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

class LookStore {
  value = $state<Look>({ ...DEFAULT_LOOK });
  /** The workspace whose look `value` is ('' before `use`, or when the session has none). */
  workspaceId = $state('');
  #loadedFor: string | null = null;

  /**
   * Make a workspace's look the current one: read what this browser keeps
   * for it and apply it. The pre-workspace value, if still there, is claimed
   * by the first workspace loaded and removed. Called from an effect that
   * also reads `value`, so it is a no-op for the workspace already loaded.
   */
  use(workspaceId: string): void {
    if (this.#loadedFor === workspaceId) return;
    this.#loadedFor = workspaceId;
    this.workspaceId = workspaceId;
    if (typeof localStorage === 'undefined') return;
    try {
      const key = keyOf(workspaceId);
      let stored = parseLook(localStorage.getItem(key), workspaceId);
      if (!stored && workspaceId && localStorage.getItem(LEGACY_KEY) !== null) {
        stored = parseLook(localStorage.getItem(LEGACY_KEY), workspaceId);
        if (stored) localStorage.setItem(key, JSON.stringify(stored));
        localStorage.removeItem(LEGACY_KEY);
      }
      this.value = stored ?? defaultLookFor(workspaceId);
    } catch {
      /* privacy modes: the default look */
      this.value = defaultLookFor(workspaceId);
    }
  }

  /** The current workspace's default look (its dealt form): what the panel's reset returns to. */
  get defaults(): Look {
    return defaultLookFor(this.workspaceId);
  }

  set(patch: Partial<Look>): void {
    this.value = { ...this.value, ...patch };
    try {
      localStorage.setItem(keyOf(this.workspaceId), JSON.stringify(this.value));
    } catch {
      /* not persisted, still applied */
    }
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
    root.setProperty('--field-base', mix(dark ? PAPER.dark : PAPER.light, t.accent, 0.08));
    for (const name of ['--primary', '--ring', '--sidebar-ring']) root.setProperty(name, triplet(accent));
    root.setProperty('--primary-foreground', triplet(ink));
  }
}

function clamp01(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback;
}

export const look = new LookStore();
