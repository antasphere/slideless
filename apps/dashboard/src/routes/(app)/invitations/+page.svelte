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
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import * as Select from '$lib/components/ui/select/index.js';
  import Copy from '@lucide/svelte/icons/copy';
  import { createPagedList } from '$lib/stores/pagedList.svelte';
  import { api, errorMessage } from '$lib/api';
  import { copyText } from '$lib/clipboard';
  import { formatDate, formatDateTime } from '$lib/format';
  import { toast } from 'svelte-sonner';
  import { t } from '$lib/i18n';
  import type { InvitationCreated, InvitationInfo, WorkspaceRole } from '@platform/contract';

  let { data } = $props();

  const list = createPagedList<InvitationInfo>(async (p) => {
    const { invitations, nextCursor } = await api.invitations(p);
    return { items: invitations, nextCursor };
  });

  $effect(() => {
    void list.load();
  });

  const invitations = $derived(list.items);

  type InviteStatus = 'open' | 'accepted' | 'revoked' | 'expired';

  function statusOf(i: InvitationInfo): InviteStatus {
    if (i.acceptedAt) return 'accepted';
    if (i.revokedAt) return 'revoked';
    if (new Date(i.expiresAt).getTime() < Date.now()) return 'expired';
    return 'open';
  }

  // ── Create dialog ──────────────────────────────────────────────────────
  let showCreateDialog = $state(false);
  let createLoading = $state(false);
  let inviteEmail = $state('');
  let inviteRole = $state<WorkspaceRole>('member');

  const roleOptions = $derived(
    data.me.role === 'owner' ? (['member', 'admin', 'owner'] as const) : (['member', 'admin'] as const)
  );

  // ── Link dialog: THE product moment — the copyable accept link ────────
  let created = $state<InvitationCreated | null>(null);
  let showLinkDialog = $state(false);

  function openCreateDialog() {
    inviteEmail = '';
    inviteRole = 'member';
    showCreateDialog = true;
  }

  async function submitCreate() {
    createLoading = true;
    try {
      const result = await api.createInvitation({ email: inviteEmail, role: inviteRole });
      showCreateDialog = false;
      created = result;
      showLinkDialog = true;
      await list.refresh();
    } catch (e) {
      toast.error(errorMessage(e, t('invitations.createFailed')));
    } finally {
      createLoading = false;
    }
  }

  // ── Revoke ─────────────────────────────────────────────────────────────
  let showRevokeDialog = $state(false);
  let revokeLoading = $state(false);
  let revokeTarget = $state<InvitationInfo | null>(null);

  async function submitRevoke() {
    if (!revokeTarget) return;
    revokeLoading = true;
    try {
      await api.revokeInvitation(revokeTarget.id);
      toast.success(t('invitations.revokedToast', { email: revokeTarget.email }));
      showRevokeDialog = false;
      revokeTarget = null;
      await list.refresh();
    } catch (e) {
      toast.error(errorMessage(e, t('common.revokeFailed')));
    } finally {
      revokeLoading = false;
    }
  }

  const statusVariant: Record<InviteStatus, 'default' | 'secondary' | 'destructive' | 'outline'> = {
    open: 'default',
    accepted: 'secondary',
    revoked: 'destructive',
    expired: 'outline'
  };

  const statusLabels: Record<InviteStatus, string> = {
    open: t('invitations.statusOpen'),
    accepted: t('invitations.statusAccepted'),
    revoked: t('invitations.statusRevoked'),
    expired: t('invitations.statusExpired')
  };

  const columns: ColumnDef<InvitationInfo, unknown>[] = $derived([
    {
      accessorKey: 'email',
      header: ({ column }) =>
        renderComponent(DataTableColumnHeader, { column, title: t('invitations.colEmail') }),
      cell: ({ row }) => row.getValue('email'),
      meta: { title: t('invitations.colEmail') }
    },
    {
      accessorKey: 'role',
      header: ({ column }) =>
        renderComponent(DataTableColumnHeader, { column, title: t('invitations.colRole') }),
      cell: ({ row }) =>
        renderComponent(Badge, {
          variant: 'secondary' as const,
          children: createRawSnippet(() => ({ render: () => `<span>${row.original.role}</span>` }))
        }),
      meta: { title: t('invitations.colRole'), width: '100px' }
    },
    {
      id: 'status',
      accessorFn: (row) => statusOf(row),
      header: ({ column }) =>
        renderComponent(DataTableColumnHeader, { column, title: t('invitations.colStatus') }),
      cell: ({ row }) => {
        const status = statusOf(row.original);
        return renderComponent(Badge, {
          variant: statusVariant[status],
          children: createRawSnippet(() => ({ render: () => `<span>${statusLabels[status]}</span>` }))
        });
      },
      meta: { title: t('invitations.colStatus'), width: '110px' }
    },
    {
      accessorKey: 'createdAt',
      header: ({ column }) =>
        renderComponent(DataTableColumnHeader, { column, title: t('invitations.colInvited') }),
      cell: ({ row }) => formatDate(row.getValue('createdAt') as string),
      meta: { title: t('invitations.colInvited'), width: '120px' }
    },
    {
      accessorKey: 'expiresAt',
      header: ({ column }) =>
        renderComponent(DataTableColumnHeader, { column, title: t('invitations.colExpires') }),
      cell: ({ row }) => formatDateTime(row.getValue('expiresAt') as string),
      meta: { title: t('invitations.colExpires'), width: '160px' }
    },
    {
      id: 'actions',
      cell: ({ row }) =>
        statusOf(row.original) === 'open'
          ? renderComponent(DataTableActions, {
              actions: [
                {
                  label: t('invitations.actionRevoke'),
                  onclick: () => {
                    revokeTarget = row.original;
                    showRevokeDialog = true;
                  },
                  variant: 'destructive' as const
                }
              ]
            })
          : '',
      meta: { width: '60px' }
    }
  ]);
</script>

<PageHeader
  title={t('invitations.title')}
  description={t('invitations.description')}
  onAdd={openCreateDialog}
  addLabel={t('invitations.invite')}
/>

{#if list.error && invitations.length}
  <p class="text-sm text-destructive">{t('common.refreshFailedCached', { error: list.error })}</p>
{/if}
{#if list.loading}
  <TableSkeleton columns={6} />
{:else if list.error && !invitations.length}
  <p class="text-sm text-destructive">{t('invitations.loadFailed', { error: list.error })}</p>
{:else}
  <DataTable
    data={invitations}
    {columns}
    searchColumns={['email']}
    searchPlaceholder={t('invitations.searchPlaceholder')}
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
  title={t('invitations.createTitle')}
  description={t('invitations.createDescription')}
  onClose={() => (showCreateDialog = false)}
  onSubmit={() => void submitCreate()}
  loading={createLoading}
  submitLabel={t('invitations.createSubmit')}
>
  <div class="space-y-2">
    <Label for="invite-email">{t('invitations.emailLabel')}</Label>
    <Input
      id="invite-email"
      type="email"
      bind:value={inviteEmail}
      placeholder={t('invitations.emailPlaceholder')}
      required
    />
  </div>
  <div class="space-y-2">
    <Label for="invite-role">{t('invitations.roleLabel')}</Label>
    <Select.Root
      type="single"
      value={inviteRole}
      onValueChange={(v) => {
        if (v) inviteRole = v as WorkspaceRole;
      }}
    >
      <Select.Trigger id="invite-role" class="w-full">
        {inviteRole}
      </Select.Trigger>
      <Select.Content>
        {#each roleOptions as role (role)}
          <Select.Item value={role} label={role} />
        {/each}
      </Select.Content>
    </Select.Root>
  </div>
</FormDialog>

<Dialog.Root
  bind:open={showLinkDialog}
  onOpenChange={(isOpen) => {
    if (!isOpen) created = null;
  }}
>
  <Dialog.Content class="sm:max-w-lg">
    <Dialog.Header>
      <Dialog.Title>{t('invitations.linkTitle')}</Dialog.Title>
      <Dialog.Description>
        {t('invitations.linkShare', { email: created?.invitation.email ?? '' })}
        {#if created?.emailSent}
          {t('invitations.linkEmailAlsoSent')}
        {/if}
      </Dialog.Description>
    </Dialog.Header>
    {#if created}
      <div class="space-y-3">
        <div class="flex items-center gap-2">
          <Input
            readonly
            value={created.acceptUrl}
            class="font-mono text-xs"
            aria-label={t('invitations.linkAria')}
          />
          <Button
            size="icon"
            variant="outline"
            class="shrink-0"
            aria-label={t('invitations.copyLinkAria')}
            onclick={() => void copyText(created!.acceptUrl, t('invitations.linkCopied'))}
          >
            <Copy class="h-4 w-4" />
          </Button>
        </div>
        <div class="flex items-center gap-2 text-sm text-muted-foreground">
          {#if created.emailSent}
            <Badge variant="secondary">{t('invitations.badgeEmailSent')}</Badge>
          {:else}
            <Badge variant="outline">{t('invitations.badgeNoEmail')}</Badge>
            <span>{t('invitations.sendYourself')}</span>
          {/if}
        </div>
        <p class="text-xs text-muted-foreground">
          {t('common.expires', { date: formatDateTime(created.invitation.expiresAt) })}
        </p>
      </div>
    {/if}
    <div class="flex justify-end pt-2">
      <Button
        onclick={() => {
          showLinkDialog = false;
          created = null;
        }}
      >
        {t('common.done')}
      </Button>
    </div>
  </Dialog.Content>
</Dialog.Root>

<ConfirmDialog
  bind:open={showRevokeDialog}
  title={t('invitations.revokeConfirmTitle')}
  description={t('invitations.revokeConfirmDescription', { email: revokeTarget?.email ?? '' })}
  confirmLabel={t('invitations.actionRevoke')}
  onClose={() => {
    showRevokeDialog = false;
    revokeTarget = null;
  }}
  onConfirm={() => void submitRevoke()}
  loading={revokeLoading}
/>
