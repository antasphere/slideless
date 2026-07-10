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
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import Copy from '@lucide/svelte/icons/copy';
  import Plus from '@lucide/svelte/icons/plus';
  import { createPagedList } from '$lib/stores/pagedList.svelte';
  import { api, errorMessage } from '$lib/api';
  import { copyText } from '$lib/clipboard';
  import { formatDate } from '$lib/format';
  import { toast } from 'svelte-sonner';
  import { t } from '$lib/i18n';
  import type { Collaborator } from '@slideless/contract';

  interface Props {
    deckId: string;
    /** Invite/remove are owner-level (deck owner or workspace admin/owner). */
    canManage: boolean;
  }

  let { deckId, canManage }: Props = $props();

  const list = createPagedList<Collaborator>(async (p) => {
    const { collaborators, nextCursor } = await api.collaborators(deckId, p);
    return { items: collaborators, nextCursor };
  });

  $effect(() => {
    void list.load();
  });

  // ── Invite dialog ──────────────────────────────────────────────────────
  let showInviteDialog = $state(false);
  let inviteLoading = $state(false);
  let inviteEmail = $state('');

  // ── Claim-link dialog (always returned — SMTP never required) ─────────
  let claimUrl = $state<string | null>(null);
  let claimEmail = $state('');
  let claimEmailSent = $state(false);
  let showClaimDialog = $state(false);

  function openInviteDialog() {
    inviteEmail = '';
    showInviteDialog = true;
  }

  async function submitInvite() {
    inviteLoading = true;
    try {
      const result = await api.inviteCollaborator(deckId, { email: inviteEmail });
      showInviteDialog = false;
      claimUrl = result.claimUrl;
      claimEmail = result.collaborator.email;
      claimEmailSent = result.emailSent;
      showClaimDialog = true;
      await list.refresh();
    } catch (e) {
      toast.error(errorMessage(e, t('collaborators.inviteFailed')));
    } finally {
      inviteLoading = false;
    }
  }

  // ── Remove ─────────────────────────────────────────────────────────────
  let showRemoveDialog = $state(false);
  let removeLoading = $state(false);
  let removeTarget = $state<Collaborator | null>(null);

  async function submitRemove() {
    if (!removeTarget) return;
    removeLoading = true;
    try {
      await api.removeCollaborator(deckId, removeTarget.id);
      toast.success(t('collaborators.removedToast', { email: removeTarget.email }));
      showRemoveDialog = false;
      removeTarget = null;
      await list.refresh();
    } catch (e) {
      toast.error(errorMessage(e, t('common.deleteFailed')));
    } finally {
      removeLoading = false;
    }
  }

  const statusKey = {
    pending: 'collaborators.statusPending',
    active: 'collaborators.statusActive',
    revoked: 'collaborators.statusRevoked'
  } as const;

  const columns: ColumnDef<Collaborator, unknown>[] = $derived([
    {
      accessorKey: 'email',
      header: ({ column }) =>
        renderComponent(DataTableColumnHeader, { column, title: t('collaborators.colEmail') }),
      // SECURITY: collaborator emails are USER-SUPPLIED text. Returning the
      // plain string renders through FlexRender's escaped `{result}` text
      // interpolation — never wrap it in createRawSnippet / {@html}.
      cell: ({ row }) => row.getValue('email'),
      meta: { title: t('collaborators.colEmail') }
    },
    {
      accessorKey: 'role',
      header: ({ column }) =>
        renderComponent(DataTableColumnHeader, { column, title: t('collaborators.colRole') }),
      cell: ({ row }) => row.original.role,
      meta: { title: t('collaborators.colRole'), width: '90px' }
    },
    {
      accessorKey: 'status',
      header: ({ column }) =>
        renderComponent(DataTableColumnHeader, { column, title: t('collaborators.colStatus') }),
      cell: ({ row }) =>
        renderComponent(Badge, {
          variant: (row.original.status === 'revoked' ? 'destructive' : 'outline') as
            | 'destructive'
            | 'outline',
          // Static i18n text only — never user data inside createRawSnippet.
          children: createRawSnippet(() => ({
            render: () => `<span>${t(statusKey[row.original.status])}</span>`
          }))
        }),
      meta: { title: t('collaborators.colStatus'), width: '110px' }
    },
    {
      accessorKey: 'createdAt',
      header: ({ column }) =>
        renderComponent(DataTableColumnHeader, { column, title: t('collaborators.colInvited') }),
      cell: ({ row }) => formatDate(row.original.createdAt),
      meta: { title: t('collaborators.colInvited'), width: '110px' }
    },
    {
      id: 'actions',
      cell: ({ row }) =>
        !canManage || row.original.status === 'revoked'
          ? ''
          : renderComponent(DataTableActions, {
              actions: [
                {
                  label: t('collaborators.actionRemove'),
                  onclick: () => {
                    removeTarget = row.original;
                    showRemoveDialog = true;
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
        <Card.Title class="text-base">{t('collaborators.title')}</Card.Title>
        <Card.Description>{t('collaborators.description')}</Card.Description>
      </div>
      {#if canManage}
        <Button size="sm" onclick={openInviteDialog}>
          <Plus class="mr-2 h-4 w-4" />
          {t('collaborators.invite')}
        </Button>
      {/if}
    </div>
  </Card.Header>
  <Card.Content>
    {#if !canManage}
      <p class="pb-2 text-xs text-muted-foreground">{t('collaborators.ownersOnly')}</p>
    {/if}
    {#if list.loading}
      <TableSkeleton columns={4} rows={2} showSearch={false} />
    {:else if list.error && !list.items.length}
      <p class="text-sm text-destructive">{t('collaborators.loadFailed', { error: list.error })}</p>
    {:else if !list.items.length}
      <p class="text-sm text-muted-foreground">{t('collaborators.empty')}</p>
    {:else}
      <DataTable data={list.items} {columns} showViewOptions={false} showPagination={false} pageSize={200} />
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
  bind:open={showInviteDialog}
  title={t('collaborators.inviteTitle')}
  description={t('collaborators.inviteDescription')}
  onClose={() => (showInviteDialog = false)}
  onSubmit={() => void submitInvite()}
  loading={inviteLoading}
  submitLabel={t('collaborators.inviteSubmit')}
>
  <div class="space-y-2">
    <Label for="collab-email">{t('collaborators.emailLabel')}</Label>
    <Input
      id="collab-email"
      type="email"
      bind:value={inviteEmail}
      placeholder={t('collaborators.emailPlaceholder')}
      required
    />
  </div>
</FormDialog>

<Dialog.Root
  bind:open={showClaimDialog}
  onOpenChange={(isOpen) => {
    if (!isOpen) claimUrl = null;
  }}
>
  <Dialog.Content class="sm:max-w-lg">
    <Dialog.Header>
      <Dialog.Title>{t('collaborators.linkTitle')}</Dialog.Title>
      <Dialog.Description>
        <!-- claimEmail is user-supplied; t() output renders as escaped text. -->
        {t('collaborators.linkShare', { email: claimEmail })}
      </Dialog.Description>
    </Dialog.Header>
    {#if claimUrl}
      <div class="space-y-3">
        <div class="flex items-center gap-2">
          <Input
            readonly
            value={claimUrl}
            class="font-mono text-xs"
            aria-label={t('collaborators.linkAria')}
          />
          <Button
            size="icon"
            variant="outline"
            class="shrink-0"
            aria-label={t('collaborators.copyLinkAria')}
            onclick={() => void copyText(claimUrl!, t('collaborators.linkCopied'))}
          >
            <Copy class="h-4 w-4" />
          </Button>
        </div>
        <p class="text-sm text-muted-foreground">
          {#if claimEmailSent}
            <Badge variant="outline">{t('invitations.badgeEmailSent')}</Badge>
            {t('collaborators.emailAlsoSent')}
          {:else}
            <Badge variant="outline">{t('invitations.badgeNoEmail')}</Badge>
            {t('collaborators.sendYourself')}
          {/if}
        </p>
      </div>
    {/if}
    <div class="flex justify-end pt-2">
      <Button
        onclick={() => {
          showClaimDialog = false;
          claimUrl = null;
        }}
      >
        {t('common.done')}
      </Button>
    </div>
  </Dialog.Content>
</Dialog.Root>

<ConfirmDialog
  bind:open={showRemoveDialog}
  title={t('collaborators.removeConfirmTitle')}
  description={t('collaborators.removeConfirmDescription', { email: removeTarget?.email ?? '' })}
  confirmLabel={t('collaborators.actionRemove')}
  onClose={() => {
    showRemoveDialog = false;
    removeTarget = null;
  }}
  onConfirm={() => void submitRemove()}
  loading={removeLoading}
/>
