import type { Component } from 'svelte';
import type { StatDrawingKind } from '$lib/components/brand/StatDrawing.svelte';
import type { NavFacts, NavItem } from '$lib/nav';

/**
 * What the tool gives the shell (PRDCT-2532). The dashboard is two halves:
 * the shell every Antasphere tool shares, and the tool's own half under
 * `src/lib/tool` and its route folders. The shell never imports the tool's
 * half, with two doors: `$lib/tool` (the one object of this shape) and
 * `$lib/tool/i18n` (the tool's words, merged into the catalogs). Everything
 * else the tool owns stays behind them; `boundary.test.ts` holds the line.
 *
 * It is a plain typed object the shell imports, on purpose: no registry,
 * nothing registered at run time, no layer over the components.
 */
export interface ToolContribution {
  /** The tool's sections of the menu, after the overview: the everyday ones. */
  nav(facts: Required<NavFacts>): NavItem[];
  /** The ids of its sections a phone keeps as thumb tabs beside the overview. */
  phoneTabs: string[];
  /** First path segments of its signed-out pages, which turn like the gate's own. */
  gateRoutes: string[];
  /** Its lists the shell warms once the app is idle (see stores/warmLists.ts). */
  warm(): void;
  audit: {
    /** The actions its server routes write, for the filter panel's vocabulary. */
    actions: string[];
    resourceTypes: string[];
    /** Which drawing a line of its own gets, tried after people and before files. */
    glyphs: { test: RegExp; icon: Component }[];
  };
  overview: {
    /** One model for the page's life; the pieces below read it. */
    create(facts: OverviewFacts): ToolOverview;
    /** Under the figures: what the tool has to show of late. */
    Recent: Component<{ model: ToolOverview }>;
    /** The first of the two lower tiles. */
    Tile: Component<{ model: ToolOverview }>;
  };
}

export interface OverviewFacts {
  isGuest: () => boolean;
  workspaceName: () => string;
}

export interface OverviewStat {
  id: string;
  label: string;
  /** null while it loads. */
  value: string | null;
  href: string;
  hint: string;
  drawing: StatDrawingKind;
  color: string;
}

export interface ToolOverview {
  load(): void;
  /** The hero's sentence, or null while the tool has nothing to say yet (the shell says its own). */
  readonly lede: string | null;
  /** The tool's figures, shown before the shell's. */
  readonly stats: OverviewStat[];
}
