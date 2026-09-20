<script lang="ts">
  /* The projects of the workspace the reader may open, under one of three
     filters: the active ones, the archived ones, or all. The page holds the
     choice and the create dialog; this holds the rows. */
  import { goto } from '$app/navigation';
  import { type ColumnDef } from '@tanstack/table-core';
  import { renderComponent } from '$lib/components/ui/data-table/index.js';
  import DataTable, { rowCount } from '$lib/components/shared/DataTable.svelte';
  import DataTableColumnHeader from '$lib/components/shared/DataTableColumnHeader.svelte';
  import TableToolbar from '$lib/components/shared/TableToolbar.svelte';
  import TableSkeleton from '$lib/components/shared/TableSkeleton.svelte';
  import FormError from '$lib/components/shared/FormError.svelte';
  import ProjectNameCell from './ProjectNameCell.svelte';
  import * as Card from '$lib/components/ui/card/index.js';
  import * as Select from '$lib/components/ui/select/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import { Tag } from '$lib/components/ui/tag';
  import { appear, reveal } from '$lib/components/ui/reveal/index.js';
  import Plus from '@lucide/svelte/icons/plus';
  import { createPagedList } from '$lib/stores/pagedList.svelte';
  import { projects } from '$lib/projects/client';
  import type { Project, ProjectArchivedFilter } from '$lib/projects/types';
  import { projectRoleTag, stateTag } from '$lib/tags';
  import { formatTimeAgo } from '$lib/format';
  import { t } from '$lib/i18n';

  interface Props {
    filter: ProjectArchivedFilter;
    onFilter: (next: ProjectArchivedFilter) => void;
    onCreate: () => void;
  }
  let { filter, onFilter, onCreate }: Props = $props();

  // One list per filter, each remembered under its own name: coming back to a
  // filter opens on the rows it had, with no skeleton between the two.
  const list = $derived(
    createPagedList<Project>(
      async (p) => {
        const { projects: rows, nextCursor } = await projects.list({ ...p, archived: filter });
        return { items: rows, nextCursor };
      },
      { remember: `projects.${filter}` }
    )
  );
  $effect(() => {
    void list.load();
  });

  const rows = $derived(list.items);
  const count = $derived(list.nextCursor ? undefined : rowCount('projects.countOne', 'projects.count'));

  const filterLabel = (choice: ProjectArchivedFilter) =>
    choice === 'true'
      ? t('projects.filterArchived')
      : choice === 'all'
        ? t('projects.filterAll')
        : t('projects.filterActive');

  const columns: ColumnDef<Project, unknown>[] = $derived([
    {
      accessorKey: 'name',
      header: ({ column }) =>
        renderComponent(DataTableColumnHeader, { column, title: t('projects.colName') }),
      // SECURITY: the name and the description are USER-AUTHORED; the cell
      // renders both through text interpolation. Never {@html}.
      cell: ({ row }) =>
        renderComponent(ProjectNameCell, {
          name: row.original.name,
          description: row.original.description
        }),
      meta: { title: t('projects.colName') }
    },
    {
      accessorKey: 'myRole',
      header: ({ column }) =>
        renderComponent(DataTableColumnHeader, { column, title: t('projects.colMyRole') }),
      cell: ({ row }) => renderComponent(Tag, projectRoleTag(row.original.myRole)),
      meta: { title: t('projects.colMyRole'), width: '140px' }
    },
    {
      id: 'state',
      accessorFn: (project) => (project.archivedAt ? 1 : 0),
      header: ({ column }) =>
        renderComponent(DataTableColumnHeader, { column, title: t('projects.colState') }),
      cell: ({ row }) =>
        renderComponent(
          Tag,
          row.original.archivedAt
            ? stateTag(t('projects.stateArchived'), 'off')
            : stateTag(t('projects.stateActive'), 'ok')
        ),
      meta: { title: t('projects.colState'), width: '120px' }
    },
    {
      accessorKey: 'updatedAt',
      header: ({ column }) =>
        renderComponent(DataTableColumnHeader, { column, title: t('projects.colUpdated') }),
      cell: ({ row }) => formatTimeAgo(row.getValue('updatedAt') as string),
      meta: { title: t('projects.colUpdated'), width: '130px' }
    }
  ]);
</script>

<!-- the filter sits at the left of the toolbar, where the other tables keep
     theirs; the select says its own value, its name is for assistive technology -->
{#snippet filters()}
  <Label for="projects-filter" class="sr-only">{t('projects.filterLabel')}</Label>
  <Select.Root
    type="single"
    value={filter}
    onValueChange={(v) => {
      if (v === 'false' || v === 'true' || v === 'all') onFilter(v);
    }}
  >
    <Select.Trigger id="projects-filter" class="h-8 w-auto min-w-[130px] max-w-full">
      {filterLabel(filter)}
    </Select.Trigger>
    <Select.Content>
      <Select.Item value="false" label={filterLabel('false')} />
      <Select.Item value="true" label={filterLabel('true')} />
      <Select.Item value="all" label={filterLabel('all')} />
    </Select.Content>
  </Select.Root>
{/snippet}

{#snippet createAction()}
  <Button onclick={onCreate} size="sm" class="h-8 gap-1.5">
    <Plus class="h-4 w-4" />
    {t('projects.create')}
  </Button>
{/snippet}

<FormError
  message={list.error && rows.length ? t('common.refreshFailedCached', { error: list.error }) : null}
  class="pb-3"
/>
{#if list.loading}
  <TableSkeleton columns={4} />
{:else if list.error && !rows.length}
  <p class="text-sm text-destructive" in:appear>{t('projects.loadFailed', { error: list.error })}</p>
{:else if !rows.length}
  <!-- nothing to list: the toolbar stays, so the other filters stay in reach -->
  <div class="table-card">
    <TableToolbar {filters} actions={filter === 'true' ? createAction : undefined} sticky={false} />
  </div>
  {#if filter === 'true'}
    <p class="py-10 text-center text-sm text-muted-foreground" in:appear>{t('projects.emptyArchived')}</p>
  {:else}
    <div in:appear>
      <Card.Root class="mx-auto mt-6 max-w-xl">
        <Card.Header>
          <Card.Title class="text-base">{t('projects.emptyTitle')}</Card.Title>
          <Card.Description>{t('projects.emptyBody')}</Card.Description>
        </Card.Header>
        <Card.Content>
          <Button onclick={onCreate} size="sm" class="gap-1.5">
            <Plus class="h-4 w-4" />
            {t('projects.create')}
          </Button>
        </Card.Content>
      </Card.Root>
    </div>
  {/if}
{:else}
  <DataTable
    data={rows}
    {columns}
    searchColumns={['name']}
    searchPlaceholder={t('projects.searchPlaceholder')}
    {count}
    toolbar={filters}
    actions={createAction}
    showViewOptions={false}
    onRowClick={(project) => void goto(`/projects/${project.id}`)}
  />
  {#if list.nextCursor}
    <div class="flex justify-center py-4" transition:reveal>
      <Button variant="outline" onclick={() => void list.loadMore()} disabled={list.loadingMore}>
        {list.loadingMore ? t('common.loading') : t('common.loadMore')}
      </Button>
    </div>
  {/if}
{/if}
