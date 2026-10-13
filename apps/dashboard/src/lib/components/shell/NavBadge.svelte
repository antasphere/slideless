<script lang="ts">
  /* Something new in a section (NavItem.badge): a count pill or a dot, red
     when the tool says it is for the reader (an alert), at the item's right.
     The eye reads the mark; a screen reader hears the sentence. */
  import { badgeView, type NavBadge } from '$lib/nav-badge';

  interface Props {
    badge?: NavBadge;
    class?: string;
  }

  let { badge, class: className = '' }: Props = $props();
  const view = $derived(badgeView(badge));
</script>

{#if view}
  <span class="nav-badge {view.kind} {className}" class:alert={view.alert} data-testid="nav-badge">
    <span aria-hidden="true">{view.text}</span>
    <span class="sr-only">{view.label}</span>
  </span>
{/if}

<style>
  .nav-badge {
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    background: var(--ink-soft);
    color: var(--plate-strong, #fff);
    font-size: 11px;
    font-weight: 600;
    line-height: 1;
    font-variant-numeric: tabular-nums;
  }
  .nav-badge.alert {
    background: #d93a2b;
    color: #fff;
  }
  .count {
    min-width: 18px;
    height: 18px;
    padding: 0 5px;
    border-radius: 999px;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 999px;
  }
</style>
