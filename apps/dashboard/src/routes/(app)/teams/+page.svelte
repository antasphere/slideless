<script lang="ts">
  import { Tag } from '$lib/components/ui/tag';
  import { stateTag } from '$lib/tags';
  import { type ColumnDef } from '@tanstack/table-core';
  import { renderComponent, renderSnippet } from '$lib/components/ui/data-table/index.js';
  import SectionHero from '$lib/components/shared/SectionHero.svelte';
  import DataTable, { rowCount } from '$lib/components/shared/DataTable.svelte';
  import DataTableColumnHeader from '$lib/components/shared/DataTableColumnHeader.svelte';
  import DataTableActions from '$lib/components/shared/DataTableActions.svelte';
  import TableSkeleton from '$lib/components/shared/TableSkeleton.svelte';
  import FormDialog from '$lib/components/shared/FormDialog.svelte';
  import ConfirmDialog from '$lib/components/shared/ConfirmDialog.svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import { appear, reveal } from '$lib/components/ui/reveal/index.js';
  import FormError from '$lib/components/shared/FormError.svelte';
  import Plus from '@lucide/svelte/icons/plus';
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import { createPagedList } from '$lib/stores/pagedList.svelte';
  import { api, errorMessage, PlatformApiError } from '$lib/api';
  import { formatDate } from '$lib/format';
  import { toast } from 'svelte-sonner';
  import { t } from '$lib/i18n';
  import { peopleTabs } from '$lib/people-tabs';
  import { hubLinkHere, hubTeamsPage } from '$lib/hub-links';
  import { teamSlugSchema, type Team, type TeamUpdate } from '@antasphere/chassis-contract';

  let { data } = $props();

  const me = $derived(data.me);
  // Owners and admins make and shape teams; every member reads them.
  const isAdmin = $derived(me.role === 'owner' || me.role === 'admin');
  // PRDCT-2813: teams are the tool's on both editions, only the source differs.
  // A hub-origin workspace reads the account site's teams: the list stays a
  // real read, every change is made there (the API answers hub_managed).
  const hubManaged = $derived(me.workspace.hubOrigin);
  const canShape = $derived(isAdmin && !hubManaged);

  const list = createPagedList<Team>(
    async (p) => {
      const { teams, nextCursor } = await api.teams(p);
      return { items: teams, nextCursor };
    },
    { remember: 'teams' }
  );

  $effect(() => {
    void list.load();
  });

  const teams = $derived(list.items);
  // the toolbar's quiet line: how many teams, once they are all here
  const teamCount = $derived(list.nextCursor ? undefined : rowCount('teams.countOne', 'teams.count'));

  /** The slug field's own answer: empty is fine where the slug is optional, anything else must pass the contract's rule. */
  function slugProblem(slug: string): string | null {
    if (!slug) return null;
    return teamSlugSchema.safeParse(slug).success ? null : t('teams.slugInvalid');
  }

  /** The server's refusal of a slug another team holds: shown in the dialog, never as a toast. */
  function isSlugTaken(e: unknown): boolean {
    return e instanceof PlatformApiError && (e.code === 'slug_taken' || e.status === 409);
  }

  // ── New team ───────────────────────────────────────────────────────────
  let showCreateDialog = $state(false);
  let createLoading = $state(false);
  let createName = $state('');
  let createSlug = $state('');
  let createSlugError = $state<string | null>(null);

  function openCreateDialog() {
    createName = '';
    createSlug = '';
    createSlugError = null;
    showCreateDialog = true;
  }

  async function submitCreate() {
    const slug = createSlug.trim();
    createSlugError = slugProblem(slug);
    if (createSlugError) return;
    createLoading = true;
    try {
      const team = await api.createTeam({ name: createName.trim(), ...(slug ? { slug } : {}) });
      toast.success(t('teams.createdToast', { name: team.name }));
      showCreateDialog = false;
      await list.refresh();
    } catch (e) {
      if (isSlugTaken(e)) {
        createSlugError = t('teams.slugTaken');
        return;
      }
      toast.error(errorMessage(e, t('teams.createFailed')));
    } finally {
      createLoading = false;
    }
  }

  // ── Rename ─────────────────────────────────────────────────────────────
  let showRenameDialog = $state(false);
  let renameLoading = $state(false);
  let renameTarget = $state<Team | null>(null);
  let renameName = $state('');
  let renameSlug = $state('');
  let renameSlugError = $state<string | null>(null);

  function openRenameDialog(team: Team) {
    renameTarget = team;
    renameName = team.name;
    renameSlug = team.slug;
    renameSlugError = null;
    showRenameDialog = true;
  }

  async function submitRename() {
    if (!renameTarget) return;
    const name = renameName.trim();
    const slug = renameSlug.trim();
    // The slug stays required here: a team always has one, the field only changes it.
    renameSlugError = slug ? slugProblem(slug) : t('teams.slugInvalid');
    if (renameSlugError) return;
    const patch: TeamUpdate = {
      ...(name !== renameTarget.name ? { name } : {}),
      ...(slug !== renameTarget.slug ? { slug } : {})
    };
    if (patch.name === undefined && patch.slug === undefined) {
      showRenameDialog = false;
      renameTarget = null;
      return;
    }
    renameLoading = true;
    try {
      const team = await api.updateTeam(renameTarget.id, patch);
      toast.success(t('teams.renamedToast', { name: team.name }));
      showRenameDialog = false;
      renameTarget = null;
      await list.refresh();
    } catch (e) {
      if (isSlugTaken(e)) {
        renameSlugError = t('teams.slugTaken');
        return;
      }
      toast.error(errorMessage(e, t('teams.renameFailed')));
    } finally {
      renameLoading = false;
    }
  }

  // ── Delete ─────────────────────────────────────────────────────────────
  let showDeleteDialog = $state(false);
  let deleteLoading = $state(false);
  let deleteTarget = $state<Team | null>(null);

  function openDeleteDialog(team: Team) {
    deleteTarget = team;
    showDeleteDialog = true;
  }

  async function submitDelete() {
    if (!deleteTarget) return;
    deleteLoading = true;
    try {
      await api.deleteTeam(deleteTarget.id);
      toast.success(t('teams.deletedToast', { name: deleteTarget.name }));
      showDeleteDialog = false;
      deleteTarget = null;
      await list.refresh();
    } catch (e) {
      toast.error(errorMessage(e, t('common.deleteFailed')));
    } finally {
      deleteLoading = false;
    }
  }

  function rowActions(team: Team) {
    return [
      { label: t('teams.rename'), onclick: () => openRenameDialog(team) },
      { label: t('teams.delete'), onclick: () => openDeleteDialog(team), variant: 'destructive' as const }
    ];
  }

  const columns: ColumnDef<Team, unknown>[] = $derived([
    {
      accessorKey: 'name',
      header: ({ column }) => renderComponent(DataTableColumnHeader, { column, title: t('teams.name') }),
      cell: ({ row }) => renderSnippet(nameCell, row.original),
      meta: { title: t('teams.name') }
    },
    {
      // searchable by slug too, never shown as its own column
      accessorKey: 'slug',
      enableHiding: false
    },
    {
      accessorKey: 'membersCount',
      header: ({ column }) => renderComponent(DataTableColumnHeader, { column, title: t('teams.members') }),
      cell: ({ row }) => String(row.original.membersCount),
      meta: { title: t('teams.members'), width: '110px' }
    },
    {
      accessorKey: 'isMember',
      header: ({ column }) => renderComponent(DataTableColumnHeader, { column, title: t('teams.yours') }),
      cell: ({ row }) =>
        row.original.isMember ? renderComponent(Tag, stateTag(t('teams.yours'), 'ok')) : '',
      meta: { title: t('teams.yours'), width: '110px' }
    },
    {
      accessorKey: 'createdAt',
      header: ({ column }) => renderComponent(DataTableColumnHeader, { column, title: t('teams.created') }),
      cell: ({ row }) => formatDate(row.getValue('createdAt') as string),
      meta: { title: t('teams.created'), width: '130px' }
    },
    ...(canShape
      ? [
          {
            id: 'actions',
            cell: ({ row }: { row: { original: Team } }) =>
              renderComponent(DataTableActions, { actions: rowActions(row.original) }),
            meta: { width: '60px' }
          } as ColumnDef<Team, unknown>
        ]
      : [])
  ]);

  // the slug column exists for the search only: the name cell shows it under the name
  let columnVisibility = $state({ slug: false });

  const tabs = $derived(peopleTabs(me));
</script>

{#snippet nameCell(team: Team)}
  <a href={`/teams/${encodeURIComponent(team.id)}`} class="group flex flex-col gap-0.5">
    <span class="font-medium group-hover:underline group-hover:underline-offset-4">{team.name}</span>
    <span class="font-mono text-xs text-muted-foreground">{team.slug}</span>
  </a>
{/snippet}

<SectionHero
  eyebrow={t('nav.workspace')}
  title={t('nav.people')}
  lede={t('teams.description')}
  pageTitle={t('teams.title')}
  {tabs}
  drawing="graph"
/>

{#if hubManaged}
  <div class="notice mb-6 flex-wrap items-center justify-between gap-3 px-4 py-3" in:appear>
    <p class="min-w-0 text-sm">{t('teams.hubManagedNotice')}</p>
    {#if me.hubManageUrl}
      <Button
        variant="outline"
        size="sm"
        href={hubLinkHere(hubTeamsPage(me.hubManageUrl))}
        target="_blank"
        rel="noopener noreferrer"
      >
        {t('teams.hubManagedCta')}
        <ExternalLink class="ml-2 h-3.5 w-3.5" />
      </Button>
    {/if}
  </div>
{/if}

{#snippet newTeamAction()}
  <Button onclick={openCreateDialog} size="sm" class="h-8 gap-1.5">
    <Plus class="h-4 w-4" />
    {t('teams.new')}
  </Button>
{/snippet}

<FormError
  message={list.error && teams.length ? t('common.refreshFailedCached', { error: list.error }) : null}
  class="pb-3"
/>
{#if list.loading}
  <TableSkeleton columns={4} />
{:else if list.error && !teams.length}
  <p class="text-sm text-destructive" in:appear>{t('teams.loadFailed', { error: list.error })}</p>
{:else}
  <DataTable
    data={teams}
    {columns}
    bind:columnVisibility
    searchColumns={['name', 'slug']}
    searchPlaceholder={t('teams.searchPlaceholder')}
    count={teamCount}
    emptyMessage={canShape ? t('teams.emptyAdmin') : t('teams.empty')}
    actions={canShape ? newTeamAction : undefined}
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
  bind:open={showCreateDialog}
  title={t('teams.createTitle')}
  description={t('teams.createDescription')}
  onClose={() => (showCreateDialog = false)}
  onSubmit={() => void submitCreate()}
  loading={createLoading}
  submitLabel={t('teams.createSubmit')}
>
  <div class="space-y-2">
    <Label for="team-name">{t('teams.name')}</Label>
    <Input
      id="team-name"
      bind:value={createName}
      placeholder={t('teams.namePlaceholder')}
      maxlength={80}
      autocomplete="off"
      required
    />
  </div>
  <div class="space-y-2">
    <Label for="team-slug">{t('teams.slug')}</Label>
    <Input
      id="team-slug"
      class="font-mono"
      bind:value={createSlug}
      oninput={() => (createSlugError = null)}
      maxlength={60}
      autocomplete="off"
      aria-invalid={createSlugError ? true : undefined}
    />
    {#if createSlugError}
      <FormError message={createSlugError} />
    {:else}
      <p class="text-xs text-muted-foreground">{t('teams.slugOptionalHint')}</p>
    {/if}
  </div>
</FormDialog>

<FormDialog
  bind:open={showRenameDialog}
  title={t('teams.renameTitle')}
  description={renameTarget ? t('teams.renameDescription', { name: renameTarget.name }) : ''}
  onClose={() => {
    showRenameDialog = false;
    renameTarget = null;
  }}
  onSubmit={() => void submitRename()}
  loading={renameLoading}
  submitLabel={t('common.save')}
>
  <div class="space-y-2">
    <Label for="team-rename-name">{t('teams.name')}</Label>
    <Input id="team-rename-name" bind:value={renameName} maxlength={80} autocomplete="off" required />
  </div>
  <div class="space-y-2">
    <Label for="team-rename-slug">{t('teams.slug')}</Label>
    <Input
      id="team-rename-slug"
      class="font-mono"
      bind:value={renameSlug}
      oninput={() => (renameSlugError = null)}
      maxlength={60}
      autocomplete="off"
      aria-invalid={renameSlugError ? true : undefined}
      required
    />
    {#if renameSlugError}
      <FormError message={renameSlugError} />
    {:else}
      <p class="text-xs text-muted-foreground">{t('teams.slugHint')}</p>
    {/if}
  </div>
</FormDialog>

<ConfirmDialog
  bind:open={showDeleteDialog}
  title={t('teams.deleteTitle')}
  description={deleteTarget
    ? t(deleteTarget.membersCount === 1 ? 'teams.deleteConfirmOne' : 'teams.deleteConfirm', {
        name: deleteTarget.name,
        count: deleteTarget.membersCount
      })
    : ''}
  confirmLabel={t('teams.delete')}
  onClose={() => {
    showDeleteDialog = false;
    deleteTarget = null;
  }}
  onConfirm={() => void submitDelete()}
  loading={deleteLoading}
/>
