<script lang="ts">
  /* The path beside the sidebar toggle: `Decks / Quarterly review`. It comes
     in once the page's own header has scrolled away and leaves when the
     header is back, so the top bar never says twice what the page is saying.
     A crumb with somewhere to go is a link; the last one is where you are. */
  import type { Crumb } from '$lib/crumbs.svelte';
  import { t } from '$lib/i18n';

  interface Props {
    items: Crumb[];
    shown: boolean;
  }

  let { items, shown }: Props = $props();
</script>

<nav class="path" class:shown aria-label={t('shell.pathAria')} inert={!shown} data-crumbs data-shown={shown}>
  <ol>
    {#each items as crumb, i (i)}
      {@const last = i === items.length - 1}
      <li class:last>
        {#if i > 0}<span class="slash" aria-hidden="true">/</span>{/if}
        <!-- SECURITY: a label may be user-authored (a deck's title): text interpolation only. -->
        {#if crumb.href && !last}
          <a href={crumb.href}>{crumb.label}</a>
        {:else}
          <span class="here" aria-current={last ? 'page' : undefined}>{crumb.label}</span>
        {/if}
      </li>
    {/each}
  </ol>
</nav>

<style>
  .path {
    min-width: 0;
    flex: 1;
    opacity: 0;
    transform: translateY(4px);
    visibility: hidden;
    transition:
      opacity 200ms var(--motion-ease),
      transform 200ms var(--motion-ease),
      visibility 0s linear 200ms;
  }
  .path.shown {
    opacity: 1;
    transform: none;
    visibility: visible;
    transition-delay: 0s;
  }
  ol {
    display: flex;
    align-items: center;
    min-width: 0;
    font-size: 13.5px;
    color: var(--muted);
  }
  li {
    display: flex;
    align-items: center;
    flex: none;
    min-width: 0;
  }
  li.last {
    flex: 0 1 auto;
  }
  .slash {
    margin: 0 9px;
    color: color-mix(in oklab, var(--muted) 55%, transparent);
  }
  a {
    border-radius: 4px;
    transition: color var(--motion-duration) var(--motion-ease);
  }
  a:hover {
    color: var(--ink);
  }
  .here {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .last .here {
    color: var(--ink);
  }
  @media (prefers-reduced-motion: reduce) {
    .path {
      transform: none;
    }
  }
</style>
