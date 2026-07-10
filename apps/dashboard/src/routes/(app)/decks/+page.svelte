<script lang="ts">
  import { goto } from '$app/navigation';
  import { type ColumnDef } from '@tanstack/table-core';
  import { renderComponent } from '$lib/components/ui/data-table/index.js';
  import PageHeader from '$lib/components/shared/PageHeader.svelte';
  import DataTable from '$lib/components/shared/DataTable.svelte';
  import DataTableColumnHeader from '$lib/components/shared/DataTableColumnHeader.svelte';
  import TableSkeleton from '$lib/components/shared/TableSkeleton.svelte';
  import PushInstructions from '$lib/components/decks/PushInstructions.svelte';
  import * as Card from '$lib/components/ui/card/index.js';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { createPagedList } from '$lib/stores/pagedList.svelte';
  import { api } from '$lib/api';
  import { kindLabel } from '$lib/decks';
  import { formatTimeAgo } from '$lib/format';
  import { t } from '$lib/i18n';
  import type { Presentation } from '@slideless/contract';

  const list = createPagedList<Presentation>(async (p) => {
    const { presentations, nextCursor } = await api.presentations(p);
    return { items: presentations, nextCursor };
  });

  $effect(() => {
    void list.load();
  });

  const decks = $derived(list.items);

  // "New deck" is instructions, not an upload form — decks arrive via push.
  let showPushDialog = $state(false);

  const columns: ColumnDef<Presentation, unknown>[] = $derived([
    {
      accessorKey: 'title',
      header: ({ column }) => renderComponent(DataTableColumnHeader, { column, title: t('decks.colTitle') }),
      // SECURITY: deck titles are USER-AUTHORED. Returning the plain string
      // renders through FlexRender's `{result}` text interpolation — always
      // escaped. Never wrap this value in createRawSnippet / {@html}.
      cell: ({ row }) => row.getValue('title'),
      meta: { title: t('decks.colTitle') }
    },
    {
      accessorKey: 'kind',
      header: ({ column }) => renderComponent(DataTableColumnHeader, { column, title: t('decks.colKind') }),
      cell: ({ row }) =>
        `${kindLabel(row.original.kind)}${row.original.interactive ? ` · ${t('decks.badgeInteractive')}` : ''}`,
      meta: { title: t('decks.colKind'), width: '160px' }
    },
    {
      accessorKey: 'currentVersion',
      header: ({ column }) =>
        renderComponent(DataTableColumnHeader, { column, title: t('decks.colVersion') }),
      cell: ({ row }) =>
        row.original.currentVersion > 0 ? `v${row.original.currentVersion}` : t('decks.noVersions'),
      meta: { title: t('decks.colVersion'), width: '110px' }
    },
    {
      accessorKey: 'totalViews',
      header: ({ column }) => renderComponent(DataTableColumnHeader, { column, title: t('decks.colViews') }),
      cell: ({ row }) => String(row.original.totalViews),
      meta: { title: t('decks.colViews'), width: '90px' }
    },
    {
      accessorKey: 'updatedAt',
      header: ({ column }) =>
        renderComponent(DataTableColumnHeader, { column, title: t('decks.colUpdated') }),
      cell: ({ row }) => formatTimeAgo(row.getValue('updatedAt') as string),
      meta: { title: t('decks.colUpdated'), width: '130px' }
    }
  ]);
</script>

<PageHeader
  title={t('decks.title')}
  description={t('decks.description')}
  onAdd={() => (showPushDialog = true)}
  addLabel={t('decks.newDeck')}
/>

{#if list.error && decks.length}
  <p class="text-sm text-destructive">{t('common.refreshFailedCached', { error: list.error })}</p>
{/if}
{#if list.loading}
  <TableSkeleton columns={5} />
{:else if list.error && !decks.length}
  <p class="text-sm text-destructive">{t('decks.loadFailed', { error: list.error })}</p>
{:else if !decks.length}
  <Card.Root class="mx-auto max-w-xl">
    <Card.Header>
      <Card.Title class="text-base">{t('decks.emptyTitle')}</Card.Title>
      <Card.Description>{t('decks.emptyBody')}</Card.Description>
    </Card.Header>
    <Card.Content>
      <PushInstructions />
    </Card.Content>
  </Card.Root>
{:else}
  <DataTable
    data={decks}
    {columns}
    searchColumns={['title']}
    searchPlaceholder={t('decks.searchPlaceholder')}
    onRowClick={(deck) => void goto(`/decks/${deck.id}`)}
  />
  {#if list.nextCursor}
    <div class="flex justify-center py-4">
      <Button variant="outline" onclick={() => void list.loadMore()} disabled={list.loadingMore}>
        {list.loadingMore ? t('common.loading') : t('common.loadMore')}
      </Button>
    </div>
  {/if}
{/if}

<Dialog.Root bind:open={showPushDialog}>
  <Dialog.Content class="sm:max-w-lg">
    <Dialog.Header>
      <Dialog.Title>{t('decks.pushTitle')}</Dialog.Title>
    </Dialog.Header>
    <PushInstructions />
    <div class="flex justify-end pt-2">
      <Button onclick={() => (showPushDialog = false)}>{t('common.done')}</Button>
    </div>
  </Dialog.Content>
</Dialog.Root>
