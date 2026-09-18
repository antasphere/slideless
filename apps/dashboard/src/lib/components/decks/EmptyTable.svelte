<script lang="ts" module>
  export interface EmptyColumn {
    title: string;
    width?: string;
    align?: 'center';
  }
</script>

<script lang="ts">
  /* A deck section with nothing in it yet keeps its skeleton: a table with
     its column heads, and ONE quiet row that says so, in place of a sentence
     floating where the table will be. A DataTable draws its own empty row
     (`emptyMessage`); this is for a section whose content is a list, not a
     DataTable: the frame alone, or the heads of a hand-built table over it.
     On a phone a table is a list of cards with no heads, so the frame and
     the sentence are all there is to keep. The sentence is static i18n text. */
  import * as Table from '$lib/components/ui/table/index.js';
  import { IsMobile } from '$lib/hooks/is-mobile.svelte';

  interface Props {
    message: string;
    columns?: EmptyColumn[];
    /** The table's min width when its columns carry widths (the wrapper scrolls). */
    minWidth?: number;
  }

  let { message, columns = [], minWidth }: Props = $props();

  const phone = new IsMobile();
</script>

{#if phone.current || !columns.length}
  <div class="sheet empty-frame">
    <p class="empty-words">{message}</p>
  </div>
{:else}
  <div class="sheet empty-host overflow-clip">
    <Table.Root class="table-fixed" style={minWidth ? `min-width: ${minWidth}px` : undefined}>
      <Table.Header>
        <Table.Row>
          {#each columns as column, i (i)}
            <Table.Head
              style={column.width ? `width: ${column.width}` : undefined}
              class={column.align === 'center' ? 'text-center' : undefined}
            >
              {column.title}
            </Table.Head>
          {/each}
        </Table.Row>
      </Table.Header>
      <Table.Body>
        <Table.Row class="hover:!bg-transparent hover:[&>td:first-child]:!shadow-none">
          <Table.Cell colspan={columns.length} class="!p-0">
            <!-- held at the left of a table wider than its host, so the
                 sentence stays in view while the heads scroll -->
            <div class="empty-row"><p class="empty-words">{message}</p></div>
          </Table.Cell>
        </Table.Row>
      </Table.Body>
    </Table.Root>
  </div>
{/if}

<style>
  .empty-frame,
  .empty-row {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 88px;
    padding: 16px 20px;
  }
  .empty-host {
    container-type: inline-size;
  }
  .empty-row {
    position: sticky;
    left: 0;
    width: min(100%, 100cqw);
  }
  .empty-words {
    max-width: 56ch;
    font-size: 14px;
    font-weight: var(--ui-weight);
    line-height: 1.5;
    text-align: center;
    text-wrap: balance;
    color: var(--muted);
  }
</style>
