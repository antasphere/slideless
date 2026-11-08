import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PAPER_GROUNDS, PAPER_KEYS } from './theme.svelte';

/**
 * The paper blocks (PRDCT-4189): one `[data-paper]` block per brand ground
 * scale in tokens.css (the brand variables) and in app.css (their shadcn
 * triplets), each declaring the same set, creme repeating the recipe, the
 * dark set rewriting every variable a paper writes so a dark reader sees one
 * dark set whatever the paper. Read as text: no browser computes the cascade
 * here, so the order and the selectors are pinned instead.
 */

const SRC = join(import.meta.dirname, '..');
const tokens = readFileSync(join(SRC, 'lib/tokens.css'), 'utf8');
const app = readFileSync(join(SRC, 'app.css'), 'utf8');

const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Every block whose selector is exactly `sel`, as a map of its declarations (later wins, as in CSS). */
function blocks(css: string, sel: string): Map<string, string>[] {
  const out: Map<string, string>[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (const m of strip(css).matchAll(re)) {
    if (m[1].trim() !== sel) continue;
    const decls = new Map<string, string>();
    for (const d of m[2].split(';')) {
      const i = d.indexOf(':');
      if (i < 0) continue;
      decls.set(d.slice(0, i).trim(), d.slice(i + 1).trim());
    }
    out.push(decls);
  }
  return out;
}
function block(css: string, sel: string): Map<string, string> {
  const found = blocks(css, sel);
  expect(found, `exactly one ${sel} block`).toHaveLength(1);
  return found[0];
}
/** app.css's :root of the shadcn triplets (it has others, for the fonts and the motion). */
const appRoot = () => {
  const found = blocks(app, ':root').filter((b) => b.has('--background'));
  expect(found, 'exactly one :root block of triplets').toHaveLength(1);
  return found[0];
};
const paperSel = (p: string) => `[data-paper='${p}']`;
const allPaperSelectors = (css: string) =>
  [...strip(css).matchAll(/\[data-paper=['"]?([\w-]+)['"]?\]/g)].map((m) => m[1]);

const BRAND_VARS = [
  '--ground',
  '--ground-2',
  '--ground-3',
  '--hairline',
  '--muted',
  '--ink-soft',
  '--ink',
  '--bar',
  '--plate',
  '--plate-strong',
  '--plate-edge'
];

/** The brief's table: ground, ground-2, ground-3, hairline, muted, ink-soft, ink. */
const SCALES: Record<string, string[]> = {
  creme: ['#F7F4EC', '#F1EDE1', '#EAE5D6', '#E0DACA', '#6E6759', '#35302A', '#1C1915'],
  graphite: ['#F7F6F4', '#F0EFEC', '#E8E7E3', '#DCDBD6', '#6C6B66', '#333230', '#1A1918'],
  porcelain: ['#FCFBF8', '#F5F4EF', '#EDECE5', '#E2E0D7', '#716D63', '#35322C', '#1C1A16'],
  stone: ['#F4F1EB', '#EDEAE2', '#E4E0D6', '#D8D3C7', '#716C60', '#35322B', '#1C1A15'],
  fog: ['#F7F8F8', '#EFF1F1', '#E6E9E9', '#D9DDDD', '#666D6E', '#2F3536', '#171B1C']
};

const rgbOf = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

describe('tokens.css paper blocks', () => {
  it('has one block per paper key and no other', () => {
    expect(allPaperSelectors(tokens).sort()).toEqual([...PAPER_KEYS].sort());
  });

  it('each block declares the same eleven variables', () => {
    for (const p of PAPER_KEYS)
      expect([...block(tokens, paperSel(p)).keys()].sort(), p).toEqual([...BRAND_VARS].sort());
  });

  it('each block carries its scale from the brand table', () => {
    for (const p of PAPER_KEYS) {
      const b = block(tokens, paperSel(p));
      const got = BRAND_VARS.slice(0, 7).map((v) => b.get(v)?.toUpperCase());
      expect(got, p).toEqual(SCALES[p]);
      expect(b.get('--ground')?.toUpperCase(), `${p} ground matches the swatch`).toBe(
        PAPER_GROUNDS[p].ground
      );
      expect(b.get('--hairline')?.toUpperCase(), `${p} hairline matches the swatch`).toBe(
        PAPER_GROUNDS[p].hairline
      );
    }
  });

  it('creme repeats the recipe exactly, so no attribute and creme read the same', () => {
    const recipe = blocks(tokens, ':root').reduce(
      (acc, b) => new Map([...acc, ...b]),
      new Map<string, string>()
    );
    const creme = block(tokens, paperSel('creme'));
    for (const v of BRAND_VARS) expect(creme.get(v), v).toBe(recipe.get(v));
  });

  it('a bar is a touch lighter than its ground, and the plates are its colour', () => {
    for (const p of PAPER_KEYS.filter((k) => k !== 'creme')) {
      const b = block(tokens, paperSel(p));
      const ground = rgbOf(b.get('--ground')!);
      const bar = rgbOf(b.get('--bar')!);
      bar.forEach((c, i) => expect(c, `${p} bar channel ${i}`).toBeGreaterThanOrEqual(ground[i]));
      expect(
        bar.reduce((a, c) => a + c, 0),
        `${p} bar is lighter`
      ).toBeGreaterThan(ground.reduce((a, c) => a + c, 0));
      const [r, g, bl] = bar;
      expect(b.get('--plate'), p).toBe(`rgb(${r} ${g} ${bl} / 0.62)`);
      expect(b.get('--plate-strong'), p).toBe(`rgb(${r} ${g} ${bl} / 0.82)`);
    }
  });

  it('sit after the recipe and before the dark set, which outranks them', () => {
    const src = strip(tokens);
    const recipe = src.lastIndexOf(':root {', src.indexOf(paperSel('creme')));
    expect(recipe).toBeGreaterThan(-1);
    for (const p of PAPER_KEYS) expect(src.indexOf(paperSel(p)), p).toBeLessThan(src.indexOf(':root.dark'));
    const dark = block(tokens, ':root.dark');
    for (const v of BRAND_VARS) expect(dark.has(v), `the dark set writes ${v}`).toBe(true);
  });
});

describe('app.css paper triplets', () => {
  it('has one block per paper key and no other', () => {
    expect(allPaperSelectors(app).sort()).toEqual([...PAPER_KEYS].sort());
  });

  it('each block declares the same set, all of which the root and the dark set declare', () => {
    const sets = PAPER_KEYS.map((p) => [...block(app, paperSel(p)).keys()].sort());
    for (const s of sets) expect(s).toEqual(sets[0]);
    const root = appRoot();
    const dark = block(app, '.dark');
    for (const v of sets[0]) {
      expect(root.has(v), `:root declares ${v}`).toBe(true);
      expect(dark.has(v), `.dark rewrites ${v}`).toBe(true);
    }
  });

  it('creme repeats the root triplets exactly', () => {
    const root = appRoot();
    for (const [v, val] of block(app, paperSel('creme'))) expect(val, v).toBe(root.get(v));
  });

  it('never writes the accent triplets, which stay the look', () => {
    for (const p of PAPER_KEYS) {
      const b = block(app, paperSel(p));
      for (const v of ['--primary', '--primary-foreground', '--ring', '--sidebar-ring', '--destructive'])
        expect(b.has(v), `${p} ${v}`).toBe(false);
    }
  });

  it('sit before .dark, which has the same specificity and so wins', () => {
    const src = strip(app);
    for (const p of PAPER_KEYS) expect(src.indexOf(paperSel(p)), p).toBeLessThan(src.indexOf('.dark {'));
  });
});

describe('app.html boot script', () => {
  const html = readFileSync(join(SRC, 'app.html'), 'utf8');
  it('reads slideless.paper and sets data-paper for the four non-default papers only', () => {
    expect(html).toContain("localStorage.getItem('slideless.paper')");
    expect(html).toContain("setAttribute('data-paper', paper)");
    const list = html.match(/\[([^\]]*)\]\.indexOf\(paper\)/);
    expect(list, 'the boot script lists its papers').not.toBeNull();
    const keys = [...list![1].matchAll(/'([\w-]+)'/g)].map((m) => m[1]);
    expect(keys.sort()).toEqual(PAPER_KEYS.filter((k) => k !== 'creme').sort());
  });
});
