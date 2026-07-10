<script lang="ts">
  import { Skeleton } from '$lib/components/ui/skeleton/index.js';
  import * as Table from '$lib/components/ui/table/index.js';

  interface Props {
    columns?: number;
    rows?: number;
    showSearch?: boolean;
  }

  let { columns = 5, rows = 8, showSearch = true }: Props = $props();
</script>

{#if showSearch}
  <div class="flex items-center justify-between py-4">
    <Skeleton class="h-8 w-[250px]" />
    <Skeleton class="h-8 w-[100px]" />
  </div>
{/if}

<div class="rounded-md border">
  <Table.Root>
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
