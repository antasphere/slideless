<script lang="ts" module>
  import { t, type MessageKey } from '$lib/i18n';

  /**
   * The quiet count beside a table's search, from a page's own two keys
   * (`'1 key'`, `'{n} keys'`): the total while nothing filters, `shown of
   * total` while a search does.
   */
  export function rowCount(one: MessageKey, many: MessageKey): (shown: number, total: number) => string {
    return (shown, total) =>
      shown !== total ? t('table.countOf', { shown, total }) : total === 1 ? t(one) : t(many, { n: total });
  }
</script>

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
  import TableToolbar from './TableToolbar.svelte';
  import DataTableViewOptions from './DataTableViewOptions.svelte';
  import DataTablePagination from './DataTablePagination.svelte';

  import { IsMobile } from '$lib/hooks/is-mobile.svelte';
  import { stuck } from './stuck';

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
    /** The quiet line beside the search (see `rowCount`), from how many rows show out of how many. */
    count?: (shown: number, total: number) => string;
    /** Filters, at the left after the search and the count. */
    toolbar?: Snippet;
    /** The page's primary action, at the right after View. */
    actions?: Snippet;
    /** What the one quiet row says when there is nothing to list. */
    emptyMessage?: string;
    onRowClick?: (row: TData) => void;
    /** Which columns show; a host that renders its own View button binds it. */
    columnVisibility?: VisibilityState;
    enableRowSelection?: boolean;
    rowSelection?: RowSelectionState;
    getRowId?: (row: TData) => string;
    /** Extra classes on the table element (a min width so no column is ever cut; the wrapper scrolls). */
    tableClass?: string;
    /** The toolbar and the column header stay in place while the page scrolls under them. */
    sticky?: boolean;
    /** The height of a toolbar the page holds itself above this table (TableToolbar): the header sticks under it. */
    stickyOffset?: number;
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
    count,
    toolbar,
    actions,
    emptyMessage = t('table.noResults'),
    onRowClick,
    columnVisibility = $bindable({}),
    enableRowSelection = false,
    rowSelection = $bindable({}),
    getRowId,
    tableClass,
    sticky = true,
    stickyOffset = 0
  }: Props = $props();

  let sorting = $state<SortingState>([]);
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

  // On a phone a table is a list of cards (PRDCT-2436): the first column is
  // the card's title, the actions sit beside it, and every other visible
  // column is a labelled line under it. Same rows, same cells, same renderers:
  // nothing a desk shows is lost, and nothing scrolls sideways.
  const phone = new IsMobile();
  const isLead = (id: string) => id !== 'select' && id !== 'actions';

  // The toolbar floats over the table's card and stays at the top of the
  // page's scroll while the rows pass under it; the column header stays
  // right under the toolbar, so it has to know how tall the toolbar is (or
  // how tall the page's own toolbar above is, `stickyOffset`). A table with
  // a min width scrolls sideways inside its wrapper, and a scrolling wrapper
  // cannot let its header stick to the page: that one keeps a header that
  // travels with it.
  const showView = $derived(showViewOptions && !phone.current);
  const hasToolbar = $derived(!!toolbar || !!searchColumns?.length || !!count || !!actions || showView);
  const stickyHead = $derived(sticky && !tableClass);
  let toolbarHeight = $state(0);
  const headOffset = $derived(hasToolbar && sticky ? toolbarHeight : stickyOffset);
  const countLine = $derived(count?.(filteredRows.length, allRows.length));

  // Reset page when data or search changes
  $effect(() => {
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions -- dependency touch
    [data, searchValue];
    pageIndex = 0;
  });
</script>

{#snippet viewButton()}
  <DataTableViewOptions {table} />
{/snippet}

<div class="table-card" style="--toolbar-h: {headOffset}px">
  {#if hasToolbar}
    <TableToolbar
      searchPlaceholder={searchColumns?.length ? searchPlaceholder : undefined}
      bind:searchValue
      count={countLine}
      filters={toolbar}
      view={showView ? viewButton : undefined}
      {actions}
      {sticky}
      bind:height={toolbarHeight}
    />
  {/if}

  {#if phone.current}
    {#key renderKey}
      <ul class="sheet divide-y divide-[var(--hairline)] overflow-hidden">
        {#each paginatedRows as row (row.id)}
          {@const cells = row.getVisibleCells()}
          {@const lead = cells.find((c) => isLead(c.column.id))}
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
          <li
            class="px-4 py-3.5 {onRowClick ? 'cursor-pointer active:bg-[var(--ground-3)]' : ''}"
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
            <div class="flex items-start gap-3">
              {#each cells.filter((c) => c.column.id === 'select') as cell (cell.id)}
                <span class="pt-0.5"
                  ><FlexRender content={cell.column.columnDef.cell} context={cell.getContext()} /></span
                >
              {/each}
              <div class="min-w-0 flex-1 break-words text-[15px] font-medium">
                {#if lead}
                  <FlexRender content={lead.column.columnDef.cell} context={lead.getContext()} />
                {/if}
              </div>
              {#each cells.filter((c) => c.column.id === 'actions') as cell (cell.id)}
                <span data-actions-cell="" class="-mr-2 -mt-1 shrink-0"
                  ><FlexRender content={cell.column.columnDef.cell} context={cell.getContext()} /></span
                >
              {/each}
            </div>
            <dl class="mt-2 grid grid-cols-[minmax(84px,auto)_1fr] gap-x-4 gap-y-1.5 text-[13.5px]">
              {#each cells.filter((c) => isLead(c.column.id) && c !== lead) as cell (cell.id)}
                <dt class="text-muted-foreground">{cell.column.columnDef.meta?.title ?? ''}</dt>
                <dd class="min-w-0 break-words">
                  <FlexRender content={cell.column.columnDef.cell} context={cell.getContext()} />
                </dd>
              {/each}
            </dl>
          </li>
        {:else}
          <li class="px-4 py-10 text-center text-sm text-muted-foreground">{emptyMessage}</li>
        {/each}
      </ul>
    {/key}
  {:else}
    {#if stickyHead}
      <!-- redraws the card's rounded top over the header while it is held (app.css) -->
      <div class="table-cap" aria-hidden="true" use:stuck></div>
    {/if}
    <!-- clip, not hidden: the corners are still cut, and no scroll container
         stands between the header and the page, so the header can stick -->
    <div class="sheet overflow-clip">
      <Table.Root
        scroll={!stickyHead}
        class={['table-fixed', stickyHead && 'table-sticky', tableClass].filter(Boolean).join(' ')}
      >
        <Table.Header>
          {#key renderKey}
            {#each table.getHeaderGroups() as headerGroup (headerGroup.id)}
              <Table.Row>
                {#each headerGroup.headers as header (header.id)}
                  <Table.Head
                    style={[
                      header.column.columnDef.meta?.width
                        ? `width: ${header.column.columnDef.meta.width}`
                        : '',
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
                  class="h-24 text-center !font-normal !text-muted-foreground"
                >
                  {emptyMessage}
                </Table.Cell>
              </Table.Row>
            {/each}
          {/key}
        </Table.Body>
      </Table.Root>
    </div>
  {/if}
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
