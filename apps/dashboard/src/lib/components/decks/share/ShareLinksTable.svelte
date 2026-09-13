<script lang="ts">
  import { createRawSnippet } from 'svelte';
  import { type ColumnDef } from '@tanstack/table-core';
  import { renderComponent } from '$lib/components/ui/data-table/index.js';
  import DataTable from '$lib/components/shared/DataTable.svelte';
  import DataTableColumnHeader from '$lib/components/shared/DataTableColumnHeader.svelte';
  import DataTableActions from '$lib/components/shared/DataTableActions.svelte';
  import TableSkeleton from '$lib/components/shared/TableSkeleton.svelte';
  import FormDialog from '$lib/components/shared/FormDialog.svelte';
  import ConfirmDialog from '$lib/components/shared/ConfirmDialog.svelte';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import * as Select from '$lib/components/ui/select/index.js';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import type { PagedList } from '$lib/stores/pagedList.svelte';
  import { api, errorMessage } from '$lib/api';
  import { isPreviewToken, tokenStatus } from '$lib/decks';
  import { formatDate, formatTimeAgo } from '$lib/format';
  import { toast } from 'svelte-sonner';
  import { t } from '$lib/i18n';
  import type { PresentationVersion, ShareToken, ShareTokenView } from '@slideless/contract';

  /**
   * The deck's share links as a table with their per-row actions (activity,
   * change version, revoke) and the dialogs those open. Shared by the admin
   * page's share panel and the master page's share sheet (PRDCT-2279).
   * Creating a link is the sibling ShareLinkCreateDialog.
   */
  interface Props {
    deckId: string;
    /** Page-owned list — shared with the preview's token housekeeping. */
    list: PagedList<ShareToken>;
    versions: PresentationVersion[];
  }

  let { deckId, list, versions }: Props = $props();

  // The page's own transient preview tokens are plumbing, not shares.
  const tokens = $derived(list.items.filter((token) => !isPreviewToken(token)));

  // ── Change version dialog ──────────────────────────────────────────────
  let showVersionDialog = $state(false);
  let versionLoading = $state(false);
  let versionTarget = $state<ShareToken | null>(null);
  let editVersionMode = $state<'latest' | 'pinned'>('latest');
  let editPinnedVersion = $state('');

  function openVersionDialog(token: ShareToken) {
    versionTarget = token;
    editVersionMode = token.pinnedVersion === null ? 'latest' : 'pinned';
    editPinnedVersion = String(token.pinnedVersion ?? versions[0]?.version ?? '');
    showVersionDialog = true;
  }

  async function submitVersionChange() {
    if (!versionTarget) return;
    versionLoading = true;
    try {
      await api.updateShareToken(
        deckId,
        versionTarget.id,
        editVersionMode === 'latest'
          ? { versionMode: 'latest' }
          : { versionMode: 'pinned', pinnedVersion: Number(editPinnedVersion) }
      );
      toast.success(t('tokens.updatedToast', { name: versionTarget.name }));
      showVersionDialog = false;
      versionTarget = null;
      await list.refresh();
    } catch (e) {
      toast.error(errorMessage(e, t('tokens.updateFailed')));
    } finally {
      versionLoading = false;
    }
  }

  // ── Per-view activity dialog (PRDCT-1313) ─────────────────────────────
  // Recent counted views of one link: time, referring site host, placement
  // label, coarse browser family. All values render through escaped Svelte
  // interpolation — referrerHost/placement are visitor-influenced text.
  let showViewsDialog = $state(false);
  let viewsTarget = $state<ShareToken | null>(null);
  let viewsRows = $state<ShareTokenView[]>([]);
  let viewsCursor = $state<string | null>(null);
  let viewsLoading = $state(false);
  let viewsLoadingMore = $state(false);
  let viewsError = $state<string | null>(null);

  const VIEWS_PAGE = 25;

  async function openViewsDialog(token: ShareToken) {
    viewsTarget = token;
    viewsRows = [];
    viewsCursor = null;
    viewsError = null;
    showViewsDialog = true;
    viewsLoading = true;
    try {
      const page = await api.shareTokenViews(deckId, token.id, { limit: VIEWS_PAGE });
      viewsRows = page.views;
      viewsCursor = page.nextCursor;
    } catch (e) {
      viewsError = errorMessage(e);
    } finally {
      viewsLoading = false;
    }
  }

  async function loadMoreViews() {
    if (!viewsTarget || !viewsCursor) return;
    viewsLoadingMore = true;
    try {
      const page = await api.shareTokenViews(deckId, viewsTarget.id, {
        limit: VIEWS_PAGE,
        cursor: viewsCursor
      });
      viewsRows = [...viewsRows, ...page.views];
      viewsCursor = page.nextCursor;
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      viewsLoadingMore = false;
    }
  }

  // ── Revoke ─────────────────────────────────────────────────────────────
  let showRevokeDialog = $state(false);
  let revokeLoading = $state(false);
  let revokeTarget = $state<ShareToken | null>(null);

  async function submitRevoke() {
    if (!revokeTarget) return;
    revokeLoading = true;
    try {
      await api.revokeShareToken(deckId, revokeTarget.id);
      toast.success(t('tokens.revokedToast', { name: revokeTarget.name }));
      showRevokeDialog = false;
      revokeTarget = null;
      await list.refresh();
    } catch (e) {
      toast.error(errorMessage(e, t('common.revokeFailed')));
    } finally {
      revokeLoading = false;
    }
  }

  const statusKey = {
    active: 'tokens.statusActive',
    revoked: 'tokens.statusRevoked',
    expired: 'tokens.statusExpired'
  } as const;

  const columns: ColumnDef<ShareToken, unknown>[] = $derived([
    {
      accessorKey: 'name',
      header: ({ column }) => renderComponent(DataTableColumnHeader, { column, title: t('tokens.colName') }),
      // SECURITY: the recipient label is USER-SUPPLIED text. Returning the
      // plain string renders through FlexRender's escaped `{result}` text
      // interpolation — never wrap it in createRawSnippet / {@html}.
      cell: ({ row }) => row.getValue('name'),
      meta: { title: t('tokens.colName') }
    },
    {
      accessorKey: 'pinnedVersion',
      header: ({ column }) =>
        renderComponent(DataTableColumnHeader, { column, title: t('tokens.colVersion') }),
      cell: ({ row }) => {
        const token = row.original;
        const mode =
          token.pinnedVersion === null
            ? t('tokens.modeLatest')
            : t('tokens.modePinned', { n: token.pinnedVersion });
        const flags = [
          ...(token.hasPassword ? [t('tokens.badgePassword')] : []),
          ...(token.canAnnotate ? [t('tokens.badgeAnnotate')] : []),
          // Forms and downloads default ON — flag the exception, not the norm.
          ...(token.canSubmitForms ? [] : [t('tokens.badgeFormsOff')]),
          ...(token.canDownload ? [] : [t('tokens.badgeDownloadsOff')])
        ];
        return flags.length ? `${mode} · ${flags.join(' · ')}` : mode;
      },
      meta: { title: t('tokens.colVersion'), width: '200px' }
    },
    {
      accessorKey: 'accessCount',
      header: ({ column }) => renderComponent(DataTableColumnHeader, { column, title: t('tokens.colViews') }),
      cell: ({ row }) => String(row.original.accessCount),
      meta: { title: t('tokens.colViews'), width: '80px' }
    },
    {
      accessorKey: 'lastAccessedAt',
      header: ({ column }) =>
        renderComponent(DataTableColumnHeader, { column, title: t('tokens.colLastAccess') }),
      cell: ({ row }) => formatTimeAgo(row.original.lastAccessedAt),
      meta: { title: t('tokens.colLastAccess'), width: '130px' }
    },
    {
      accessorKey: 'expiresAt',
      header: ({ column }) =>
        renderComponent(DataTableColumnHeader, { column, title: t('tokens.colExpires') }),
      cell: ({ row }) => (row.original.expiresAt ? formatDate(row.original.expiresAt) : '—'),
      meta: { title: t('tokens.colExpires'), width: '110px' }
    },
    {
      accessorKey: 'revokedAt',
      header: ({ column }) =>
        renderComponent(DataTableColumnHeader, { column, title: t('tokens.colStatus') }),
      cell: ({ row }) => {
        const status = tokenStatus(row.original);
        return renderComponent(Badge, {
          variant: (status === 'active' ? 'outline' : 'destructive') as 'outline' | 'destructive',
          // Static i18n text only — never user data inside createRawSnippet.
          children: createRawSnippet(() => ({ render: () => `<span>${t(statusKey[status])}</span>` }))
        });
      },
      meta: { title: t('tokens.colStatus'), width: '100px' }
    },
    {
      id: 'actions',
      cell: ({ row }) =>
        renderComponent(DataTableActions, {
          actions: [
            // View activity stays available on revoked/expired links too —
            // access history deliberately survives revocation.
            {
              label: t('tokens.actionViews'),
              onclick: () => void openViewsDialog(row.original)
            },
            ...(tokenStatus(row.original) !== 'active'
              ? []
              : [
                  {
                    label: t('tokens.actionChangeVersion'),
                    onclick: () => openVersionDialog(row.original)
                  },
                  {
                    label: t('tokens.actionRevoke'),
                    onclick: () => {
                      revokeTarget = row.original;
                      showRevokeDialog = true;
                    },
                    variant: 'destructive' as const
                  }
                ])
          ]
        }),
      meta: { width: '60px' }
    }
  ]);
</script>

{#if list.loading}
  <TableSkeleton columns={6} rows={2} />
{:else if list.error && !tokens.length}
  <p class="text-sm text-destructive">{t('tokens.loadFailed', { error: list.error })}</p>
{:else if !tokens.length}
  <p class="text-sm text-muted-foreground">{t('tokens.empty')}</p>
{:else}
  <DataTable data={tokens} {columns} showViewOptions={false} showPagination={false} pageSize={200} />
  {#if list.nextCursor}
    <div class="flex justify-center py-2">
      <Button variant="outline" size="sm" onclick={() => void list.loadMore()} disabled={list.loadingMore}>
        {list.loadingMore ? t('common.loading') : t('common.loadMore')}
      </Button>
    </div>
  {/if}
{/if}

<Dialog.Root
  bind:open={showViewsDialog}
  onOpenChange={(isOpen) => {
    if (!isOpen) {
      viewsTarget = null;
      viewsRows = [];
      viewsCursor = null;
      viewsError = null;
    }
  }}
>
  <Dialog.Content class="sm:max-w-lg">
    <Dialog.Header>
      <Dialog.Title>{t('tokens.viewsTitle')}</Dialog.Title>
      <Dialog.Description>
        {t('tokens.viewsDescription', { name: viewsTarget?.name ?? '' })}
      </Dialog.Description>
    </Dialog.Header>
    {#if viewsLoading}
      <p class="py-4 text-sm text-muted-foreground">{t('common.loading')}</p>
    {:else if viewsError}
      <p class="py-4 text-sm text-destructive">{t('tokens.viewsLoadFailed', { error: viewsError })}</p>
    {:else if !viewsRows.length}
      <p class="py-4 text-sm text-muted-foreground">{t('tokens.viewsEmpty')}</p>
    {:else}
      <div class="max-h-80 space-y-0 overflow-y-auto rounded-md border">
        {#each viewsRows as view (view.id)}
          <!-- referrerHost/placement are visitor-influenced: escaped {} only. -->
          <div class="flex items-baseline justify-between gap-3 border-b px-3 py-2 text-sm last:border-b-0">
            <span class="shrink-0 text-muted-foreground">{formatTimeAgo(view.occurredAt)}</span>
            <span class="min-w-0 flex-1 truncate text-right">
              {view.referrerHost ?? t('tokens.viewsDirect')}
              {#if view.placement}
                <span class="text-muted-foreground">· {view.placement}</span>
              {/if}
              {#if view.uaFamily}
                <span class="text-muted-foreground">· {view.uaFamily}</span>
              {/if}
              <span class="text-muted-foreground">· v{view.version}</span>
            </span>
          </div>
        {/each}
      </div>
      {#if viewsCursor}
        <div class="flex justify-center pt-2">
          <Button
            variant="outline"
            size="sm"
            onclick={() => void loadMoreViews()}
            disabled={viewsLoadingMore}
          >
            {viewsLoadingMore ? t('common.loading') : t('common.loadMore')}
          </Button>
        </div>
      {/if}
    {/if}
    <div class="flex justify-end pt-2">
      <Button onclick={() => (showViewsDialog = false)}>{t('common.close')}</Button>
    </div>
  </Dialog.Content>
</Dialog.Root>

<FormDialog
  bind:open={showVersionDialog}
  title={t('tokens.versionDialogTitle')}
  description={t('tokens.versionDialogDescription', { name: versionTarget?.name ?? '' })}
  onClose={() => {
    showVersionDialog = false;
    versionTarget = null;
  }}
  onSubmit={() => void submitVersionChange()}
  loading={versionLoading}
  submitLabel={t('common.save')}
>
  <div class="space-y-2">
    <Label for="edit-version-mode">{t('tokens.versionLabel')}</Label>
    <Select.Root
      type="single"
      value={editVersionMode}
      onValueChange={(v) => {
        if (v === 'latest' || v === 'pinned') editVersionMode = v;
      }}
    >
      <Select.Trigger id="edit-version-mode" class="w-full">
        {editVersionMode === 'latest' ? t('tokens.versionLatest') : t('tokens.versionPinned')}
      </Select.Trigger>
      <Select.Content>
        <Select.Item value="latest" label={t('tokens.versionLatest')} />
        <Select.Item value="pinned" label={t('tokens.versionPinned')} disabled={!versions.length} />
      </Select.Content>
    </Select.Root>
  </div>
  {#if editVersionMode === 'pinned'}
    <div class="space-y-2">
      <Label for="edit-pinned-version">{t('tokens.colVersion')}</Label>
      <Select.Root
        type="single"
        value={editPinnedVersion}
        onValueChange={(v) => {
          if (v) editPinnedVersion = v;
        }}
      >
        <Select.Trigger id="edit-pinned-version" class="w-full">
          {editPinnedVersion ? `v${editPinnedVersion}` : '—'}
        </Select.Trigger>
        <Select.Content>
          {#each versions as version (version.version)}
            <Select.Item value={String(version.version)} label={`v${version.version}`} />
          {/each}
        </Select.Content>
      </Select.Root>
    </div>
  {/if}
</FormDialog>

<ConfirmDialog
  bind:open={showRevokeDialog}
  title={t('tokens.revokeConfirmTitle')}
  description={t('tokens.revokeConfirmDescription', { name: revokeTarget?.name ?? '' })}
  confirmLabel={t('tokens.actionRevoke')}
  onClose={() => {
    showRevokeDialog = false;
    revokeTarget = null;
  }}
  onConfirm={() => void submitRevoke()}
  loading={revokeLoading}
/>
