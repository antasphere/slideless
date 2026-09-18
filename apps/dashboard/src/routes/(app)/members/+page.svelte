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
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import * as Select from '$lib/components/ui/select/index.js';
  import { CodeBlock } from '$lib/components/ui/code-block/index.js';
  import { appear, reveal } from '$lib/components/ui/reveal/index.js';
  import FormError from '$lib/components/shared/FormError.svelte';
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import { createPagedList } from '$lib/stores/pagedList.svelte';
  import { api, errorMessage, PlatformApiError } from '$lib/api';
  import { formatTimeAgo, formatDate, formatDateTime } from '$lib/format';
  import { toast } from 'svelte-sonner';
  import { t } from '$lib/i18n';
  import type { Member, MemberChangeEmailLink, MemberResetLink, WorkspaceRole } from '@slideless/contract';

  let { data } = $props();

  const me = $derived(data.me);
  const isAdmin = $derived(me.role === 'owner' || me.role === 'admin');
  // P7: a hub-origin (projected) workspace takes its membership from the
  // hub — the roster stays a real read, but every management affordance is
  // hidden and the notice links out (the API refuses them anyway).
  const hubManaged = $derived(me.workspace.hubOrigin);
  // The reset-link mint only makes sense where password sign-in is an
  // advertised human entrance (discovery `auth.methods`). On the cloud
  // edition it is absent and the API refuses the mint
  // (password_reset_disabled — credentials live at the hub), so hide the
  // affordance instead of offering an action that can only toast an error.
  const hasPasswordLogin = $derived(data.instance.auth.methods.includes('password'));
  // PRDCT-1354 (AUTH-8): minting someone else's reset / change-email link is
  // sign-in-equivalent, so the API now requires OWNER on both routes — an
  // admin who clicked either one would only ever get a 403 toast. The
  // remaining refusals (a guest membership, a target who also belongs to
  // another workspace) are not visible in the member wire, so those stay a
  // truthful error toast rather than a hidden affordance.
  const canMintCredentials = $derived(me.role === 'owner' && hasPasswordLogin);

  const list = createPagedList<Member>(async (p) => {
    const { members, nextCursor } = await api.members(p);
    return { items: members, nextCursor };
  });

  $effect(() => {
    void list.load();
  });

  const members = $derived(list.items);
  // the toolbar's quiet line: how many members, once they are all here
  const memberCount = $derived(list.nextCursor ? undefined : rowCount('members.countOne', 'members.count'));

  // ── Change role dialog ─────────────────────────────────────────────────
  let showRoleDialog = $state(false);
  let roleLoading = $state(false);
  let roleTarget = $state<Member | null>(null);
  let selectedRole = $state<WorkspaceRole>('member');

  const roleOptions = $derived(
    me.role === 'owner' ? (['member', 'admin', 'owner'] as const) : (['member', 'admin'] as const)
  );

  function openRoleDialog(member: Member) {
    roleTarget = member;
    selectedRole = member.role;
    showRoleDialog = true;
  }

  async function submitRole() {
    if (!roleTarget) return;
    roleLoading = true;
    try {
      await api.updateMember(roleTarget.id, { role: selectedRole });
      toast.success(t('members.roleChanged', { email: roleTarget.email, role: selectedRole }));
      showRoleDialog = false;
      roleTarget = null;
      await list.refresh();
    } catch (e) {
      toast.error(errorMessage(e, t('members.roleChangeFailed')));
    } finally {
      roleLoading = false;
    }
  }

  // ── Deactivate / reactivate ────────────────────────────────────────────
  let showActiveDialog = $state(false);
  let activeLoading = $state(false);
  let activeTarget = $state<Member | null>(null);

  function openActiveDialog(member: Member) {
    activeTarget = member;
    showActiveDialog = true;
  }

  async function submitActiveToggle() {
    if (!activeTarget) return;
    activeLoading = true;
    try {
      const next = !activeTarget.isActive;
      await api.updateMember(activeTarget.id, { isActive: next });
      toast.success(
        next
          ? t('members.reactivatedToast', { email: activeTarget.email })
          : t('members.deactivatedToast', { email: activeTarget.email })
      );
      showActiveDialog = false;
      activeTarget = null;
      await list.refresh();
    } catch (e) {
      toast.error(errorMessage(e, t('common.updateFailed')));
    } finally {
      activeLoading = false;
    }
  }

  // ── Delete member (GDPR erasure; their files stay with the workspace) ──
  let showDeleteDialog = $state(false);
  let deleteLoading = $state(false);
  let deleteTarget = $state<Member | null>(null);

  function openDeleteDialog(member: Member) {
    deleteTarget = member;
    showDeleteDialog = true;
  }

  async function submitDelete() {
    if (!deleteTarget) return;
    deleteLoading = true;
    try {
      await api.deleteMember(deleteTarget.id);
      toast.success(t('members.deletedToast', { email: deleteTarget.email }));
      showDeleteDialog = false;
      deleteTarget = null;
      await list.refresh();
    } catch (e) {
      toast.error(errorMessage(e, t('common.deleteFailed')));
    } finally {
      deleteLoading = false;
    }
  }

  // ── Reset link: the SMTP-free recovery path ────────────────────────────
  let showResetDialog = $state(false);
  let resetTarget = $state<Member | null>(null);
  let resetLink = $state<MemberResetLink | null>(null);

  async function generateResetLink(member: Member) {
    try {
      const result = await api.createMemberResetLink(member.id);
      resetTarget = member;
      resetLink = result;
      showResetDialog = true;
    } catch (e) {
      if (e instanceof PlatformApiError && e.status === 403) {
        toast.error(t('members.resetOwnerOnly'));
        return;
      }
      toast.error(errorMessage(e, t('members.resetLinkFailed')));
    }
  }

  // ── Change email: FormDialog → copyable sign-in-equivalent link ────────
  let showChangeEmailDialog = $state(false);
  let changeEmailLoading = $state(false);
  let changeEmailTarget = $state<Member | null>(null);
  let changeEmailValue = $state('');
  let showEmailLinkDialog = $state(false);
  let emailLink = $state<MemberChangeEmailLink | null>(null);
  // Captured at mint time: the form dialog's onClose nulls changeEmailTarget.
  let emailLinkTargetEmail = $state('');

  function openChangeEmailDialog(member: Member) {
    changeEmailTarget = member;
    changeEmailValue = '';
    showChangeEmailDialog = true;
  }

  async function submitChangeEmail() {
    if (!changeEmailTarget) return;
    changeEmailLoading = true;
    try {
      const result = await api.createMemberChangeEmailLink(changeEmailTarget.id, {
        newEmail: changeEmailValue.trim()
      });
      emailLink = result;
      emailLinkTargetEmail = changeEmailTarget.email;
      showChangeEmailDialog = false;
      changeEmailTarget = null;
      showEmailLinkDialog = true;
    } catch (e) {
      if (e instanceof PlatformApiError && e.status === 409) {
        toast.error(t('members.emailTaken'));
        return;
      }
      if (e instanceof PlatformApiError && e.status === 403) {
        toast.error(t('members.emailOwnerOnly'));
        return;
      }
      toast.error(errorMessage(e, t('members.emailLinkFailed')));
    } finally {
      changeEmailLoading = false;
    }
  }

  // Only owners touch owners — mirror the API rule in the action menu.
  function canManage(member: Member): boolean {
    if (!isAdmin) return false;
    if (member.role === 'owner' && me.role !== 'owner') return false;
    return true;
  }

  function rowActions(member: Member) {
    const actions: Array<{ label: string; onclick: () => void; variant?: 'default' | 'destructive' }> = [
      { label: t('members.actionChangeRole'), onclick: () => openRoleDialog(member) },
      ...(canMintCredentials
        ? [
            { label: t('members.actionChangeEmail'), onclick: () => openChangeEmailDialog(member) },
            { label: t('members.actionResetLink'), onclick: () => void generateResetLink(member) }
          ]
        : [])
    ];
    if (member.userId !== me.user.id) {
      actions.push({
        label: member.isActive ? t('members.actionDeactivate') : t('members.actionReactivate'),
        onclick: () => openActiveDialog(member),
        ...(member.isActive ? { variant: 'destructive' as const } : {})
      });
      actions.push({
        label: t('members.actionDelete'),
        onclick: () => openDeleteDialog(member),
        variant: 'destructive'
      });
    }
    return actions;
  }

  const roleBadge = (role: WorkspaceRole) => renderComponent(Tag, roleTag(role));

  const columns: ColumnDef<Member, unknown>[] = $derived([
    {
      accessorKey: 'email',
      header: ({ column }) =>
        renderComponent(DataTableColumnHeader, { column, title: t('members.colEmail') }),
      cell: ({ row }) => row.getValue('email'),
      meta: { title: t('members.colEmail') }
    },
    {
      accessorKey: 'name',
      header: ({ column }) => renderComponent(DataTableColumnHeader, { column, title: t('members.colName') }),
      cell: ({ row }) => row.getValue('name') || '—',
      meta: { title: t('members.colName') }
    },
    {
      accessorKey: 'role',
      header: ({ column }) => renderComponent(DataTableColumnHeader, { column, title: t('members.colRole') }),
      cell: ({ row }) => roleBadge(row.getValue('role') as WorkspaceRole),
      meta: { title: t('members.colRole'), width: '110px' }
    },
    {
      accessorKey: 'isActive',
      header: ({ column }) =>
        renderComponent(DataTableColumnHeader, { column, title: t('members.colStatus') }),
      cell: ({ row }) =>
        renderComponent(
          Tag,
          row.original.isActive
            ? stateTag(t('members.statusActive'), 'ok')
            : stateTag(t('members.statusInactive'), 'off')
        ),
      meta: { title: t('members.colStatus'), width: '110px' }
    },
    {
      accessorKey: 'lastSeenAt',
      header: ({ column }) =>
        renderComponent(DataTableColumnHeader, { column, title: t('members.colLastSeen') }),
      cell: ({ row }) => formatTimeAgo(row.getValue('lastSeenAt') as string | null),
      meta: { title: t('members.colLastSeen'), width: '130px' }
    },
    {
      accessorKey: 'createdAt',
      header: ({ column }) =>
        renderComponent(DataTableColumnHeader, { column, title: t('members.colJoined') }),
      cell: ({ row }) => formatDate(row.getValue('createdAt') as string),
      meta: { title: t('members.colJoined'), width: '130px' }
    },
    ...(isAdmin && !hubManaged
      ? [
          {
            id: 'actions',
            cell: ({ row }: { row: { original: Member } }) =>
              canManage(row.original)
                ? renderComponent(DataTableActions, { actions: rowActions(row.original) })
                : '',
            meta: { width: '60px' }
          } as ColumnDef<Member, unknown>
        ]
      : [])
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
  lede={t('members.description')}
  pageTitle={t('members.title')}
  tabs={peopleTabs}
  drawing="graph"
/>

{#if hubManaged}
  <div class="notice mb-6 flex-wrap items-center justify-between gap-3 px-4 py-3" in:appear>
    <p class="min-w-0 text-sm">{t('members.hubManagedNotice')}</p>
    {#if me.hubManageUrl}
      <Button variant="outline" size="sm" href={me.hubManageUrl} target="_blank" rel="noopener noreferrer">
        {t('members.hubManagedCta')}
        <ExternalLink class="ml-2 h-3.5 w-3.5" />
      </Button>
    {/if}
  </div>
{/if}

<FormError
  message={list.error && members.length ? t('common.refreshFailedCached', { error: list.error }) : null}
  class="pb-3"
/>
{#if list.loading}
  <TableSkeleton columns={6} />
{:else if list.error && !members.length}
  <p class="text-sm text-destructive" in:appear>{t('members.loadFailed', { error: list.error })}</p>
{:else}
  <DataTable
    data={members}
    {columns}
    searchColumns={['email', 'name']}
    searchPlaceholder={t('members.searchPlaceholder')}
    count={memberCount}
  />
  {#if list.nextCursor}
    <div class="flex justify-center py-4" transition:reveal>
      <Button variant="outline" onclick={() => void list.loadMore()} disabled={list.loadingMore}>
        {list.loadingMore ? t('common.loading') : t('common.loadMore')}
      </Button>
    </div>
  {/if}
{/if}

<FormDialog
  bind:open={showRoleDialog}
  title={t('members.roleDialogTitle')}
  description={roleTarget ? t('members.roleDialogDescription', { email: roleTarget.email }) : ''}
  onClose={() => {
    showRoleDialog = false;
    roleTarget = null;
  }}
  onSubmit={() => void submitRole()}
  loading={roleLoading}
  submitLabel={t('members.actionChangeRole')}
>
  <div class="space-y-2">
    <Label for="member-role">{t('members.roleLabel')}</Label>
    <Select.Root
      type="single"
      value={selectedRole}
      onValueChange={(v) => {
        if (v) selectedRole = v as WorkspaceRole;
      }}
    >
      <Select.Trigger id="member-role" class="w-full">
        {selectedRole}
      </Select.Trigger>
      <Select.Content>
        {#each roleOptions as role (role)}
          <Select.Item value={role} label={role} />
        {/each}
      </Select.Content>
    </Select.Root>
    {#if me.role !== 'owner'}
      <p class="text-xs text-muted-foreground">{t('members.roleOwnerHint')}</p>
    {/if}
  </div>
</FormDialog>

<Dialog.Root
  bind:open={showResetDialog}
  onOpenChange={(isOpen) => {
    if (!isOpen) {
      resetTarget = null;
      resetLink = null;
    }
  }}
>
  <Dialog.Content framed>
    <Dialog.Header>
      <Dialog.Title>{t('members.resetDialogTitle')}</Dialog.Title>
      <Dialog.Description>
        {t('members.resetDialogDescription', { email: resetTarget?.email ?? '' })}
      </Dialog.Description>
    </Dialog.Header>
    <Dialog.Body class="space-y-3">
      {#if resetLink}
        <CodeBlock
          field
          code={resetLink.resetUrl}
          ariaLabel={t('members.resetLinkAria')}
          copyLabel={t('members.copyResetAria')}
          copiedMessage={t('members.resetCopied')}
        />
        <p class="text-xs text-muted-foreground">
          {t('common.expires', { date: formatDateTime(resetLink.expiresAt) })}
        </p>
      {/if}
    </Dialog.Body>
    <Dialog.Footer>
      <Button
        onclick={() => {
          showResetDialog = false;
          resetTarget = null;
          resetLink = null;
        }}
      >
        {t('common.done')}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<FormDialog
  bind:open={showChangeEmailDialog}
  title={t('members.emailDialogTitle')}
  description={changeEmailTarget
    ? t('members.emailDialogDescription', { email: changeEmailTarget.email })
    : ''}
  onClose={() => {
    showChangeEmailDialog = false;
    changeEmailTarget = null;
  }}
  onSubmit={() => void submitChangeEmail()}
  loading={changeEmailLoading}
  submitLabel={t('members.generateLink')}
>
  <div class="space-y-2">
    <Label for="member-new-email">{t('members.newEmailLabel')}</Label>
    <Input
      id="member-new-email"
      type="email"
      autocomplete="off"
      bind:value={changeEmailValue}
      placeholder={t('members.newEmailPlaceholder')}
      required
    />
  </div>
</FormDialog>

<Dialog.Root
  bind:open={showEmailLinkDialog}
  onOpenChange={(isOpen) => {
    if (!isOpen) {
      emailLink = null;
      emailLinkTargetEmail = '';
    }
  }}
>
  <Dialog.Content framed>
    <Dialog.Header>
      <Dialog.Title>{t('members.emailLinkTitle')}</Dialog.Title>
      <Dialog.Description>
        {t('members.emailLinkBody', { oldEmail: emailLinkTargetEmail, newEmail: emailLink?.newEmail ?? '' })}
        <strong>{t('members.emailLinkSignsIn')}</strong>
        {t('members.emailLinkShareOnly', { email: emailLinkTargetEmail })}
      </Dialog.Description>
    </Dialog.Header>
    <Dialog.Body class="space-y-3">
      {#if emailLink}
        <CodeBlock
          field
          code={emailLink.verifyUrl}
          ariaLabel={t('members.emailLinkAria')}
          copyLabel={t('members.copyEmailLinkAria')}
          copiedMessage={t('members.emailLinkCopied')}
        />
        <p class="text-xs text-muted-foreground">
          {t('common.expires', { date: formatDateTime(emailLink.expiresAt) })}
        </p>
      {/if}
    </Dialog.Body>
    <Dialog.Footer>
      <Button
        onclick={() => {
          showEmailLinkDialog = false;
          emailLink = null;
          emailLinkTargetEmail = '';
        }}
      >
        {t('common.done')}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<ConfirmDialog
  bind:open={showDeleteDialog}
  title={t('members.deleteConfirmTitle')}
  description={t('members.deleteConfirmDescription', { email: deleteTarget?.email ?? '' })}
  confirmLabel={t('members.actionDelete')}
  onClose={() => {
    showDeleteDialog = false;
    deleteTarget = null;
  }}
  onConfirm={() => void submitDelete()}
  loading={deleteLoading}
/>

<ConfirmDialog
  bind:open={showActiveDialog}
  title={activeTarget?.isActive ? t('members.deactivateConfirmTitle') : t('members.reactivateConfirmTitle')}
  description={activeTarget?.isActive
    ? t('members.deactivateConfirmDescription', { email: activeTarget?.email ?? '' })
    : t('members.reactivateConfirmDescription', { email: activeTarget?.email ?? '' })}
  confirmLabel={activeTarget?.isActive ? t('members.actionDeactivate') : t('members.actionReactivate')}
  variant={activeTarget?.isActive ? 'destructive' : 'default'}
  onClose={() => {
    showActiveDialog = false;
    activeTarget = null;
  }}
  onConfirm={() => void submitActiveToggle()}
  loading={activeLoading}
/>
