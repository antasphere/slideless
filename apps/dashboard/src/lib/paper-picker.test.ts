import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PAPER_KEYS } from './theme.svelte';

/**
 * The paper at night and on the Identity card (PRDCT-4189, verifier round 3's
 * gaps): every night stays readable, the shared components' night colours
 * follow the night tokens, and the picker is there for every member, says
 * which paper is picked and shows each paper as it reads in the current mode.
 * Read as text: no browser computes the cascade or renders the page here.
 */

const SRC = join(import.meta.dirname, '..');
const read = (p: string) => readFileSync(join(SRC, p), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const tokens = read('lib/tokens.css');
const app = read('app.css');

function block(css: string, sel: string): Map<string, string> {
  const found = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => m[1].trim() === sel);
  expect(found, `exactly one ${sel} block`).toHaveLength(1);
  const decls = new Map<string, string>();
  for (const d of found[0][2].split(';')) {
    const i = d.indexOf(':');
    if (i >= 0) decls.set(d.slice(0, i).trim(), d.slice(i + 1).trim());
  }
  return decls;
}

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};
/** `H S% L%` of a hex, the form app.css writes (look.svelte.ts `triplet`). */
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

describe('each paper at night stays readable', () => {
  it('ink, its soft voice and the muted ink keep their contrast on the night ground', () => {
    for (const p of PAPER_KEYS) {
      const n = block(tokens, `:root.dark[data-paper='${p}']`);
      const ground = n.get('--ground')!;
      expect(contrast(n.get('--ink')!, ground), `${p} ink`).toBeGreaterThanOrEqual(12);
      expect(contrast(n.get('--ink-soft')!, ground), `${p} ink-soft`).toBeGreaterThanOrEqual(9);
      expect(contrast(n.get('--muted')!, ground), `${p} muted`).toBeGreaterThanOrEqual(4.5);
      expect(
        contrast(n.get('--muted')!, n.get('--ground-3')!),
        `${p} muted on ground-3`
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("the shared components' night triplets are the night tokens", () => {
    // the same mapping the dark set uses (app.css .dark against tokens.css :root.dark)
    const MAP: Record<string, string> = {
      '--background': '--ground',
      '--foreground': '--ink',
      '--muted-foreground': '--muted',
      '--popover': '--ground-3',
      '--card': '--ground',
      '--border': '--hairline',
      '--secondary-foreground': '--ink-soft',
      '--sidebar-background': '--ground-2',
      '--sidebar-foreground': '--ink-soft'
    };
    for (const p of PAPER_KEYS) {
      const night = block(tokens, `:root.dark[data-paper='${p}']`);
      const trip = block(app, `.dark[data-paper='${p}']`);
      for (const [v, token] of Object.entries(MAP))
        expect(trip.get(v), `${p} ${v} is ${token}`).toBe(triplet(night.get(token)!));
    }
  });
});

describe('the Paper row on the Identity card', () => {
  const page = read('routes/(app)/settings/+page.svelte');
  const picker = read('lib/components/settings/PaperPicker.svelte');

  it('is there for an admin, right above the colour, and for a member, who has no look form', () => {
    const admin = page.slice(
      page.indexOf('{#if isAdmin}'),
      page.indexOf('{:else}', page.indexOf('{#if isAdmin}'))
    );
    const member = page.slice(
      page.indexOf('{:else}', page.indexOf('{#if isAdmin}')),
      page.indexOf('{/if}', page.indexOf('{:else}', page.indexOf('{#if isAdmin}')))
    );
    expect(admin).toMatch(/<PaperPicker \/>\s*<LookPicker /);
    expect(member).toContain('<PaperPicker />');
  });

  it('marks the picked paper, applies it at once and draws each dot in the current mode', () => {
    expect(picker).toContain('aria-checked={theme.paper === key}');
    expect(picker).toContain('onclick={() => theme.setPaper(key)}');
    expect(picker).toContain('theme.dark ? PAPER_GROUNDS[key].night : PAPER_GROUNDS[key].ground');
    expect(picker).toMatch(/\{#each PAPER_KEYS as key/);
  });
});
