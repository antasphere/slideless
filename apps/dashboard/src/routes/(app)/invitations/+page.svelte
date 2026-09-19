<script lang="ts">
  import { Tag } from '$lib/components/ui/tag';
  import { roleTag, stateTag } from '$lib/tags';
  import { type ColumnDef } from '@tanstack/table-core';
  import { renderComponent } from '$lib/components/ui/data-table/index.js';
  import SectionHero from '$lib/components/shared/SectionHero.svelte';
  import DataTable, { rowCount } from '$lib/components/shared/DataTable.svelte';
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
  import { CodeBlock } from '$lib/components/ui/code-block/index.js';
  import { appear, reveal } from '$lib/components/ui/reveal/index.js';
  import FormError from '$lib/components/shared/FormError.svelte';
  import DialogDrawing from '$lib/components/brand/DialogDrawing.svelte';
  import Plus from '@lucide/svelte/icons/plus';
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import { createPagedList } from '$lib/stores/pagedList.svelte';
  import { api, errorMessage } from '$lib/api';
  import { formatDate, formatDateTime } from '$lib/format';
  import { toast } from 'svelte-sonner';
  import { t } from '$lib/i18n';
  import type { InvitationCreated, InvitationInfo, WorkspaceRole } from '@antasphere/chassis-contract';

  let { data } = $props();

  // P7: on a hub-origin (projected) workspace membership is managed at the
  // hub — the sidebar hides this page, but a deep link still lands here, so
  // the management affordances (invite, revoke) go too and the notice links
  // out. The list stays a real read.
  const hubManaged = $derived(data.me.workspace.hubOrigin);

  const list = createPagedList<InvitationInfo>(
    async (p) => {
      const { invitations, nextCursor } = await api.invitations(p);
      return { items: invitations, nextCursor };
    },
    { remember: 'invitations' }
  );

  $effect(() => {
    void list.load();
  });

  const invitations = $derived(list.items);
  // the toolbar's quiet line: how many invitations, once they are all here
  const invitationCount = $derived(
    list.nextCursor ? undefined : rowCount('invitations.countOne', 'invitations.count')
  );

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
      cell: ({ row }) => renderComponent(Tag, roleTag(row.original.role)),
      meta: { title: t('invitations.colRole'), width: '100px' }
    },
    {
      id: 'status',
      accessorFn: (row) => statusOf(row),
      header: ({ column }) =>
        renderComponent(DataTableColumnHeader, { column, title: t('invitations.colStatus') }),
      cell: ({ row }) => {
        const status = statusOf(row.original);
        return renderComponent(
          Tag,
          stateTag(
            statusLabels[status],
            status === 'open' ? 'wait' : status === 'accepted' ? 'ok' : status === 'revoked' ? 'bad' : 'off'
          )
        );
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
    ...(hubManaged
      ? []
      : [
          {
            id: 'actions',
            cell: ({ row }: { row: { original: InvitationInfo } }) =>
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
          } as ColumnDef<InvitationInfo, unknown>
        ])
  ]);

  // People is one section with two tabs (PRDCT-2436). Invitations are local
  // membership management: absent for a plain member, and on a hub-origin
  // workspace, whose membership is managed at the hub (P7).
  const peopleTabs = $derived([
    { href: '/members', label: t('members.title') },
    ...((data.me.role === 'owner' || data.me.role === 'admin') && !data.me.workspace.hubOrigin
      ? [{ href: '/invitations', label: t('invitations.title') }]
      : [])
  ]);
</script>

<SectionHero
  eyebrow={t('nav.workspace')}
  title={t('nav.people')}
  lede={t('invitations.description')}
  pageTitle={t('invitations.title')}
  tabs={peopleTabs}
  drawing="graph"
/>

{#snippet inviteAction()}
  <Button onclick={openCreateDialog} size="sm" class="h-8 gap-1.5">
    <Plus class="h-4 w-4" />
    {t('invitations.invite')}
  </Button>
{/snippet}

{#if hubManaged}
  <div class="notice mb-6 flex-wrap items-center justify-between gap-3 px-4 py-3" in:appear>
    <p class="min-w-0 text-sm">{t('members.hubManagedNotice')}</p>
    {#if data.me.hubManageUrl}
      <Button
        variant="outline"
        size="sm"
        href={data.me.hubManageUrl}
        target="_blank"
        rel="noopener noreferrer"
      >
        {t('members.hubManagedCta')}
        <ExternalLink class="ml-2 h-3.5 w-3.5" />
      </Button>
    {/if}
  </div>
{/if}

<FormError
  message={list.error && invitations.length ? t('common.refreshFailedCached', { error: list.error }) : null}
  class="pb-3"
/>
{#if list.loading}
  <TableSkeleton columns={6} />
{:else if list.error && !invitations.length}
  <p class="text-sm text-destructive" in:appear>{t('invitations.loadFailed', { error: list.error })}</p>
{:else}
  <DataTable
    data={invitations}
    {columns}
    searchColumns={['email']}
    searchPlaceholder={t('invitations.searchPlaceholder')}
    count={invitationCount}
    actions={hubManaged ? undefined : inviteAction}
  />
  {#if list.nextCursor}
    <div class="flex justify-center py-4" transition:reveal>
      <Button variant="outline" onclick={() => void list.loadMore()} disabled={list.loadingMore}>
        {list.loadingMore ? t('common.loading') : t('common.loadMore')}
      </Button>
    </div>
  {/if}
{/if}

{#snippet inviteAside()}
  <Dialog.Illustration eyebrow={t('invitations.asideEyebrow')} caption={t('invitations.asideCaption')}>
    <DialogDrawing kind="member" />
  </Dialog.Illustration>
{/snippet}

{#snippet linkAside()}
  <Dialog.Illustration eyebrow={t('invitations.asideEyebrow')} caption={t('invitations.linkAsideCaption')}>
    <DialogDrawing kind="membered" />
  </Dialog.Illustration>
{/snippet}

<FormDialog
  bind:open={showCreateDialog}
  size="lg"
  aside={inviteAside}
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
  <Dialog.Content size="lg" aside={linkAside} framed>
    <Dialog.Header>
      <Dialog.Title>{t('invitations.linkTitle')}</Dialog.Title>
      <Dialog.Description>
        {t('invitations.linkShare', { email: created?.invitation.email ?? '' })}
        {#if created?.emailSent}
          {t('invitations.linkEmailAlsoSent')}
        {/if}
      </Dialog.Description>
    </Dialog.Header>
    <Dialog.Body class="space-y-3">
      {#if created}
        <CodeBlock
          field
          code={created.acceptUrl}
          ariaLabel={t('invitations.linkAria')}
          copyLabel={t('invitations.copyLinkAria')}
          copiedMessage={t('invitations.linkCopied')}
        />
        <div class="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
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
      {/if}
    </Dialog.Body>
    <Dialog.Footer>
      <Button
        onclick={() => {
          showLinkDialog = false;
          created = null;
        }}
      >
        {t('common.done')}
      </Button>
    </Dialog.Footer>
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
