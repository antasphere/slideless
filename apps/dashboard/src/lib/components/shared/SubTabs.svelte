<script lang="ts">
  /* A section's second level, under the SectionHero's tab bar: when a tab of the bar is itself
     several pages (Settings → People: the members, the teams, the invitations), those pages read
     as a small segmented control at the head of the content, so the bar above stays the section's
     and the reader never loses it (2026-10-01). Each segment is a link. */
  import { page } from '$app/state';

  interface Tab {
    href: string;
    label: string;
    on?: boolean;
  }
  let { tabs, label }: { tabs: Tab[]; label: string } = $props();
</script>

{#if tabs.length > 1}
  <nav class="sub" aria-label={label}>
    {#each tabs as tab (tab.href)}
      {@const on = tab.on || page.url.pathname === tab.href}
      <a href={tab.href} class="seg" class:on aria-current={on ? 'page' : undefined}>{tab.label}</a>
    {/each}
  </nav>
{/if}

<style>
  .sub {
    display: inline-flex;
    flex-wrap: nowrap;
    gap: 2px;
    margin: 4px 0 14px;
    padding: 3px;
    border: 1px solid var(--hairline);
    border-radius: 999px;
    background: var(--plate);
  }
  .seg {
    padding: 4px 12px;
    border-radius: 999px;
    font-size: 13px;
    color: var(--muted);
    text-decoration: none;
    white-space: nowrap;
    transition:
      color var(--motion-duration) var(--motion-ease),
      background-color var(--motion-duration) var(--motion-ease);
  }
  .seg:hover {
    color: var(--ink);
  }
  .seg.on {
    background: var(--plate-strong);
    color: var(--ink);
    box-shadow: var(--shadow-sm);
  }
</style>
