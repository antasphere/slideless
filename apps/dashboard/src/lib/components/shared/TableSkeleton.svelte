<script lang="ts">
  /* The table's shape while its rows load, for a load that is actually slow.
     Most are not: the rows are there within a frame or two, and a skeleton
     shown for that long is a flash of grey bars between two pages, the very
     jolt it exists to spare. So it waits: nothing for the first moment (the
     rows usually arrive inside it and take the place directly), and only a
     load that outlasts the wait gets the skeleton, faded in. */
  import { fade } from 'svelte/transition';
  import { Skeleton } from '$lib/components/ui/skeleton/index.js';
  import * as Table from '$lib/components/ui/table/index.js';

  interface Props {
    columns?: number;
    rows?: number;
    showSearch?: boolean;
  }

  let { columns = 5, rows = 8, showSearch = true }: Props = $props();

  const WAIT = 300;
  let shown = $state(false);
  $effect(() => {
    const timer = setTimeout(() => (shown = true), WAIT);
    return () => clearTimeout(timer);
  });
</script>

{#if shown}
  <!-- the same shape the table will have: the toolbar floating over the card -->
  <div class="table-card" in:fade={{ duration: 180 }}>
    {#if showSearch}
      <div class="table-toolbar">
        <Skeleton class="h-8 w-[250px] max-w-[60%]" />
        <Skeleton class="h-8 w-[84px]" />
      </div>
    {/if}

    <div class="sheet overflow-clip">
      <Table.Root scroll={false}>
        <Table.Header>
          <Table.Row>
            {#each Array(columns) as _, colIdx (colIdx)}
              <Table.Head>
                <Skeleton class="h-4 w-20" />
              </Table.Head>
            {/each}
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {#each Array(rows) as _, rowIdx (rowIdx)}
            <Table.Row>
              {#each Array(columns) as _, colIdx (colIdx)}
                <Table.Cell class="py-3.5">
                  <Skeleton class="h-5 {colIdx === 0 ? 'w-[180px]' : 'w-[120px]'}" />
                </Table.Cell>
              {/each}
            </Table.Row>
          {/each}
        </Table.Body>
      </Table.Root>
    </div>
  </div>
{/if}
