<script lang="ts">
  import { Tag, TagList } from '$lib/components/ui/tag';
  import { scopeTag, stateTag } from '$lib/tags';
  import KeyRoundIcon from '@lucide/svelte/icons/key-round';
  import Plus from '@lucide/svelte/icons/plus';
  import { type ColumnDef } from '@tanstack/table-core';
  import { renderComponent } from '$lib/components/ui/data-table/index.js';
  import SectionHero from '$lib/components/shared/SectionHero.svelte';
  import DataTable from '$lib/components/shared/DataTable.svelte';
  import DataTableColumnHeader from '$lib/components/shared/DataTableColumnHeader.svelte';
  import DataTableActions from '$lib/components/shared/DataTableActions.svelte';
  import TableSkeleton from '$lib/components/shared/TableSkeleton.svelte';
  import FormDialog from '$lib/components/shared/FormDialog.svelte';
  import ConfirmDialog from '$lib/components/shared/ConfirmDialog.svelte';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Checkbox } from '$lib/components/ui/checkbox/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import * as Select from '$lib/components/ui/select/index.js';
  import { CodeBlock } from '$lib/components/ui/code-block/index.js';
  import { appear, reveal } from '$lib/components/ui/reveal/index.js';
  import FormError from '$lib/components/shared/FormError.svelte';
  import DialogDrawing from '$lib/components/decks/drawings/DialogDrawing.svelte';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import { createPagedList } from '$lib/stores/pagedList.svelte';
  import { api, errorMessage } from '$lib/api';
  import { formatDate, formatTimeAgo } from '$lib/format';
  import { toast } from 'svelte-sonner';
  import { t } from '$lib/i18n';
  import type { ApiKeyInfo, Scope } from '@slideless/contract';

  const list = createPagedList<ApiKeyInfo>(async (p) => {
    const { apiKeys, nextCursor } = await api.apiKeys(p);
    return { items: apiKeys, nextCursor };
  });

  $effect(() => {
    void list.load();
  });

  const keys = $derived(list.items);
  // the bar's quiet line: how many keys, once they are all here
  const keyCount = $derived(
    list.loading || list.nextCursor || !keys.length
      ? undefined
      : keys.length === 1
        ? t('apiKeys.countOne')
        : t('apiKeys.count', { n: keys.length })
  );

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
      ...(scopeRead ? (['presentations:read'] as const) : []),
      ...(scopeWrite ? (['presentations:write'] as const) : []),
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
      cell: ({ row }) => renderComponent(Tag, { label: row.original.keyId, mono: true, icon: KeyRoundIcon }),
      meta: { title: t('apiKeys.colKeyId'), width: '150px' }
    },
    {
      accessorKey: 'scopes',
      header: ({ column }) =>
        renderComponent(DataTableColumnHeader, { column, title: t('apiKeys.colScopes') }),
      cell: ({ row }) =>
        renderComponent(TagList, { tags: (row.getValue('scopes') as string[]).map(scopeTag) }),
      meta: { title: t('apiKeys.colScopes'), width: '260px' }
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
        renderComponent(
          Tag,
          isExpired(row.original)
            ? stateTag(t('apiKeys.statusExpired'), 'wait')
            : row.original.revokedAt
              ? stateTag(t('apiKeys.statusRevoked'), 'bad')
              : stateTag(t('apiKeys.statusActive'), 'ok')
        ),
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

<SectionHero
  eyebrow={t('nav.workspace')}
  title={t('apiKeys.title')}
  lede={t('apiKeys.description')}
  status={keyCount}
  drawing="lattice"
>
  {#snippet action()}
    <Button onclick={openCreateDialog} size="sm" class="gap-1.5">
      <Plus class="h-4 w-4" />
      {t('apiKeys.create')}
    </Button>
  {/snippet}
</SectionHero>

<FormError
  message={list.error && keys.length ? t('common.refreshFailedCached', { error: list.error }) : null}
  class="pb-3"
/>
{#if list.loading}
  <TableSkeleton columns={8} />
{:else if list.error && !keys.length}
  <p class="text-sm text-destructive" in:appear>{t('apiKeys.loadFailed', { error: list.error })}</p>
{:else}
  <DataTable
    data={keys}
    {columns}
    searchColumns={['name', 'keyId']}
    searchPlaceholder={t('apiKeys.searchPlaceholder')}
  />
  {#if list.nextCursor}
    <div class="flex justify-center py-4" transition:reveal>
      <Button variant="outline" onclick={() => void list.loadMore()} disabled={list.loadingMore}>
        {list.loadingMore ? t('common.loading') : t('common.loadMore')}
      </Button>
    </div>
  {/if}
{/if}

{#snippet keyAside()}
  <Dialog.Illustration eyebrow={t('apiKeys.asideEyebrow')} caption={t('apiKeys.asideCaption')}>
    <DialogDrawing kind="key" />
  </Dialog.Illustration>
{/snippet}

{#snippet secretAside()}
  <Dialog.Illustration eyebrow={t('apiKeys.asideEyebrow')} caption={t('apiKeys.secretAsideCaption')}>
    <DialogDrawing kind="key" />
  </Dialog.Illustration>
{/snippet}

<!-- One scope: its switch, its name as the tag the table shows, and under it
     what a key holding it may do. -->
{#snippet scopeOption(id: string, scope: Scope, hint: string, checked: boolean, set: (v: boolean) => void)}
  <div class="scope">
    <Checkbox
      {id}
      {checked}
      onCheckedChange={(v) => set(v === true)}
      aria-describedby="{id}-hint"
      class="mt-0.5"
    />
    <div class="min-w-0 space-y-1">
      <Label for={id} class="block leading-none"><Tag {...scopeTag(scope)} /></Label>
      <p id="{id}-hint" class="hint">{hint}</p>
    </div>
  </div>
{/snippet}

<FormDialog
  bind:open={showCreateDialog}
  size="lg"
  aside={keyAside}
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
  <fieldset class="space-y-2">
    <legend class="eyebrow pb-2">{t('apiKeys.scopesLegend')}</legend>
    <div class="scopes">
      {@render scopeOption(
        'scope-read',
        'presentations:read',
        t('apiKeys.scopeReadDesc'),
        scopeRead,
        (v) => (scopeRead = v)
      )}
      {@render scopeOption(
        'scope-write',
        'presentations:write',
        t('apiKeys.scopeWriteDesc'),
        scopeWrite,
        (v) => (scopeWrite = v)
      )}
      {@render scopeOption(
        'scope-export',
        'data:export',
        t('apiKeys.scopeExportDesc'),
        scopeExport,
        (v) => (scopeExport = v)
      )}
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
  <Dialog.Content size="lg" aside={secretAside} framed>
    <Dialog.Header>
      <Dialog.Title>{t('apiKeys.secretTitle')}</Dialog.Title>
      <Dialog.Description>{t('apiKeys.secretDescription')}</Dialog.Description>
    </Dialog.Header>
    <Dialog.Body class="space-y-3">
      {#if mintedKey}
        <CodeBlock
          field
          code={mintedKey}
          ariaLabel={t('apiKeys.secretAria')}
          copyLabel={t('apiKeys.copyAria')}
          copiedMessage={t('apiKeys.copiedToast')}
        />
        <p class="notice notice--danger">
          <TriangleAlert class="size-4" />
          <span>{t('apiKeys.secretWarning')}</span>
        </p>
      {/if}
    </Dialog.Body>
    <Dialog.Footer>
      <Button
        onclick={() => {
          showSecretDialog = false;
          mintedKey = null;
        }}
      >
        {t('apiKeys.savedIt')}
      </Button>
    </Dialog.Footer>
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

<style>
  .hint {
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--muted);
    text-wrap: pretty;
  }
  /* the scopes, as one ruled list: a hairline between two of them */
  .scopes {
    border: 1px solid var(--hairline);
    border-radius: 10px;
    background: color-mix(in oklab, var(--ground-2) 38%, transparent);
  }
  .scope {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 11px 12px;
  }
  .scope + .scope {
    border-top: 1px solid color-mix(in oklab, var(--hairline) 75%, transparent);
  }
</style>
