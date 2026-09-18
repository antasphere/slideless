<script lang="ts">
  /* Tabs that are routes: two or three sibling pages read as one section
     (people and their invitations; the settings and the account). Each tab is
     a link, so the back button, a reload and a shared URL all land right. */
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

<nav class="tabs" aria-label={label}>
  {#each tabs as tab (tab.href)}
    {@const on = page.url.pathname === tab.href}
    <a href={tab.href} class="tab" class:on aria-current={on ? 'page' : undefined}>
      {tab.label}
      {#if tab.count}<span class="count">{tab.count}</span>{/if}
    </a>
  {/each}
</nav>

<style>
  .tabs {
    display: inline-flex;
    gap: 2px;
    max-width: 100%;
    overflow-x: auto;
    padding: 3px;
    margin-bottom: 28px;
    border: 1px solid var(--hairline);
    border-radius: var(--r-btn);
    background: var(--ground-2);
    scrollbar-width: none;
  }
  .tab {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: var(--control-h-sm);
    padding: 0 14px;
    border-radius: calc(var(--r-btn) - 3px);
    font-size: 13.5px;
    white-space: nowrap;
    color: var(--muted);
    transition:
      color var(--motion-duration) var(--motion-ease),
      background-color var(--motion-duration) var(--motion-ease);
  }
  .tab:hover {
    color: var(--ink);
  }
  .on {
    background: var(--ground);
    color: var(--ink);
    font-weight: 500;
    box-shadow: var(--shadow-sm);
  }
  .count {
    font-size: 11px;
    color: var(--muted);
  }
</style>
