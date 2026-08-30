// @ts-check
/* The hub's brand recipe: the swap point for everything generative.
   (theme, shape, seed) is everything a field needs to render
   deterministically; the values are the shipped website recipe, the same
   triple finance-app and hiring-app carry. Mirrors company/brand
   src/lib/brand.js — the console is the source of truth for these tables.

   PALETTES is extended with the website's section grounds (bluish
   `studio-field`, neutral `paper`): the engine ships the ten console
   themes only, and the hub's page fields sit on the Studio's paper. */
import { PALETTES as ENGINE_PALETTES } from '../engine/engine.js';

/** @typedef {{ light: boolean, base: string, hues: string[] }} Palette */
/** The engine's palettes, keyed by name (open, so the hub's grounds can join). */
export const PALETTES = /** @type {Record<string, Palette>} */ (ENGINE_PALETTES);

export const CONSTANTS = {
  grain: { type: 'film', alpha: 0.22, size: 1.0 }
};

/* The settled recipe — static, unlike the console's live editor. */
export const RECIPE = {
  theme: 'glacier',
  shape: 'caustic',
  seed: 976086463
};

/* Every theme names an engine palette and the three UI slots it may write. */
export const THEMES = {
  glacier: { accent: '#47799A', accentInk: '#F7F4EC', accentSoft: 'rgba(71,121,154,0.14)' },
  tide: { accent: '#5C7285', accentInk: '#F7F4EC', accentSoft: 'rgba(92,114,133,0.14)' },
  furnace: { accent: '#C25C2E', accentInk: '#F7F4EC', accentSoft: 'rgba(194,92,46,0.12)' },
  meadow: { accent: '#3E5C26', accentInk: '#F7F4EC', accentSoft: 'rgba(62,92,38,0.12)' },
  aurora: { accent: '#6C4FA8', accentInk: '#F7F4EC', accentSoft: 'rgba(108,79,168,0.12)' },
  solar: { accent: '#DE8B4A', accentInk: '#1C1915', accentSoft: 'rgba(222,139,74,0.18)' },
  pearl: { accent: '#7A66A8', accentInk: '#F7F4EC', accentSoft: 'rgba(122,102,168,0.14)' },
  dawn: { accent: '#C05E45', accentInk: '#F7F4EC', accentSoft: 'rgba(192,94,69,0.14)' },
  reef: { accent: '#2E8A74', accentInk: '#F7F4EC', accentSoft: 'rgba(46,138,116,0.14)' },
  iris: { accent: '#5058B4', accentInk: '#F7F4EC', accentSoft: 'rgba(80,88,180,0.14)' }
};

/* The website's page grounds (apps/website src/brand/recipe.ts), not console
   themes: the neutral paper and the Studio's bluish paper, each with its
   ink-end pair. The hue scales run wide on purpose — from nearly bare
   paper to a felt pool of the universe's colour — so zones read as weather
   rather than a filter, and reading text keeps its contrast. */
Object.assign(PALETTES, {
  paper: {
    light: true,
    base: '#EFEEEA',
    hues: ['#F8F7F5', '#F1F0ED', '#E9E8E4', '#DEDCD6', '#CFCCC5', '#F4F2EE', '#C5C2BA']
  },
  'paper-dark': {
    light: false,
    base: '#1A1918',
    hues: ['#141312', '#1F1E1C', '#2A2825', '#38352F', '#454139', '#171614', '#565046']
  },
  'studio-field': {
    light: true,
    base: '#EAF1F5',
    hues: ['#FAFCFD', '#EFF5F8', '#DCE9EF', '#C3D9E4', '#A4C4D6', '#F4F8FA', '#8AB0C8']
  },
  'studio-field-dark': {
    light: false,
    base: '#161B1F',
    hues: ['#10151B', '#1B242C', '#26333E', '#334759', '#41586E', '#141A20', '#47799A']
  }
});
