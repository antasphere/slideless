<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import * as Select from '$lib/components/ui/select/index.js';
  import ChevronLeft from '@lucide/svelte/icons/chevron-left';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import ChevronsLeft from '@lucide/svelte/icons/chevrons-left';
  import ChevronsRight from '@lucide/svelte/icons/chevrons-right';
  import { t } from '$lib/i18n';

  interface Props {
    pageIndex: number;
    pageCount: number;
    totalRows: number;
    pageSize: number;
    pageSizeOptions?: number[];
    selectedRows?: number;
  }

  let {
    pageIndex = $bindable(),
    pageSize = $bindable(),
    pageCount,
    totalRows,
    pageSizeOptions = [10, 20, 30, 50],
    selectedRows
  }: Props = $props();

  const canPrev = $derived(pageIndex > 0);
  const canNext = $derived(pageIndex < pageCount - 1);

  function goFirst() {
    pageIndex = 0;
  }

  function goPrev() {
    if (canPrev) pageIndex--;
  }

  function goNext() {
    if (canNext) pageIndex++;
  }

  function goLast() {
    pageIndex = pageCount - 1;
  }

  function handlePageSizeChange(value: string | undefined) {
    if (value) {
      pageSize = Number(value);
      pageIndex = 0;
    }
  }
</script>

<div class="flex items-center justify-between px-2 py-4">
  <div class="flex-1 text-sm text-muted-foreground">
    {#if selectedRows != null && selectedRows > 0}
      {t('table.rowsSelected', { selected: selectedRows, total: totalRows })}
    {:else}
      {t('table.rowCount', { total: totalRows })}
    {/if}
  </div>
  <div class="flex items-center space-x-6 lg:space-x-8">
    <div class="flex items-center space-x-2">
      <p class="text-sm font-medium">{t('table.rowsPerPage')}</p>
      <Select.Root type="single" value={String(pageSize)} onValueChange={handlePageSizeChange}>
        <Select.Trigger class="h-8 w-[70px]">
          {pageSize}
        </Select.Trigger>
        <Select.Content>
          {#each pageSizeOptions as size (size)}
            <Select.Item value={String(size)} label={String(size)} />
          {/each}
        </Select.Content>
      </Select.Root>
    </div>
    <div class="flex w-[100px] items-center justify-center text-sm font-medium">
      {t('table.pageOf', { page: pageIndex + 1, count: pageCount })}
    </div>
    <div class="flex items-center space-x-2">
      <Button
        variant="outline"
        size="icon"
        class="hidden h-8 w-8 lg:flex"
        onclick={goFirst}
        disabled={!canPrev}
      >
        <ChevronsLeft class="h-4 w-4" />
        <span class="sr-only">{t('table.firstPage')}</span>
      </Button>
      <Button variant="outline" size="icon" class="h-8 w-8" onclick={goPrev} disabled={!canPrev}>
        <ChevronLeft class="h-4 w-4" />
        <span class="sr-only">{t('table.previousPage')}</span>
      </Button>
      <Button variant="outline" size="icon" class="h-8 w-8" onclick={goNext} disabled={!canNext}>
        <ChevronRight class="h-4 w-4" />
        <span class="sr-only">{t('table.nextPage')}</span>
      </Button>
      <Button
        variant="outline"
        size="icon"
        class="hidden h-8 w-8 lg:flex"
        onclick={goLast}
        disabled={!canNext}
      >
        <ChevronsRight class="h-4 w-4" />
        <span class="sr-only">{t('table.lastPage')}</span>
      </Button>
    </div>
  </div>
</div>
