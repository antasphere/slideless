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
  import * as Card from '$lib/components/ui/card/index.js';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import * as Select from '$lib/components/ui/select/index.js';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Checkbox } from '$lib/components/ui/checkbox/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import Copy from '@lucide/svelte/icons/copy';
  import Plus from '@lucide/svelte/icons/plus';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import type { PagedList } from '$lib/stores/pagedList.svelte';
  import { api, errorMessage } from '$lib/api';
  import { copyText } from '$lib/clipboard';
  import { isPreviewToken, tokenStatus } from '$lib/decks';
  import { formatDate, formatTimeAgo } from '$lib/format';
  import { toast } from 'svelte-sonner';
  import { t } from '$lib/i18n';
  import type { PresentationVersion, ShareToken, ShareTokenCreate } from '@slideless/contract';

  interface Props {
    deckId: string;
    /** Page-owned list — shared with the preview's token housekeeping. */
    list: PagedList<ShareToken>;
    versions: PresentationVersion[];
  }

  let { deckId, list, versions }: Props = $props();

  // The page's own transient preview tokens are plumbing, not shares.
  const tokens = $derived(list.items.filter((token) => !isPreviewToken(token)));

  // ── Create dialog ──────────────────────────────────────────────────────
  const expiryOptions = [
    { value: 'never', label: t('tokens.expiryNever') },
    { value: '7', label: t('tokens.expiryDays', { n: 7 }) },
    { value: '30', label: t('tokens.expiryDays', { n: 30 }) },
    { value: '90', label: t('tokens.expiryDays', { n: 90 }) }
  ];
  let showCreateDialog = $state(false);
  let createLoading = $state(false);
  let tokenName = $state('');
  let versionMode = $state<'latest' | 'pinned'>('latest');
  let pinnedVersion = $state('');
  let canAnnotate = $state(false);
  let expiresIn = $state('never');
  let password = $state('');

  // ── Created dialog: the viewer URL appears exactly once ───────────────
  let createdUrl = $state<string | null>(null);
  let showCreatedDialog = $state(false);

  function openCreateDialog() {
    tokenName = '';
    versionMode = 'latest';
    pinnedVersion = versions[0] ? String(versions[0].version) : '';
    canAnnotate = false;
    expiresIn = 'never';
    password = '';
    showCreateDialog = true;
  }

  async function submitCreate() {
    createLoading = true;
    try {
      const req: ShareTokenCreate = {
        name: tokenName,
        versionMode,
        ...(versionMode === 'pinned' ? { pinnedVersion: Number(pinnedVersion) } : {}),
        canAnnotate,
        ...(expiresIn !== 'never'
          ? { expiresAt: new Date(Date.now() + Number(expiresIn) * 86_400_000).toISOString() }
          : {}),
        ...(password ? { password } : {})
      };
      const result = await api.createShareToken(deckId, req);
      showCreateDialog = false;
      createdUrl = result.url;
      showCreatedDialog = true;
      await list.refresh();
    } catch (e) {
      toast.error(errorMessage(e, t('tokens.createFailed')));
    } finally {
      createLoading = false;
    }
  }

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
          ...(token.canAnnotate ? [t('tokens.badgeAnnotate')] : [])
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
        tokenStatus(row.original) !== 'active'
          ? ''
          : renderComponent(DataTableActions, {
              actions: [
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
              ]
            }),
      meta: { width: '60px' }
    }
  ]);
</script>

<Card.Root>
  <Card.Header>
    <div class="flex items-start justify-between gap-4">
      <div class="space-y-1">
        <Card.Title class="text-base">{t('tokens.title')}</Card.Title>
        <Card.Description>{t('tokens.description')}</Card.Description>
      </div>
      <Button size="sm" onclick={openCreateDialog}>
        <Plus class="mr-2 h-4 w-4" />
        {t('tokens.create')}
      </Button>
    </div>
  </Card.Header>
  <Card.Content>
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
  </Card.Content>
</Card.Root>

<FormDialog
  bind:open={showCreateDialog}
  title={t('tokens.createTitle')}
  description={t('tokens.createDescription')}
  onClose={() => (showCreateDialog = false)}
  onSubmit={() => void submitCreate()}
  loading={createLoading}
  submitLabel={t('tokens.createSubmit')}
>
  <div class="space-y-2">
    <Label for="token-name">{t('tokens.nameLabel')}</Label>
    <Input id="token-name" bind:value={tokenName} placeholder={t('tokens.namePlaceholder')} required />
  </div>
  <div class="space-y-2">
    <Label for="token-version-mode">{t('tokens.versionLabel')}</Label>
    <Select.Root
      type="single"
      value={versionMode}
      onValueChange={(v) => {
        if (v === 'latest' || v === 'pinned') versionMode = v;
      }}
    >
      <Select.Trigger id="token-version-mode" class="w-full">
        {versionMode === 'latest' ? t('tokens.versionLatest') : t('tokens.versionPinned')}
      </Select.Trigger>
      <Select.Content>
        <Select.Item value="latest" label={t('tokens.versionLatest')} />
        <Select.Item value="pinned" label={t('tokens.versionPinned')} disabled={!versions.length} />
      </Select.Content>
    </Select.Root>
  </div>
  {#if versionMode === 'pinned'}
    <div class="space-y-2">
      <Label for="token-pinned-version">{t('tokens.colVersion')}</Label>
      <Select.Root
        type="single"
        value={pinnedVersion}
        onValueChange={(v) => {
          if (v) pinnedVersion = v;
        }}
      >
        <Select.Trigger id="token-pinned-version" class="w-full">
          {pinnedVersion ? `v${pinnedVersion}` : '—'}
        </Select.Trigger>
        <Select.Content>
          {#each versions as version (version.version)}
            <Select.Item value={String(version.version)} label={`v${version.version}`} />
          {/each}
        </Select.Content>
      </Select.Root>
    </div>
  {/if}
  <div class="flex items-center gap-2">
    <Checkbox id="token-annotate" bind:checked={canAnnotate} />
    <Label for="token-annotate" class="font-normal">
      {t('tokens.annotateLabel')}
      <span class="text-muted-foreground">{t('tokens.annotateHint')}</span>
    </Label>
  </div>
  <div class="space-y-2">
    <Label for="token-expiry">{t('tokens.expiryLabel')}</Label>
    <Select.Root
      type="single"
      value={expiresIn}
      onValueChange={(v) => {
        if (v) expiresIn = v;
      }}
    >
      <Select.Trigger id="token-expiry" class="w-full">
        {expiryOptions.find((o) => o.value === expiresIn)?.label}
      </Select.Trigger>
      <Select.Content>
        {#each expiryOptions as option (option.value)}
          <Select.Item value={option.value} label={option.label} />
        {/each}
      </Select.Content>
    </Select.Root>
  </div>
  <div class="space-y-2">
    <Label for="token-password">{t('tokens.passwordLabel')}</Label>
    <Input id="token-password" type="password" autocomplete="off" bind:value={password} minlength={4} />
    <p class="text-xs text-muted-foreground">{t('tokens.passwordHint')}</p>
  </div>
</FormDialog>

<Dialog.Root
  bind:open={showCreatedDialog}
  onOpenChange={(isOpen) => {
    if (!isOpen) createdUrl = null;
  }}
>
  <Dialog.Content class="sm:max-w-lg">
    <Dialog.Header>
      <Dialog.Title>{t('tokens.createdTitle')}</Dialog.Title>
      <Dialog.Description>{t('tokens.createdDescription')}</Dialog.Description>
    </Dialog.Header>
    {#if createdUrl}
      <div class="space-y-3">
        <div class="flex items-center gap-2">
          <Input readonly value={createdUrl} class="font-mono text-xs" aria-label={t('tokens.urlAria')} />
          <Button
            size="icon"
            variant="outline"
            class="shrink-0"
            aria-label={t('tokens.copyUrlAria')}
            onclick={() => void copyText(createdUrl!, t('tokens.urlCopied'))}
          >
            <Copy class="h-4 w-4" />
          </Button>
        </div>
        <p
          class="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm"
        >
          <TriangleAlert class="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <span>{t('tokens.secretWarning')}</span>
        </p>
      </div>
    {/if}
    <div class="flex justify-end pt-2">
      <Button
        onclick={() => {
          showCreatedDialog = false;
          createdUrl = null;
        }}
      >
        {t('common.done')}
      </Button>
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
