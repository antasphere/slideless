<script lang="ts">
  /* The bar under a section's hero (SectionHero), where sibling pages read as
     one section (people and their invitations; the instance and the
     account): their tabs, and nothing else. At rest it is part of the page:
     the page's ground, no box, one hairline under it. When the page scrolls
     it stays at the top of the scroll container, in that same ground made
     opaque, so nothing reads through. Each tab is a link, so the back button,
     a reload and a shared URL all land on the right tab. On a narrow screen
     the row scrolls sideways, and the lit tab is brought into view. */
  import { page } from '$app/state';
  import { stuck } from './stuck';

  interface Tab {
    href: string;
    label: string;
    count?: number;
    /**
     * Lights the tab on a page under it (a team's own page lights Teams); the exact path lights it
     * otherwise. `false` keeps it dark on its own path: tabs that live in the query (the hub's
     * billing tabs) would otherwise all light their shared path.
     */
    on?: boolean;
    /** Sits apart at the bar's right end (Settings' own tab among the pages it gathers). */
    end?: boolean;
  }
  interface Props {
    tabs: Tab[];
    label: string;
  }

  let { tabs, label }: Props = $props();

  let row: HTMLDivElement | undefined = $state();

  // the lit tab in view when the row is wider than the screen (a phone on
  // My account or Demo links): scroll the row, never the page
  $effect(() => {
    void page.url.pathname;
    void tabs;
    const box = row;
    const lit = box?.querySelector<HTMLElement>('.on');
    if (!box || !lit) return;
    const outer = box.getBoundingClientRect();
    const inner = lit.getBoundingClientRect();
    if (inner.left < outer.left) box.scrollLeft += inner.left - outer.left - 16;
    else if (inner.right > outer.right) box.scrollLeft += inner.right - outer.right + 16;
  });
</script>

<!-- `data-section-bar` is what tells the tables under it how far down to stick
     (app.css: --sticky-top) -->
<nav class="bar" aria-label={label} data-section-bar use:stuck>
  <div class="tabs" bind:this={row}>
    {#each tabs as tab (tab.href)}
      {@const on = tab.on ?? page.url.pathname === tab.href}
      <a href={tab.href} class="tab" class:on class:end={tab.end} aria-current={on ? 'page' : undefined}>
        {tab.label}
        {#if tab.count}<span class="count">{tab.count}</span>{/if}
      </a>
    {/each}
  </div>
</nav>

<style>
  .tab.end {
    margin-left: auto;
  }
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
    flex: 1;
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
