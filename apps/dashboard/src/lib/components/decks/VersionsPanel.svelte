<script lang="ts">
  import { createRawSnippet } from 'svelte';
  import { type ColumnDef } from '@tanstack/table-core';
  import { renderComponent } from '$lib/components/ui/data-table/index.js';
  import DataTable, { rowCount } from '$lib/components/shared/DataTable.svelte';
  import DataTableColumnHeader from '$lib/components/shared/DataTableColumnHeader.svelte';
  import TableSkeleton from '$lib/components/shared/TableSkeleton.svelte';
  import * as Card from '$lib/components/ui/card/index.js';
  import DeckSectionHeading from './DeckSectionHeading.svelte';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { appear, reveal } from '$lib/components/ui/reveal/index.js';
  import type { PagedList } from '$lib/stores/pagedList.svelte';
  import { formatBytes, formatDateTime } from '$lib/format';
  import { t } from '$lib/i18n';
  import type { PresentationVersion } from '@slideless/contract';

  interface Props {
    /** Page-owned list — shared with the pin selects of the other panels. */
    list: PagedList<PresentationVersion>;
    currentVersion: number;
    /** The version the sandboxed preview currently shows (page state). */
    previewedVersion: number | null;
    onPreview: (version: number) => void;
  }

  let { list, currentVersion, previewedVersion, onPreview }: Props = $props();

  // the toolbar's quiet line: how many versions, once they are all here
  const versionCount = $derived(
    list.nextCursor || !list.items.length ? undefined : rowCount('versions.countOne', 'versions.count')
  );

  const columns: ColumnDef<PresentationVersion, unknown>[] = $derived([
    {
      accessorKey: 'version',
      header: ({ column }) =>
        renderComponent(DataTableColumnHeader, { column, title: t('versions.colVersion') }),
      cell: ({ row }) =>
        row.original.version === currentVersion
          ? `v${row.original.version} · ${t('versions.badgeCurrent')}`
          : `v${row.original.version}`,
      meta: { title: t('versions.colVersion'), width: '140px' }
    },
    {
      accessorKey: 'sizeBytes',
      header: ({ column }) =>
        renderComponent(DataTableColumnHeader, { column, title: t('versions.colSize') }),
      cell: ({ row }) => formatBytes(row.original.sizeBytes),
      meta: { title: t('versions.colSize'), width: '100px' }
    },
    {
      accessorKey: 'fileCount',
      header: ({ column }) =>
        renderComponent(DataTableColumnHeader, { column, title: t('versions.colFiles') }),
      cell: ({ row }) => String(row.original.fileCount),
      meta: { title: t('versions.colFiles'), width: '80px' }
    },
    {
      accessorKey: 'createdByRole',
      header: ({ column }) =>
        renderComponent(DataTableColumnHeader, { column, title: t('versions.colPushedBy') }),
      cell: ({ row }) =>
        row.original.createdByRole === 'owner' ? t('versions.roleOwner') : t('versions.roleDev'),
      meta: { title: t('versions.colPushedBy'), width: '130px' }
    },
    {
      accessorKey: 'createdAt',
      header: ({ column }) =>
        renderComponent(DataTableColumnHeader, { column, title: t('versions.colPushed') }),
      cell: ({ row }) => formatDateTime(row.original.createdAt),
      meta: { title: t('versions.colPushed'), width: '160px' }
    },
    {
      id: 'actions',
      cell: ({ row }) => {
        const version = row.original.version;
        if (version === previewedVersion) {
          return renderComponent(Badge, {
            variant: 'secondary' as const,
            // Static i18n text only — never user data inside createRawSnippet.
            children: createRawSnippet(() => ({
              render: () => `<span>${t('versions.badgePreviewing')}</span>`
            }))
          });
        }
        return renderComponent(Button, {
          variant: 'outline' as const,
          size: 'sm' as const,
          onclick: () => onPreview(version),
          // Static i18n text only — never user data inside createRawSnippet.
          children: createRawSnippet(() => ({
            render: () => `<span>${t('versions.actionPreview')}</span>`
          }))
        });
      },
      meta: { width: '120px' }
    }
  ]);
</script>

<Card.Root class="deck-section gap-3">
  <DeckSectionHeading
    drawing="versions"
    title={t('versions.title')}
    description={t('versions.description')}
  />
  <Card.Content>
    {#if list.loading}
      <TableSkeleton columns={5} rows={2} />
    {:else if list.error && !list.items.length}
      <p class="text-sm text-destructive" in:appear>{t('versions.loadFailed', { error: list.error })}</p>
    {:else}
      <DataTable
        data={list.items}
        {columns}
        count={versionCount}
        emptyMessage={t('versions.empty')}
        showViewOptions={false}
        showPagination={false}
        pageSize={200}
        sticky={false}
      />
      {#if list.nextCursor}
        <div class="flex justify-center py-2" transition:reveal>
          <Button
            variant="outline"
            size="sm"
            onclick={() => void list.loadMore()}
            disabled={list.loadingMore}
          >
            {list.loadingMore ? t('common.loading') : t('common.loadMore')}
          </Button>
        </div>
      {/if}
    {/if}
  </Card.Content>
</Card.Root>
