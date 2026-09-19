<script lang="ts">
  import { Tag } from '$lib/components/ui/tag';
  import { fileTag } from '$lib/tags';
  import Plus from '@lucide/svelte/icons/plus';
  import { type ColumnDef } from '@tanstack/table-core';
  import { renderComponent } from '$lib/components/ui/data-table/index.js';
  import SectionHero from '$lib/components/shared/SectionHero.svelte';
  import DataTable, { rowCount } from '$lib/components/shared/DataTable.svelte';
  import DataTableColumnHeader from '$lib/components/shared/DataTableColumnHeader.svelte';
  import DataTableActions from '$lib/components/shared/DataTableActions.svelte';
  import TableSkeleton from '$lib/components/shared/TableSkeleton.svelte';
  import ConfirmDialog from '$lib/components/shared/ConfirmDialog.svelte';
  import FormError from '$lib/components/shared/FormError.svelte';
  import { appear, reveal } from '$lib/components/ui/reveal/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { createPagedList } from '$lib/stores/pagedList.svelte';
  import { api, PlatformApiError, errorMessage } from '$lib/api';
  import { formatBytes, formatDateTime } from '$lib/format';
  import { toast } from 'svelte-sonner';
  import { download } from '$lib/download';
  import { t } from '$lib/i18n';
  import type { FileInfo } from '@slideless/contract';

  const list = createPagedList<FileInfo>(
    async (p) => {
      const { files, nextCursor } = await api.files(p);
      return { items: files, nextCursor };
    },
    { remember: 'files' }
  );

  $effect(() => {
    void list.load();
  });

  const files = $derived(list.items);
  // the toolbar's quiet line: how many files, once they are all here
  const fileCount = $derived(list.nextCursor ? undefined : rowCount('files.countOne', 'files.count'));

  // ── Upload (raw bytes, filename as query param) ────────────────────────
  let fileInput = $state<HTMLInputElement | null>(null);
  let uploading = $state(false);

  async function onFileChosen() {
    const file = fileInput?.files?.[0];
    if (!file) return;
    uploading = true;
    try {
      const { deduplicated } = await api.uploadFile(file.name, file, file.type || undefined);
      toast.success(
        deduplicated
          ? t('files.uploadedDedup', { name: file.name })
          : t('files.uploadedToast', { name: file.name })
      );
      await list.refresh();
    } catch (e) {
      if (e instanceof PlatformApiError && e.status === 413) {
        toast.error(t('files.tooLarge', { message: e.message }));
      } else {
        toast.error(errorMessage(e, t('files.uploadFailed')));
      }
    } finally {
      uploading = false;
      if (fileInput) fileInput.value = '';
    }
  }

  // Through $lib/download, never an anchor on the content URL (PRDCT-2426):
  // the anchor asked the DEFAULT workspace for a file of the active one.
  function downloadFile(file: FileInfo) {
    void download(() => api.downloadFileContent(file.id), { fallbackName: file.originalName });
  }

  // ── Delete ─────────────────────────────────────────────────────────────
  let showDeleteDialog = $state(false);
  let deleteLoading = $state(false);
  let deleteTarget = $state<FileInfo | null>(null);

  async function submitDelete() {
    if (!deleteTarget) return;
    deleteLoading = true;
    try {
      await api.deleteFile(deleteTarget.id);
      toast.success(t('files.deletedToast', { name: deleteTarget.originalName }));
      showDeleteDialog = false;
      deleteTarget = null;
      await list.refresh();
    } catch (e) {
      toast.error(errorMessage(e, t('common.deleteFailed')));
    } finally {
      deleteLoading = false;
    }
  }

  const columns: ColumnDef<FileInfo, unknown>[] = $derived([
    {
      accessorKey: 'originalName',
      header: ({ column }) => renderComponent(DataTableColumnHeader, { column, title: t('files.colName') }),
      cell: ({ row }) => row.getValue('originalName'),
      meta: { title: t('files.colName') }
    },
    {
      accessorKey: 'sizeBytes',
      header: ({ column }) => renderComponent(DataTableColumnHeader, { column, title: t('files.colSize') }),
      cell: ({ row }) => formatBytes(row.getValue('sizeBytes') as number),
      meta: { title: t('files.colSize'), width: '100px' }
    },
    {
      accessorKey: 'contentType',
      header: ({ column }) => renderComponent(DataTableColumnHeader, { column, title: t('files.colType') }),
      cell: ({ row }) => renderComponent(Tag, fileTag(String(row.getValue('contentType')))),
      meta: { title: t('files.colType'), width: '200px' }
    },
    {
      accessorKey: 'createdAt',
      header: ({ column }) =>
        renderComponent(DataTableColumnHeader, { column, title: t('files.colUploaded') }),
      cell: ({ row }) => formatDateTime(row.getValue('createdAt') as string),
      meta: { title: t('files.colUploaded'), width: '210px' }
    },
    {
      id: 'actions',
      cell: ({ row }) =>
        renderComponent(DataTableActions, {
          actions: [
            { label: t('files.actionDownload'), onclick: () => downloadFile(row.original) },
            {
              label: t('files.actionDelete'),
              onclick: () => {
                deleteTarget = row.original;
                showDeleteDialog = true;
              },
              variant: 'destructive' as const
            }
          ]
        }),
      meta: { width: '60px' }
    }
  ]);
</script>

<SectionHero
  eyebrow={t('nav.workspace')}
  title={t('files.title')}
  lede={t('files.description')}
  drawing="contour"
/>

{#snippet uploadAction()}
  <Button onclick={() => fileInput?.click()} size="sm" class="h-8 gap-1.5">
    <Plus class="h-4 w-4" />
    {uploading ? t('files.uploading') : t('files.upload')}
  </Button>
{/snippet}

<input type="file" class="hidden" bind:this={fileInput} onchange={() => void onFileChosen()} />

<FormError
  message={list.error && files.length ? t('common.refreshFailedCached', { error: list.error }) : null}
  class="pb-3"
/>
{#if list.loading}
  <TableSkeleton columns={5} />
{:else if list.error && !files.length}
  <p class="text-sm text-destructive" in:appear>{t('files.loadFailed', { error: list.error })}</p>
{:else}
  <DataTable
    data={files}
    {columns}
    searchColumns={['originalName']}
    searchPlaceholder={t('files.searchPlaceholder')}
    count={fileCount}
    actions={uploadAction}
  />
  {#if list.nextCursor}
    <div class="flex justify-center py-4" transition:reveal>
      <Button variant="outline" onclick={() => void list.loadMore()} disabled={list.loadingMore}>
        {list.loadingMore ? t('common.loading') : t('common.loadMore')}
      </Button>
    </div>
  {/if}
{/if}

<ConfirmDialog
  bind:open={showDeleteDialog}
  title={t('files.deleteConfirmTitle')}
  description={t('files.deleteConfirmDescription', { name: deleteTarget?.originalName ?? '' })}
  confirmLabel={t('files.actionDelete')}
  onClose={() => {
    showDeleteDialog = false;
    deleteTarget = null;
  }}
  onConfirm={() => void submitDelete()}
  loading={deleteLoading}
/>
