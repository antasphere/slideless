<script lang="ts">
  /* A section's tab bar: sibling pages read as one section (people and their
     invitations; the instance and the account). At rest it is the foot of the
     section's hero card (SectionHero): same edge, the card's bottom corners.
     When the page scrolls it stays at the top of the scroll container, and
     there it is a bar: square, opaque, a hairline under it, so nothing reads
     through. Each tab is a link, so the back button, a reload and a shared
     URL all land on the right tab. */
  import type { Snippet } from 'svelte';
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
    /** The page's one action, at the right end of the bar. */
    action?: Snippet;
  }

  let { tabs, label, action }: Props = $props();
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
  {#if action}<div class="action">{@render action()}</div>{/if}
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
    margin-bottom: 22px;
    padding: 0 8px 0 18px;
    background: var(--bar);
    border: 1px solid var(--hairline);
    border-radius: 0 0 var(--r-lg) var(--r-lg);
    box-shadow: var(--shadow-sm);
    transition:
      border-radius var(--motion-duration) var(--motion-ease),
      box-shadow var(--motion-duration) var(--motion-ease);
  }
  /* held at the top: a bar, not the foot of a card */
  .bar:global([data-stuck]) {
    border-radius: 0;
    border-top-color: transparent;
    box-shadow: none;
  }
  @media (min-width: 768px) {
    .bar {
      margin-bottom: 26px;
      padding: 0 12px 0 30px;
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
  .action {
    display: flex;
    flex: none;
    align-items: center;
  }
</style>
