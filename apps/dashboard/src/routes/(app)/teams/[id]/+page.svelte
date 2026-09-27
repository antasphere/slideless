<script lang="ts">
  /* One team (PRDCT-2813): its name and slug, and the workspace's people in
     it. Owners and admins of a workspace whose teams are the tool's own add
     and remove people here; everyone else reads. In a hub-origin workspace
     the team is the account site's projection: the page reads it and links
     to the team's page at Antasphere, where it is managed. A team the caller
     cannot read (another workspace's, a deleted one) is the calm 404. */
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
  import FormError from '$lib/components/shared/FormError.svelte';
  import * as Card from '$lib/components/ui/card/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import { appear, reveal } from '$lib/components/ui/reveal/index.js';
  import Plus from '@lucide/svelte/icons/plus';
  import ArrowLeft from '@lucide/svelte/icons/arrow-left';
  import Check from '@lucide/svelte/icons/check';
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import { page } from '$app/state';
  import { createPagedList } from '$lib/stores/pagedList.svelte';
  import { api, errorMessage } from '$lib/api';
  import { crumbs } from '$lib/crumbs.svelte';
  import { formatDate } from '$lib/format';
  import { hubLinkHere, hubTeamsPage } from '$lib/hub-links';
  import { peopleTabs } from '$lib/people-tabs';
  import { offeredMembers } from '$lib/projects/candidates';
  import { errorStatus } from '$lib/projects/errors';
  import { toast } from 'svelte-sonner';
  import { t } from '$lib/i18n';
  import type { Member, Team, TeamMemberInfo, WorkspaceRole } from '@antasphere/chassis-contract';

  let { data } = $props();

  const me = $derived(data.me);
  const teamId = $derived(data.teamId);
  const isAdmin = $derived(me.role === 'owner' || me.role === 'admin');
  // A hub-origin workspace reads the account site's teams: no change is made here.
  const hubManaged = $derived(me.workspace.hubOrigin);
  const canShape = $derived(isAdmin && !hubManaged);

  // ── The team itself: its name and slug ──
  let team = $state<Team | null>(null);
  let teamLoading = $state(true);
  let notFound = $state(false);
  let teamError = $state<string | null>(null);

  async function loadTeam(id: string) {
    teamError = null;
    try {
      team = await api.team(id);
      notFound = false;
    } catch (e) {
      // another workspace's team, a deleted one, or an id that is none (400)
      const status = errorStatus(e);
      if (status === 404 || status === 400) {
        team = null;
        notFound = true;
      } else if (!team) {
        teamError = errorMessage(e);
      } else {
        // the page keeps the last answer; say that the fresh one did not come
        toast.error(errorMessage(e));
      }
    } finally {
      teamLoading = false;
    }
  }

  $effect(() => {
    teamLoading = true;
    void loadTeam(teamId);
  });

  // the top bar's path: People / Teams / <the team> (the name is user-authored: text only)
  $effect(() => {
    crumbs.set(team ? [{ label: team.name }] : []);
    return () => crumbs.clear();
  });

  // ── The team's people ──────────────────────────────────────────────────
  const list = createPagedList<TeamMemberInfo>(async (p) => {
    const { members, nextCursor } = await api.teamMembers(teamId, p);
    return { items: members, nextCursor };
  });

  // keyed on the team: moving from one team's page to another's reloads the list
  $effect(() => {
    void teamId;
    void list.load();
  });

  const people = $derived(list.items);
  const peopleCount = $derived(
    list.nextCursor ? undefined : rowCount('teams.membersCountOne', 'teams.membersCount')
  );

  async function refreshAll() {
    await Promise.all([list.refresh(), loadTeam(teamId)]);
  }

  /** Every page of a cursor-paged list: the add dialog needs the whole roster, never its first page. */
  async function readAll<T>(
    fetchPage: (cursor?: string) => Promise<{ items: T[]; nextCursor: string | null }>
  ): Promise<T[]> {
    const all: T[] = [];
    let cursor: string | undefined;
    do {
      const next = await fetchPage(cursor);
      all.push(...next.items);
      cursor = next.nextCursor ?? undefined;
    } while (cursor);
    return all;
  }

  // ── Add a member: the workspace's active non-guest members not yet in the team ──
  let showAddDialog = $state(false);
  let addLoading = $state(false);
  let candidatesLoading = $state(false);
  let candidatesError = $state<string | null>(null);
  let roster = $state<Member[]>([]);
  let inTeam = $state<string[]>([]);
  let query = $state('');
  let pickedId = $state<string | null>(null);
  let addRefusal = $state<string | null>(null);

  const offered = $derived(offeredMembers(roster, inTeam, query));
  const picked = $derived(roster.find((m) => m.userId === pickedId) ?? null);

  async function openAddDialog() {
    roster = [];
    inTeam = [];
    query = '';
    pickedId = null;
    addRefusal = null;
    candidatesError = null;
    candidatesLoading = true;
    showAddDialog = true;
    try {
      const [workspaceMembers, teamMembers] = await Promise.all([
        readAll(async (cursor) => {
          const { members, nextCursor } = await api.members(cursor ? { cursor } : {});
          return { items: members, nextCursor };
        }),
        readAll(async (cursor) => {
          const { members, nextCursor } = await api.teamMembers(teamId, cursor ? { cursor } : {});
          return { items: members, nextCursor };
        })
      ]);
      roster = workspaceMembers;
      inTeam = teamMembers.map((m) => m.userId);
    } catch (e) {
      candidatesError = t('teams.candidatesFailed', { error: errorMessage(e) });
    } finally {
      candidatesLoading = false;
    }
  }

  async function submitAdd() {
    addRefusal = null;
    if (!team) return;
    if (!picked) {
      addRefusal = t('teams.addNeedsPick');
      return;
    }
    addLoading = true;
    try {
      await api.addTeamMember(teamId, { userId: picked.userId });
      toast.success(t('teams.memberAddedToast', { email: picked.email, name: team.name }));
      showAddDialog = false;
      await refreshAll();
    } catch (e) {
      addRefusal = errorMessage(e, t('teams.addFailed', { email: picked.email }));
    } finally {
      addLoading = false;
    }
  }

  // ── Remove ─────────────────────────────────────────────────────────────
  let showRemoveDialog = $state(false);
  let removeLoading = $state(false);
  let removeTarget = $state<TeamMemberInfo | null>(null);

  function openRemoveDialog(member: TeamMemberInfo) {
    removeTarget = member;
    showRemoveDialog = true;
  }

  async function submitRemove() {
    const target = removeTarget;
    if (!target || !team) return;
    removeLoading = true;
    try {
      await api.removeTeamMember(teamId, target.userId);
      toast.success(t('teams.memberRemovedToast', { email: target.email, name: team.name }));
      showRemoveDialog = false;
      removeTarget = null;
      await refreshAll();
    } catch (e) {
      toast.error(errorMessage(e, t('teams.removeFailed', { email: target.email })));
    } finally {
      removeLoading = false;
    }
  }

  const columns: ColumnDef<TeamMemberInfo, unknown>[] = $derived([
    {
      accessorKey: 'name',
      header: ({ column }) => renderComponent(DataTableColumnHeader, { column, title: t('teams.colName') }),
      cell: ({ row }) => row.original.name || '—',
      meta: { title: t('teams.colName') }
    },
    {
      accessorKey: 'email',
      header: ({ column }) => renderComponent(DataTableColumnHeader, { column, title: t('teams.colEmail') }),
      cell: ({ row }) => row.original.email,
      meta: { title: t('teams.colEmail') }
    },
    {
      accessorKey: 'role',
      header: ({ column }) => renderComponent(DataTableColumnHeader, { column, title: t('teams.colRole') }),
      cell: ({ row }) => renderComponent(Tag, roleTag(row.original.role as WorkspaceRole)),
      meta: { title: t('teams.colRole'), width: '110px' }
    },
    {
      accessorKey: 'isActive',
      header: ({ column }) => renderComponent(DataTableColumnHeader, { column, title: t('teams.colStatus') }),
      cell: ({ row }) =>
        renderComponent(
          Tag,
          row.original.isActive
            ? stateTag(t('members.statusActive'), 'ok')
            : stateTag(t('members.statusInactive'), 'off')
        ),
      meta: { title: t('teams.colStatus'), width: '110px' }
    },
    {
      accessorKey: 'addedAt',
      header: ({ column }) => renderComponent(DataTableColumnHeader, { column, title: t('teams.colAdded') }),
      cell: ({ row }) => formatDate(row.original.addedAt),
      meta: { title: t('teams.colAdded'), width: '130px' }
    },
    ...(canShape
      ? [
          {
            id: 'actions',
            cell: ({ row }: { row: { original: TeamMemberInfo } }) =>
              renderComponent(DataTableActions, {
                actions: [
                  {
                    label: t('teams.removeMember'),
                    onclick: () => openRemoveDialog(row.original),
                    variant: 'destructive' as const
                  }
                ]
              }),
            meta: { width: '60px' }
          } as ColumnDef<TeamMemberInfo, unknown>
        ]
      : [])
  ]);

  const tabs = $derived(peopleTabs(me, page.url.pathname));
</script>

<SectionHero
  eyebrow={t('teams.title')}
  title={team?.name ?? t('teams.title')}
  lede={team ? t('teams.membersDescription', { name: team.name }) : undefined}
  pageTitle={team?.name ?? t('teams.title')}
  {tabs}
  drawing="graph"
/>

<a
  href="/teams"
  class="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
>
  <ArrowLeft class="h-4 w-4" />
  {t('teams.back')}
</a>

{#if team}
  <p class="mb-4 font-mono text-xs text-muted-foreground" in:appear>{team.slug}</p>
{/if}

{#if hubManaged && team}
  <div class="notice mb-6 flex-wrap items-center justify-between gap-3 px-4 py-3" in:appear>
    <p class="min-w-0 text-sm">{t('teams.hubManagedNotice')}</p>
    {#if me.hubManageUrl}
      <Button
        variant="outline"
        size="sm"
        href={hubLinkHere(hubTeamsPage(me.hubManageUrl, team.hubTeamId))}
        target="_blank"
        rel="noopener noreferrer"
      >
        {t('teams.manageTeam')}
        <ExternalLink class="ml-2 h-3.5 w-3.5" />
      </Button>
    {/if}
  </div>
{/if}

{#snippet addAction()}
  <Button onclick={() => void openAddDialog()} size="sm" class="h-8 gap-1.5" disabled={!team}>
    <Plus class="h-4 w-4" />
    {t('teams.addMember')}
  </Button>
{/snippet}

{#if teamLoading && !team}
  <TableSkeleton columns={5} />
{:else if notFound}
  <!-- another workspace's team gets the same 404 as a wrong address, by design: a plain page -->
  <div in:appear>
    <Card.Root class="mx-auto mt-6 max-w-md">
      <Card.Header>
        <Card.Title class="text-base">{t('teams.notFoundTitle')}</Card.Title>
        <Card.Description>{t('teams.notFound')}</Card.Description>
      </Card.Header>
      <Card.Content>
        <Button variant="outline" href="/teams">
          <ArrowLeft class="mr-2 h-4 w-4" />
          {t('teams.back')}
        </Button>
      </Card.Content>
    </Card.Root>
  </div>
{:else if teamError && !team}
  <p class="text-sm text-destructive" in:appear>{teamError}</p>
{:else}
  <FormError
    message={list.error && people.length ? t('common.refreshFailedCached', { error: list.error }) : null}
    class="pb-3"
  />
  {#if list.loading}
    <TableSkeleton columns={5} />
  {:else if list.error && !people.length}
    <p class="text-sm text-destructive" in:appear>{t('teams.membersLoadFailed', { error: list.error })}</p>
  {:else}
    <DataTable
      data={people}
      {columns}
      searchColumns={['name', 'email']}
      searchPlaceholder={t('teams.membersSearchPlaceholder')}
      count={peopleCount}
      emptyMessage={t('teams.membersEmpty')}
      actions={canShape ? addAction : undefined}
    />
    {#if list.nextCursor}
      <div class="flex justify-center py-4" transition:reveal>
        <Button variant="outline" onclick={() => void list.loadMore()} disabled={list.loadingMore}>
          {list.loadingMore ? t('common.loading') : t('common.loadMore')}
        </Button>
      </div>
    {/if}
  {/if}
{/if}

<FormDialog
  bind:open={showAddDialog}
  title={t('teams.addTitle')}
  description={team ? t('teams.addDescription', { name: team.name }) : ''}
  onClose={() => (showAddDialog = false)}
  onSubmit={() => void submitAdd()}
  loading={addLoading || candidatesLoading}
  submitLabel={t('teams.addSubmit')}
>
  <div class="space-y-2">
    <Label for="team-add-search">{t('teams.addLabel')}</Label>
    {#if candidatesError}
      <FormError message={candidatesError} />
    {:else}
      <Input
        id="team-add-search"
        type="search"
        autocomplete="off"
        bind:value={query}
        placeholder={t('members.searchPlaceholder')}
      />
      <!-- the box keeps its height while the roster is on its way: nothing jumps -->
      <ul
        class="h-48 divide-y divide-[var(--hairline)] overflow-y-auto rounded-md border border-[var(--hairline)]"
        aria-label={t('teams.addLabel')}
        aria-busy={candidatesLoading}
      >
        {#each offered as person (person.userId)}
          {@const chosen = person.userId === pickedId}
          <li>
            <button
              type="button"
              class="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-[var(--ground-3)] focus-visible:bg-[var(--ground-3)] focus-visible:outline-none"
              aria-pressed={chosen}
              onclick={() => (pickedId = chosen ? null : person.userId)}
            >
              <!-- names and emails are USER-AUTHORED: text interpolation only -->
              <span class="min-w-0 flex-1">
                <span class="block truncate font-medium">{person.name || person.email}</span>
                {#if person.name}
                  <span class="block truncate text-xs text-muted-foreground">{person.email}</span>
                {/if}
              </span>
              {#if chosen}<Check class="h-4 w-4 shrink-0" strokeWidth={2.2} />{/if}
            </button>
          </li>
        {:else}
          {#if !candidatesLoading}
            <li class="px-3 py-8 text-center text-sm text-muted-foreground">
              {query.trim() ? t('teams.addNoMatch', { query: query.trim() }) : t('teams.noCandidates')}
            </li>
          {/if}
        {/each}
      </ul>
    {/if}
  </div>
  <FormError message={addRefusal} />
</FormDialog>

<ConfirmDialog
  bind:open={showRemoveDialog}
  title={t('teams.removeTitle')}
  description={removeTarget && team
    ? t('teams.removeConfirm', { email: removeTarget.email, name: team.name })
    : ''}
  confirmLabel={t('teams.removeMember')}
  onClose={() => {
    showRemoveDialog = false;
    removeTarget = null;
  }}
  onConfirm={() => void submitRemove()}
  loading={removeLoading}
/>
