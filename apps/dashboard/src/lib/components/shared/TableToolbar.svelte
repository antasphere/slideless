<script lang="ts">
  /* The one row over every table (and over the decks grid): at the left the
     search field, a quiet count right beside it and any filters the page
     has; at the right the View button and then the page's primary action,
     side by side against the table's right edge. DataTable renders it over
     its own card; a page whose rows are cards renders it itself, so the two
     read as one thing. On a phone the search takes the whole first line and
     the count and the actions share the second. It floats over the card as a
     plain row (app.css `.table-toolbar`) and, in the page's own scroll, stays
     at the top while the rows pass under it. */
  import type { Snippet } from 'svelte';
  import { Input } from '$lib/components/ui/input/index.js';
  import { stuck } from './stuck';

  interface Props {
    /** The search field shows when a placeholder is given. */
    searchPlaceholder?: string;
    searchValue?: string;
    /** The quiet line beside the search: how many rows, or how many of how many. */
    count?: string;
    /** Filters, after the count. */
    filters?: Snippet;
    /** The View button (which columns, or cards or table). */
    view?: Snippet;
    /** The page's primary action, last at the right. */
    actions?: Snippet;
    /** Stays at the top of the page's scroll while the rows pass under it. */
    sticky?: boolean;
    /** Measured: the column header under it sticks this far down. */
    height?: number;
    /** Set on the row itself, so a host can find it. */
    testid?: string;
  }

  let {
    searchPlaceholder,
    searchValue = $bindable(''),
    count,
    filters,
    view,
    actions,
    sticky = true,
    height = $bindable(0),
    testid
  }: Props = $props();
</script>

<div class="table-toolbar" class:is-sticky={sticky} bind:offsetHeight={height} use:stuck data-testid={testid}>
  {#if searchPlaceholder}
    <Input
      type="search"
      placeholder={searchPlaceholder}
      value={searchValue}
      oninput={(e) => {
        searchValue = e.currentTarget.value;
      }}
      class="toolbar-search h-10 md:h-8 md:w-[200px] lg:w-[260px]"
    />
  {/if}
  {#if count}
    <p class="toolbar-count">{count}</p>
  {/if}
  {@render filters?.()}
  {#if view || actions}
    <div class="toolbar-acts">
      {@render view?.()}
      {@render actions?.()}
    </div>
  {/if}
</div>
