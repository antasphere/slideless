<script lang="ts">
  import { createRawSnippet } from 'svelte';
  import { type ColumnDef } from '@tanstack/table-core';
  import { renderComponent } from '$lib/components/ui/data-table/index.js';
  import PageHeader from '$lib/components/shared/PageHeader.svelte';
  import DataTable from '$lib/components/shared/DataTable.svelte';
  import DataTableColumnHeader from '$lib/components/shared/DataTableColumnHeader.svelte';
  import DataTableActions from '$lib/components/shared/DataTableActions.svelte';
  import TableSkeleton from '$lib/components/shared/TableSkeleton.svelte';
  import FormDialog from '$lib/components/shared/FormDialog.svelte';
  import ConfirmDialog from '$lib/components/shared/ConfirmDialog.svelte';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Checkbox } from '$lib/components/ui/checkbox/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import * as Select from '$lib/components/ui/select/index.js';
  import Copy from '@lucide/svelte/icons/copy';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import { createPagedList } from '$lib/stores/pagedList.svelte';
  import { api, errorMessage } from '$lib/api';
  import { copyText } from '$lib/clipboard';
  import { formatDate, formatTimeAgo } from '$lib/format';
  import { toast } from 'svelte-sonner';
  import { t } from '$lib/i18n';
  import type { ApiKeyInfo, Scope } from '@platform/contract';

  const list = createPagedList<ApiKeyInfo>(async (p) => {
    const { apiKeys, nextCursor } = await api.apiKeys(p);
    return { items: apiKeys, nextCursor };
  });

  $effect(() => {
    void list.load();
  });

  const keys = $derived(list.items);

  // ── Create dialog ──────────────────────────────────────────────────────
  const expiryOptions = [
    { value: 'never', label: t('apiKeys.expiryNever') },
    { value: '7', label: t('apiKeys.expiryDays', { n: 7 }) },
    { value: '30', label: t('apiKeys.expiryDays', { n: 30 }) },
    { value: '90', label: t('apiKeys.expiryDays', { n: 90 }) },
    { value: '365', label: t('apiKeys.expiryYear') }
  ];
  let showCreateDialog = $state(false);
  let createLoading = $state(false);
  let keyName = $state('');
  let scopeRead = $state(true);
  let scopeWrite = $state(false);
  // Deliberately unchecked by default: full-workspace export is an opt-in.
  let scopeExport = $state(false);
  let expiresIn = $state('never');

  // ── Secret dialog: shown exactly once, never retrievable again ────────
  let mintedKey = $state<string | null>(null);
  let showSecretDialog = $state(false);

  function openCreateDialog() {
    keyName = '';
    scopeRead = true;
    scopeWrite = false;
    scopeExport = false;
    expiresIn = 'never';
    showCreateDialog = true;
  }

  async function submitCreate() {
    const scopes: Scope[] = [
      ...(scopeRead ? (['data:read'] as const) : []),
      ...(scopeWrite ? (['data:write'] as const) : []),
      ...(scopeExport ? (['data:export'] as const) : [])
    ];
    if (scopes.length === 0) {
      toast.error(t('apiKeys.errorNoScope'));
      return;
    }
    createLoading = true;
    try {
      const result = await api.createApiKey({
        name: keyName,
        scopes,
        ...(expiresIn !== 'never' ? { expiresInDays: Number(expiresIn) } : {})
      });
      showCreateDialog = false;
      mintedKey = result.key;
      showSecretDialog = true;
      await list.refresh();
    } catch (e) {
      toast.error(errorMessage(e, t('apiKeys.createFailed')));
    } finally {
      createLoading = false;
    }
  }

  // ── Revoke ─────────────────────────────────────────────────────────────
  let showRevokeDialog = $state(false);
  let revokeLoading = $state(false);
  let revokeTarget = $state<ApiKeyInfo | null>(null);

  async function submitRevoke() {
    if (!revokeTarget) return;
    revokeLoading = true;
    try {
      await api.revokeApiKey(revokeTarget.id);
      toast.success(t('apiKeys.revokedToast', { name: revokeTarget.name }));
      showRevokeDialog = false;
      revokeTarget = null;
      await list.refresh();
    } catch (e) {
      toast.error(errorMessage(e, t('common.revokeFailed')));
    } finally {
      revokeLoading = false;
    }
  }

  // Status precedence: Expired > Revoked > Active.
  const isExpired = (k: ApiKeyInfo) => Boolean(k.expiresAt && new Date(k.expiresAt) <= new Date());

  const columns: ColumnDef<ApiKeyInfo, unknown>[] = $derived([
    {
      accessorKey: 'name',
      header: ({ column }) => renderComponent(DataTableColumnHeader, { column, title: t('apiKeys.colName') }),
      cell: ({ row }) => row.getValue('name'),
      meta: { title: t('apiKeys.colName') }
    },
    {
      accessorKey: 'keyId',
      header: ({ column }) =>
        renderComponent(DataTableColumnHeader, { column, title: t('apiKeys.colKeyId') }),
      cell: ({ row }) =>
        renderComponent(Badge, {
          variant: 'outline' as const,
          class: 'font-mono',
          children: createRawSnippet(() => ({ render: () => `<span>${row.original.keyId}</span>` }))
        }),
      meta: { title: t('apiKeys.colKeyId'), width: '120px' }
    },
    {
      accessorKey: 'scopes',
      header: ({ column }) =>
        renderComponent(DataTableColumnHeader, { column, title: t('apiKeys.colScopes') }),
      cell: ({ row }) => (row.getValue('scopes') as string[]).join(', '),
      meta: { title: t('apiKeys.colScopes'), width: '180px' }
    },
    {
      accessorKey: 'createdAt',
      header: ({ column }) =>
        renderComponent(DataTableColumnHeader, { column, title: t('apiKeys.colCreated') }),
      cell: ({ row }) => formatDate(row.getValue('createdAt') as string),
      meta: { title: t('apiKeys.colCreated'), width: '120px' }
    },
    {
      accessorKey: 'expiresAt',
      header: ({ column }) =>
        renderComponent(DataTableColumnHeader, { column, title: t('apiKeys.colExpires') }),
      cell: ({ row }) => {
        const expiresAt = row.getValue('expiresAt') as string | null;
        return expiresAt ? formatDate(expiresAt) : '—';
      },
      meta: { title: t('apiKeys.colExpires'), width: '120px' }
    },
    {
      accessorKey: 'lastUsedAt',
      header: ({ column }) =>
        renderComponent(DataTableColumnHeader, { column, title: t('apiKeys.colLastUsed') }),
      cell: ({ row }) => formatTimeAgo(row.getValue('lastUsedAt') as string | null),
      meta: { title: t('apiKeys.colLastUsed'), width: '130px' }
    },
    {
      accessorKey: 'revokedAt',
      header: ({ column }) =>
        renderComponent(DataTableColumnHeader, { column, title: t('apiKeys.colStatus') }),
      cell: ({ row }) =>
        renderComponent(Badge, {
          variant: (isExpired(row.original) || row.original.revokedAt ? 'destructive' : 'outline') as
            'destructive' | 'outline',
          children: createRawSnippet(() => ({
            render: () =>
              `<span>${isExpired(row.original) ? t('apiKeys.statusExpired') : row.original.revokedAt ? t('apiKeys.statusRevoked') : t('apiKeys.statusActive')}</span>`
          }))
        }),
      meta: { title: t('apiKeys.colStatus'), width: '110px' }
    },
    {
      id: 'actions',
      cell: ({ row }) =>
        row.original.revokedAt || isExpired(row.original)
          ? ''
          : renderComponent(DataTableActions, {
              actions: [
                {
                  label: t('apiKeys.actionRevoke'),
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

<PageHeader
  title={t('apiKeys.title')}
  description={t('apiKeys.description')}
  onAdd={openCreateDialog}
  addLabel={t('apiKeys.create')}
/>

{#if list.error && keys.length}
  <p class="text-sm text-destructive">{t('common.refreshFailedCached', { error: list.error })}</p>
{/if}
{#if list.loading}
  <TableSkeleton columns={8} />
{:else if list.error && !keys.length}
  <p class="text-sm text-destructive">{t('apiKeys.loadFailed', { error: list.error })}</p>
{:else}
  <DataTable
    data={keys}
    {columns}
    searchColumns={['name', 'keyId']}
    searchPlaceholder={t('apiKeys.searchPlaceholder')}
  />
  {#if list.nextCursor}
    <div class="flex justify-center py-4">
      <Button variant="outline" onclick={() => void list.loadMore()} disabled={list.loadingMore}>
        {list.loadingMore ? t('common.loading') : t('common.loadMore')}
      </Button>
    </div>
  {/if}
{/if}

<FormDialog
  bind:open={showCreateDialog}
  title={t('apiKeys.createTitle')}
  description={t('apiKeys.createDescription')}
  onClose={() => (showCreateDialog = false)}
  onSubmit={() => void submitCreate()}
  loading={createLoading}
  submitLabel={t('apiKeys.create')}
>
  <div class="space-y-2">
    <Label for="key-name">{t('apiKeys.nameLabel')}</Label>
    <Input id="key-name" bind:value={keyName} placeholder="ci-deploy" required />
  </div>
  <fieldset class="space-y-3">
    <legend class="text-sm font-medium">{t('apiKeys.scopesLegend')}</legend>
    <div class="flex items-center gap-2">
      <Checkbox id="scope-read" bind:checked={scopeRead} />
      <Label for="scope-read" class="font-normal">
        data:read <span class="text-muted-foreground">{t('apiKeys.scopeReadDesc')}</span>
      </Label>
    </div>
    <div class="flex items-center gap-2">
      <Checkbox id="scope-write" bind:checked={scopeWrite} />
      <Label for="scope-write" class="font-normal">
        data:write <span class="text-muted-foreground">{t('apiKeys.scopeWriteDesc')}</span>
      </Label>
    </div>
    <div class="flex items-center gap-2">
      <Checkbox id="scope-export" bind:checked={scopeExport} />
      <Label for="scope-export" class="font-normal">
        data:export <span class="text-muted-foreground">{t('apiKeys.scopeExportDesc')}</span>
      </Label>
    </div>
  </fieldset>
  <div class="space-y-2">
    <Label for="key-expiry">{t('apiKeys.expiryLabel')}</Label>
    <Select.Root
      type="single"
      value={expiresIn}
      onValueChange={(v) => {
        if (v) expiresIn = v;
      }}
    >
      <Select.Trigger id="key-expiry" class="w-full">
        {expiryOptions.find((o) => o.value === expiresIn)?.label}
      </Select.Trigger>
      <Select.Content>
        {#each expiryOptions as option (option.value)}
          <Select.Item value={option.value} label={option.label} />
        {/each}
      </Select.Content>
    </Select.Root>
  </div>
</FormDialog>

<Dialog.Root
  bind:open={showSecretDialog}
  onOpenChange={(isOpen) => {
    if (!isOpen) mintedKey = null;
  }}
>
  <Dialog.Content class="sm:max-w-lg">
    <Dialog.Header>
      <Dialog.Title>{t('apiKeys.secretTitle')}</Dialog.Title>
      <Dialog.Description>{t('apiKeys.secretDescription')}</Dialog.Description>
    </Dialog.Header>
    {#if mintedKey}
      <div class="space-y-3">
        <div class="flex items-center gap-2">
          <Input readonly value={mintedKey} class="font-mono text-xs" aria-label={t('apiKeys.secretAria')} />
          <Button
            size="icon"
            variant="outline"
            class="shrink-0"
            aria-label={t('apiKeys.copyAria')}
            onclick={() => void copyText(mintedKey!, t('apiKeys.copiedToast'))}
          >
            <Copy class="h-4 w-4" />
          </Button>
        </div>
        <p
          class="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm"
        >
          <TriangleAlert class="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <span>{t('apiKeys.secretWarning')}</span>
        </p>
      </div>
    {/if}
    <div class="flex justify-end pt-2">
      <Button
        onclick={() => {
          showSecretDialog = false;
          mintedKey = null;
        }}
      >
        {t('apiKeys.savedIt')}
      </Button>
    </div>
  </Dialog.Content>
</Dialog.Root>

<ConfirmDialog
  bind:open={showRevokeDialog}
  title={t('apiKeys.revokeConfirmTitle')}
  description={t('apiKeys.revokeConfirmDescription', { name: revokeTarget?.name ?? '' })}
  confirmLabel={t('apiKeys.actionRevoke')}
  onClose={() => {
    showRevokeDialog = false;
    revokeTarget = null;
  }}
  onConfirm={() => void submitRevoke()}
  loading={revokeLoading}
/>
