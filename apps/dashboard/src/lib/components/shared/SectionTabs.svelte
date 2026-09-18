<script lang="ts">
  /* The bar under a section's hero (SectionHero), where sibling pages read as
     one section (people and their invitations; the instance and the
     account): their tabs, and nothing else. At rest it is part of the page:
     the page's ground, no box, one hairline under it. When the page scrolls
     it stays at the top of the scroll container, in that same ground made
     opaque, so nothing reads through. Each tab is a link, so the back button,
     a reload and a shared URL all land on the right tab. */
  import { page } from '$app/state';
  import { stuck } from './stuck';

  interface Tab {
    href: string;
    label: string;
    count?: number;
  }
  interface Props {
    tabs: Tab[];
    label: string;
  }

  let { tabs, label }: Props = $props();
</script>

<!-- `data-section-bar` is what tells the tables under it how far down to stick
     (app.css: --sticky-top) -->
<nav class="bar" aria-label={label} data-section-bar use:stuck>
  <div class="tabs">
    {#each tabs as tab (tab.href)}
      {@const on = page.url.pathname === tab.href}
      <a href={tab.href} class="tab" class:on aria-current={on ? 'page' : undefined}>
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
