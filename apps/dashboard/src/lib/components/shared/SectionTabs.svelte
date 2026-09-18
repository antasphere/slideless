<script lang="ts">
  /* A section's tab bar: sibling pages read as one section (people and their
     invitations; the instance and the account). It stays at the top of the
     page while the content scrolls under it, the way an app's tab bar does.
     Each tab is a link, so the back button, a reload and a shared URL all land
     on the right tab. */
  import { page } from '$app/state';

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

<nav class="bar" aria-label={label}>
  <span class="section">{label}</span>
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
  /* full bleed over the main column's padding, stuck to the top of its scroll */
  .bar {
    position: sticky;
    top: 0;
    z-index: 20;
    display: flex;
    align-items: stretch;
    gap: 22px;
    height: 48px;
    margin: -20px -16px 22px;
    padding: 0 16px;
    background: var(--bar);
    border-bottom: 1px solid var(--hairline);
  }
  @media (min-width: 768px) {
    .bar {
      margin: -8px -32px 26px;
      padding: 0 32px;
      background: color-mix(in oklab, var(--bar) 86%, transparent);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
    }
  }
  .section {
    display: none;
    align-items: center;
    font-family: var(--display);
    font-size: 15px;
    color: var(--muted);
    padding-right: 22px;
    border-right: 1px solid var(--hairline);
  }
  @media (min-width: 768px) {
    .section {
      display: flex;
    }
  }
  .tabs {
    display: flex;
    gap: 22px;
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
    bottom: -1px;
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
