<script lang="ts" module>
  import type { Component } from 'svelte';

  export interface DeckTab {
    /** The `?tab=` value; `overview` is the bare path. */
    id: string;
    label: string;
    icon: Component;
    count?: number;
  }
</script>

<script lang="ts">
  /* The bar under the deck's banner and facts (PRDCT-2686): one tab per
     section of the deck's page, in the look of the library's bar
     (SectionTabs): the page's ground, one hairline under it, held at the top
     of the scroll container once the page scrolls. Each tab is a link on the
     same route with its own `?tab=`, so the back button, a reload and a
     shared URL all land on the right section; the deck's page is keyed on the
     deck id only, so a tab change never remounts it. */
  import { page } from '$app/state';
  import { stuck } from '$lib/components/shared/stuck';

  interface Props {
    tabs: DeckTab[];
    label: string;
    /** The tab shown: the page reads it from the query and hands it here. */
    active: string;
  }

  let { tabs, label, active }: Props = $props();

  const hrefOf = (id: string) => (id === 'overview' ? page.url.pathname : `?tab=${id}`);
</script>

<!-- `data-section-bar` is what tells the tables under it how far down to stick
     (app.css: --sticky-top) -->
<nav class="bar" aria-label={label} data-section-bar use:stuck>
  <div class="tabs">
    {#each tabs as tab (tab.id)}
      {@const on = active === tab.id}
      {@const Icon = tab.icon}
      <a
        href={hrefOf(tab.id)}
        class="tab"
        class:on
        aria-current={on ? 'page' : undefined}
        data-testid={`deck-tab-${tab.id}`}
      >
        <Icon class="h-4 w-4 shrink-0" aria-hidden="true" />
        {tab.label}
        {#if tab.count}<span class="count">{tab.count}</span>{/if}
      </a>
    {/each}
  </div>
</nav>

<style>
  .bar {
    position: sticky;
    /* flush against the top of the scroll container, over its top padding (app.css) */
    top: calc(0px - var(--main-pad-top, 0px));
    z-index: 30;
    display: flex;
    align-items: stretch;
    justify-content: space-between;
    gap: 16px;
    height: var(--section-bar-h);
    margin-bottom: 14px;
    padding: 0 2px;
    box-shadow: inset 0 -1px 0 var(--hairline);
    transition: background-color var(--motion-duration) var(--motion-ease);
  }
  /* held at the top: the same ground, opaque */
  .bar:global([data-stuck]) {
    background: var(--page-ground);
  }
  @media (min-width: 768px) {
    .bar {
      margin-bottom: 18px;
    }
  }
  .tabs {
    display: flex;
    gap: 24px;
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .tab {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 14.5px;
    white-space: nowrap;
    color: var(--muted);
    transition: color var(--motion-duration) var(--motion-ease);
  }
  .tab:hover {
    color: var(--ink);
  }
  .tab::after {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 2px;
    border-radius: 2px 2px 0 0;
    background: var(--accent);
    transform: scaleX(0);
    transition: transform 220ms var(--motion-ease);
  }
  .on {
    color: var(--ink);
    font-weight: 550;
  }
  .on::after {
    transform: scaleX(1);
  }
  .count {
    font-size: 11px;
    color: var(--muted);
  }
</style>
