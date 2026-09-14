<script lang="ts" generics="TData">
  import type { Snippet } from 'svelte';
  import {
    type ColumnDef,
    type TableOptions,
    type SortingState,
    type VisibilityState,
    type RowSelectionState,
    getCoreRowModel,
    getSortedRowModel
  } from '@tanstack/table-core';
  import { createSvelteTable, FlexRender } from '$lib/components/ui/data-table/index.js';
  import * as Table from '$lib/components/ui/table/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import DataTableViewOptions from './DataTableViewOptions.svelte';
  import DataTablePagination from './DataTablePagination.svelte';
  import { t } from '$lib/i18n';

  interface Props {
    data: TData[];
    columns: ColumnDef<TData, unknown>[];
    pageSize?: number;
    pageSizeOptions?: number[];
    showViewOptions?: boolean;
    showPagination?: boolean;
    searchPlaceholder?: string;
    searchColumns?: string[];
    initialSearch?: string;
    toolbar?: Snippet;
    toolbarActions?: Snippet;
    onRowClick?: (row: TData) => void;
    initialColumnVisibility?: VisibilityState;
    enableRowSelection?: boolean;
    rowSelection?: RowSelectionState;
    getRowId?: (row: TData) => string;
    /** Extra classes on the table element (a min width so no column is ever cut; the wrapper scrolls). */
    tableClass?: string;
  }

  let {
    data,
    columns,
    pageSize = 20,
    pageSizeOptions = [10, 20, 30, 50],
    showViewOptions = true,
    showPagination = true,
    searchPlaceholder = t('table.searchPlaceholder'),
    searchColumns,
    initialSearch = '',
    toolbar,
    toolbarActions,
    onRowClick,
    initialColumnVisibility = {},
    enableRowSelection = false,
    rowSelection = $bindable({}),
    getRowId,
    tableClass
  }: Props = $props();

  let sorting = $state<SortingState>([]);
  let columnVisibility = $state<VisibilityState>(initialColumnVisibility);
  let pageIndex = $state(0);
  // Writable derived: follows the prop, locally overridable by pagination.
  let currentPageSize = $derived(pageSize);
  let searchValue = $state(initialSearch);
  let renderKey = $state(0);

  const table = createSvelteTable<TData>({
    get data() {
      return data;
    },
    get columns() {
      return columns;
    },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    get enableRowSelection() {
      return enableRowSelection;
    },
    get getRowId() {
      return getRowId;
    },
    onSortingChange: (updater) => {
      if (updater instanceof Function) {
        sorting = updater(sorting);
      } else {
        sorting = updater;
      }
    },
    onColumnVisibilityChange: (updater) => {
      if (updater instanceof Function) {
        columnVisibility = updater(columnVisibility);
      } else {
        columnVisibility = updater;
      }
      renderKey++;
    },
    onRowSelectionChange: (updater) => {
      if (updater instanceof Function) {
        rowSelection = updater(rowSelection);
      } else {
        rowSelection = updater;
      }
      renderKey++;
    },
    get state() {
      return {
        sorting,
        columnVisibility,
        rowSelection
      };
    }
  } as TableOptions<TData>);

  // Manual filtering + pagination on sorted rows
  const allRows = $derived(table.getRowModel().rows);
  const filteredRows = $derived.by(() => {
    if (!searchValue || !searchColumns?.length) return allRows;
    const lower = searchValue.toLowerCase();
    return allRows.filter((row) =>
      searchColumns.some((colId) => {
        const value = row.getValue(colId);
        return value != null && String(value).toLowerCase().includes(lower);
      })
    );
  });
  const totalRows = $derived(filteredRows.length);
  const pageCount = $derived(Math.max(1, Math.ceil(totalRows / currentPageSize)));
  const paginatedRows = $derived(
    filteredRows.slice(pageIndex * currentPageSize, (pageIndex + 1) * currentPageSize)
  );
  const selectedRowCount = $derived(
    enableRowSelection ? Object.keys(rowSelection).filter((k) => rowSelection[k]).length : 0
  );

  // Reset page when data or search changes
  $effect(() => {
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions -- dependency touch
    [data, searchValue];
    pageIndex = 0;
  });
</script>

{#if toolbar || searchColumns?.length || toolbarActions || showViewOptions}
  <div class="flex items-center justify-between py-4">
    <div class="flex flex-1 items-center space-x-2">
      {#if searchColumns?.length}
        <Input
          placeholder={searchPlaceholder}
          value={searchValue}
          oninput={(e) => {
            searchValue = e.currentTarget.value;
          }}
          class="h-8 w-[150px] lg:w-[250px]"
        />
      {/if}
      {#if toolbar}
        {@render toolbar()}
      {/if}
      {#if toolbarActions}
        {@render toolbarActions()}
      {/if}
    </div>
    {#if showViewOptions}
      <DataTableViewOptions {table} />
    {/if}
  </div>
{/if}

<div class="rounded-md border">
  <Table.Root class={['table-fixed', tableClass].filter(Boolean).join(' ')}>
    <Table.Header>
      {#key renderKey}
        {#each table.getHeaderGroups() as headerGroup (headerGroup.id)}
          <Table.Row>
            {#each headerGroup.headers as header (header.id)}
              <Table.Head
                style={[
                  header.column.columnDef.meta?.width ? `width: ${header.column.columnDef.meta.width}` : '',
                  header.column.columnDef.meta?.minWidth
                    ? `min-width: ${header.column.columnDef.meta.minWidth}`
                    : ''
                ]
                  .filter(Boolean)
                  .join('; ') || undefined}
                class={header.column.columnDef.meta?.align === 'center'
                  ? '[&_div]:justify-center [&_button]:!ml-0'
                  : undefined}
              >
                {#if !header.isPlaceholder}
                  <FlexRender content={header.column.columnDef.header} context={header.getContext()} />
                {/if}
              </Table.Head>
            {/each}
          </Table.Row>
        {/each}
      {/key}
    </Table.Header>
    <Table.Body>
      {#key renderKey}
        {#each paginatedRows as row (row.id)}
          <Table.Row
            class={onRowClick ? 'cursor-pointer' : ''}
            data-state={row.getIsSelected() ? 'selected' : undefined}
            onclick={(e: MouseEvent) => {
              if (
                onRowClick &&
                !(e.target as HTMLElement).closest('[data-actions-cell]') &&
                !(e.target as HTMLElement).closest('[data-slot="checkbox"]')
              ) {
                onRowClick(row.original);
              }
            }}
          >
            {#each row.getVisibleCells() as cell (cell.id)}
              <Table.Cell
                data-actions-cell={cell.column.id === 'actions' ? '' : undefined}
                class={cell.column.columnDef.meta?.align === 'center' ? 'text-center' : undefined}
              >
                <FlexRender content={cell.column.columnDef.cell} context={cell.getContext()} />
              </Table.Cell>
            {/each}
          </Table.Row>
        {:else}
          <Table.Row>
            <Table.Cell
              colspan={table.getVisibleLeafColumns().length}
              class="h-24 text-center text-muted-foreground"
            >
              {t('table.noResults')}
            </Table.Cell>
          </Table.Row>
        {/each}
      {/key}
    </Table.Body>
  </Table.Root>
</div>

{#if showPagination}
  <DataTablePagination
    bind:pageIndex
    bind:pageSize={currentPageSize}
    {pageCount}
    {totalRows}
    {pageSizeOptions}
    selectedRows={enableRowSelection ? selectedRowCount : undefined}
  />
{/if}
