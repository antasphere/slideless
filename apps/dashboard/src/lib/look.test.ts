import { afterEach, describe, expect, it, vi } from 'vitest';
import { PALETTES } from '$lib/brand/recipe.js';
import { DEFAULT_LOOK, fieldPalette, look, paperGround } from './look.svelte';
import { PAPER_GROUNDS, PAPER_KEYS } from './theme.svelte';

/**
 * The page field follows the person's paper (PRDCT-4189): every palette and
 * the page's base mix the accent into the PICKED paper's ground by day; the
 * night keeps its one dark ground; creme keeps the names and the colours it
 * always had, so a person who never picks sees nothing change.
 */

const lum = (hex: string) =>
  [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).reduce((a, c) => a + c, 0);
const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

describe('paperGround', () => {
  it('is the picked paper by day', () => {
    for (const p of PAPER_KEYS) expect(paperGround(p, false)).toBe(PAPER_GROUNDS[p].ground);
  });
  it('is the one dark ground at night, whatever the paper', () => {
    const night = new Set(PAPER_KEYS.map((p) => paperGround(p, true)));
    expect([...night]).toEqual(['#1F1B17']);
  });
  it('reads an unknown paper as creme', () => {
    expect(paperGround('midnight' as never, false)).toBe('#F7F4EC');
  });
});

describe('fieldPalette', () => {
  it('on creme keeps the names it always had', () => {
    expect(fieldPalette('paper', false)).toBe('paper');
    expect(fieldPalette('paper', false, 'creme')).toBe('paper');
    expect(fieldPalette('dawn', false)).toBe('look-dawn');
    expect(fieldPalette('dawn', false, 'creme')).toBe('look-dawn');
  });

  it('on creme mixes from the creme ground, as before', () => {
    // the dawn accent pooled at 8% into #F7F4EC
    expect(PALETTES[fieldPalette('dawn', false, 'creme')].base).toBe('#f3e8df');
  });

  it('carries the paper in the name of every other paper, so the cache never serves another paper', () => {
    const names = PAPER_KEYS.map((p) => fieldPalette('glacier', false, p));
    expect(new Set(names).size).toBe(PAPER_KEYS.length);
    for (const p of PAPER_KEYS.filter((k) => k !== 'creme'))
      expect(fieldPalette('glacier', false, p)).toContain(p);
  });

  it('derives each paper from its own ground', () => {
    for (const p of PAPER_KEYS) {
      const pal = PALETTES[fieldPalette('reef', false, p)];
      // the faintest pool (2%) sits next to the paper's own ground
      const ground = channels(PAPER_GROUNDS[p].ground);
      channels(pal.hues[0]).forEach((c, i) =>
        expect(Math.abs(c - ground[i]), `${p} channel ${i}`).toBeLessThanOrEqual(4)
      );
    }
    expect(PALETTES[fieldPalette('reef', false, 'fog')].base).not.toBe(
      PALETTES[fieldPalette('reef', false, 'stone')].base
    );
  });

  it('gives the beige look a derived field on the four other papers', () => {
    for (const p of PAPER_KEYS.filter((k) => k !== 'creme')) {
      const name = fieldPalette('paper', false, p);
      expect(name).not.toBe('paper');
      expect(PALETTES[name].light).toBe(true);
      expect(Math.abs(lum(PALETTES[name].hues[0]) - lum(PAPER_GROUNDS[p].ground))).toBeLessThanOrEqual(12);
    }
  });

  it('at night ignores the paper: one dark field per theme', () => {
    for (const p of PAPER_KEYS) {
      expect(fieldPalette('paper', true, p)).toBe('paper-dark');
      expect(fieldPalette('dawn', true, p)).toBe('look-dawn-dark');
    }
  });
});

describe('look.apply writes the page base from the paper', () => {
  const props = new Map<string, string>();
  afterEach(() => {
    vi.unstubAllGlobals();
    props.clear();
  });
  const stub = () =>
    vi.stubGlobal('document', {
      documentElement: { style: { setProperty: (k: string, v: string) => void props.set(k, v) } }
    });

  it('the base at a zero gradient is the picked paper itself', () => {
    stub();
    look.try({ ...DEFAULT_LOOK, theme: 'dawn', field: 0 });
    for (const p of PAPER_KEYS) {
      look.apply(false, p);
      expect(props.get('--field-base')?.toUpperCase(), p).toBe(PAPER_GROUNDS[p].ground);
    }
  });

  it('with no paper given, the base is creme, as before', () => {
    stub();
    look.try({ ...DEFAULT_LOOK, theme: 'dawn', field: 0 });
    look.apply(false);
    expect(props.get('--field-base')?.toUpperCase()).toBe('#F7F4EC');
  });

  it('at night the base is the dark ground whatever the paper', () => {
    stub();
    look.try({ ...DEFAULT_LOOK, theme: 'dawn', field: 0 });
    for (const p of PAPER_KEYS) {
      look.apply(true, p);
      expect(props.get('--field-base')?.toUpperCase(), p).toBe('#1F1B17');
    }
  });
});
