<script lang="ts">
  /* Who is in a project, and with which role. A manager of an open project
     adds people, changes roles and removes; everyone else reads the list, and
     finds one action on their own row: leaving. Membership of a project is
     local to the tool on both editions, so nothing here reads `hub_managed`. */
  import { goto } from '$app/navigation';
  import { type ColumnDef } from '@tanstack/table-core';
  import { renderComponent } from '$lib/components/ui/data-table/index.js';
  import DataTable, { rowCount } from '$lib/components/shared/DataTable.svelte';
  import DataTableColumnHeader from '$lib/components/shared/DataTableColumnHeader.svelte';
  import DataTableActions from '$lib/components/shared/DataTableActions.svelte';
  import TableSkeleton from '$lib/components/shared/TableSkeleton.svelte';
  import FormDialog from '$lib/components/shared/FormDialog.svelte';
  import ConfirmDialog from '$lib/components/shared/ConfirmDialog.svelte';
  import FormError from '$lib/components/shared/FormError.svelte';
  import AddProjectMemberDialog from './AddProjectMemberDialog.svelte';
  import ProjectRoleSelect from './ProjectRoleSelect.svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Tag } from '$lib/components/ui/tag';
  import { appear, reveal } from '$lib/components/ui/reveal/index.js';
  import Plus from '@lucide/svelte/icons/plus';
  import { createPagedList } from '$lib/stores/pagedList.svelte';
  import { errorMessage } from '$lib/api';
  import { projects } from '$lib/projects/client';
  import { projectCan } from '$lib/projects/can';
  import type { Project, ProjectMember, ProjectRole } from '$lib/projects/types';
  import { projectRoleTag } from '$lib/tags';
  import { formatDate } from '$lib/format';
  import { toast } from 'svelte-sonner';
  import { t } from '$lib/i18n';

  interface Props {
    project: Project;
    myUserId: string;
    /** After any change: the page reads the project again (a role changed here may be the reader's own). */
    onChanged: () => Promise<void> | void;
  }
  let { project, myUserId, onChanged }: Props = $props();

  // the page is made anew for each project (the route keys it on the id)
  // svelte-ignore state_referenced_locally
  const projectId = project.id;
  const list = createPagedList<ProjectMember>(async (p) => {
    const { members, nextCursor } = await projects.members(projectId, p);
    return { items: members, nextCursor };
  });
  $effect(() => {
    void list.load();
  });

  const members = $derived(list.items);
  const memberCount = $derived(list.nextCursor ? undefined : rowCount('members.countOne', 'members.count'));

  const canManage = $derived(projectCan.manageMembers(project));
  const canLeave = $derived(projectCan.leave(project, members, myUserId));

  async function changed() {
    await list.refresh();
    await onChanged();
  }

  // ── Add ────────────────────────────────────────────────────────────────
  let showAddDialog = $state(false);

  // ── Change role ────────────────────────────────────────────────────────
  let showRoleDialog = $state(false);
  let roleLoading = $state(false);
  let roleTarget = $state<ProjectMember | null>(null);
  let selectedRole = $state<ProjectRole>('viewer');

  function openRoleDialog(member: ProjectMember) {
    roleTarget = member;
    selectedRole = member.role;
    showRoleDialog = true;
  }

  async function submitRole() {
    if (!roleTarget) return;
    roleLoading = true;
    try {
      await projects.setMemberRole(projectId, roleTarget.userId, { role: selectedRole });
      toast.success(
        t('members.roleChanged', { email: roleTarget.email, role: projectRoleTag(selectedRole).label })
      );
      showRoleDialog = false;
      roleTarget = null;
    } catch (e) {
      toast.error(errorMessage(e, t('members.roleChangeFailed')));
    } finally {
      roleLoading = false;
      await changed();
    }
  }

  // ── Remove someone else ────────────────────────────────────────────────
  let showRemoveDialog = $state(false);
  let removeLoading = $state(false);
  let removeTarget = $state<ProjectMember | null>(null);

  function openRemoveDialog(member: ProjectMember) {
    removeTarget = member;
    showRemoveDialog = true;
  }

  async function submitRemove() {
    if (!removeTarget) return;
    removeLoading = true;
    try {
      await projects.removeMember(projectId, removeTarget.userId);
      toast.success(t('projects.memberRemovedToast', { email: removeTarget.email }));
      showRemoveDialog = false;
      removeTarget = null;
    } catch (e) {
      toast.error(errorMessage(e, t('projects.memberRemoveFailed')));
    } finally {
      removeLoading = false;
      await changed();
    }
  }

  // ── Leave: removing your own row ───────────────────────────────────────
  let showLeaveDialog = $state(false);
  let leaveLoading = $state(false);

  async function submitLeave() {
    leaveLoading = true;
    try {
      await projects.removeMember(projectId, myUserId);
      showLeaveDialog = false;
      toast.success(t('projects.leftToast', { name: project.name }));
      // the project may answer 404 from here on: the list is the place to be
      await goto('/projects');
    } catch (e) {
      toast.error(errorMessage(e, t('projects.leaveFailed')));
      await changed();
    } finally {
      leaveLoading = false;
    }
  }

  function rowActions(member: ProjectMember) {
    const actions: Array<{ label: string; onclick: () => void; variant?: 'default' | 'destructive' }> = [];
    const mine = member.userId === myUserId;
    if (canManage) {
      actions.push({ label: t('members.actionChangeRole'), onclick: () => openRoleDialog(member) });
      if (!mine) {
        actions.push({
          label: t('projects.actionRemove'),
          onclick: () => openRemoveDialog(member),
          variant: 'destructive'
        });
      }
    }
    if (mine && canLeave) {
      actions.push({
        label: t('projects.actionLeave'),
        onclick: () => (showLeaveDialog = true),
        variant: 'destructive'
      });
    }
    return actions;
  }

  const columns: ColumnDef<ProjectMember, unknown>[] = $derived([
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
      meta: { title: t('members.colName'), width: '28%' }
    },
    {
      accessorKey: 'role',
      header: ({ column }) => renderComponent(DataTableColumnHeader, { column, title: t('members.colRole') }),
      cell: ({ row }) => renderComponent(Tag, projectRoleTag(row.original.role)),
      meta: { title: t('members.colRole'), width: '140px' }
    },
    {
      accessorKey: 'createdAt',
      header: ({ column }) =>
        renderComponent(DataTableColumnHeader, { column, title: t('projects.colAdded') }),
      cell: ({ row }) => formatDate(row.getValue('createdAt') as string),
      meta: { title: t('projects.colAdded'), width: '130px' }
    },
    // A manager gets the column on every row. Anyone else gets it for the one
    // action they have, leaving, which sits on their own row alone.
    ...(canManage || canLeave
      ? [
          {
            id: 'actions',
            cell: ({ row }: { row: { original: ProjectMember } }) => {
              const actions = rowActions(row.original);
              return actions.length ? renderComponent(DataTableActions, { actions }) : '';
            },
            meta: { width: '60px' }
          } as ColumnDef<ProjectMember, unknown>
        ]
      : [])
  ]);
</script>

{#snippet addAction()}
  <Button onclick={() => (showAddDialog = true)} size="sm" class="h-8 gap-1.5">
    <Plus class="h-4 w-4" />
    {t('projects.addMember')}
  </Button>
{/snippet}

<section>
  <h2 class="font-display text-[19px] font-normal leading-tight tracking-[-0.01em]">
    {t('projects.membersTitle')}
  </h2>
  <p class="mb-4 mt-1 max-w-[62ch] text-sm text-muted-foreground">{t('projects.membersDescription')}</p>

  <FormError
    message={list.error && members.length ? t('common.refreshFailedCached', { error: list.error }) : null}
    class="pb-3"
  />
  {#if list.loading}
    <TableSkeleton columns={4} rows={3} />
  {:else if list.error && !members.length}
    <p class="text-sm text-destructive" in:appear>{t('members.loadFailed', { error: list.error })}</p>
  {:else}
    <DataTable
      data={members}
      {columns}
      searchColumns={['email', 'name']}
      searchPlaceholder={t('members.searchPlaceholder')}
      count={memberCount}
      actions={canManage ? addAction : undefined}
      emptyMessage={t('projects.membersEmpty')}
      showViewOptions={false}
      sticky={false}
    />
    {#if list.nextCursor}
      <div class="flex justify-center py-4" transition:reveal>
        <Button variant="outline" onclick={() => void list.loadMore()} disabled={list.loadingMore}>
          {list.loadingMore ? t('common.loading') : t('common.loadMore')}
        </Button>
      </div>
    {/if}
  {/if}
</section>

<AddProjectMemberDialog
  bind:open={showAddDialog}
  {projectId}
  alreadyIn={members.map((m) => m.userId)}
  onAdded={changed}
  onRefused={changed}
/>

<FormDialog
  bind:open={showRoleDialog}
  title={t('members.roleDialogTitle')}
  description={roleTarget ? t('projects.roleDialogDescription', { email: roleTarget.email }) : ''}
  onClose={() => {
    showRoleDialog = false;
    roleTarget = null;
  }}
  onSubmit={() => void submitRole()}
  loading={roleLoading}
  submitLabel={t('members.actionChangeRole')}
>
  <ProjectRoleSelect bind:value={selectedRole} id="project-member-role" />
</FormDialog>

<ConfirmDialog
  bind:open={showRemoveDialog}
  title={t('projects.removeConfirmTitle')}
  description={t('projects.removeConfirmDescription', { email: removeTarget?.email ?? '' })}
  confirmLabel={t('projects.actionRemove')}
  onClose={() => {
    showRemoveDialog = false;
    removeTarget = null;
  }}
  onConfirm={() => void submitRemove()}
  loading={removeLoading}
/>

<ConfirmDialog
  bind:open={showLeaveDialog}
  title={t('projects.leaveConfirmTitle')}
  description={t('projects.leaveConfirmDescription', { name: project.name })}
  confirmLabel={t('projects.actionLeave')}
  onClose={() => (showLeaveDialog = false)}
  onConfirm={() => void submitLeave()}
  loading={leaveLoading}
/>
