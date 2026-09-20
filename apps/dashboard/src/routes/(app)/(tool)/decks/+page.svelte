<script lang="ts">
  import { goto } from '$app/navigation';
  import { type ColumnDef, type VisibilityState } from '@tanstack/table-core';
  import { renderComponent } from '$lib/components/ui/data-table/index.js';
  import HeroBand from '$lib/components/brand/HeroBand.svelte';
  import DataTable, { rowCount } from '$lib/components/shared/DataTable.svelte';
  import DataTableColumnHeader from '$lib/components/shared/DataTableColumnHeader.svelte';
  import TableToolbar from '$lib/components/shared/TableToolbar.svelte';
  import TableSkeleton from '$lib/components/shared/TableSkeleton.svelte';
  import PushInstructions from '$lib/tool/components/decks/PushInstructions.svelte';
  import DeckCard from '$lib/tool/components/decks/DeckCard.svelte';
  import ProjectFilter from '$lib/tool/components/projects/ProjectFilter.svelte';
  import DeckProjectTags from '$lib/tool/components/projects/DeckProjectTags.svelte';
  import DialogDrawing from '$lib/components/brand/DialogDrawing.svelte';
  import FormError from '$lib/components/shared/FormError.svelte';
  import { appear, reveal } from '$lib/components/ui/reveal/index.js';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
  import Settings2 from '@lucide/svelte/icons/settings-2';
  import Plus from '@lucide/svelte/icons/plus';
  import { IsMobile } from '$lib/hooks/is-mobile.svelte';
  import * as Card from '$lib/components/ui/card/index.js';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { createPagedList } from '$lib/stores/pagedList.svelte';
  import { kindLabel } from '$lib/tool/decks';
  import { deckProjects, isNotFound, type DeckWithProjects } from '$lib/tool/projects-client';
  import { createProjectFilter } from '$lib/tool/project-filter.svelte';
  import { formatTimeAgo } from '$lib/format';
  import { t } from '$lib/i18n';

  let { data } = $props();

  // Deck creation is guest-forbidden (D2): a per-deck collaborator pushes
  // to the decks they were invited to, never creates new ones here.
  const isGuest = $derived(data.me.origin === 'guest');

  // The project filter (PRDCT-2584), remembered across reloads and pages. The
  // list is made anew for each choice and remembered per choice; with no
  // filter it keeps the name `decks`, the one the shell warms. A remembered
  // project that is gone or no longer readable answers 404: the filter falls
  // back to all projects and forgets itself, without a word.
  const filter = createProjectFilter('decks');
  const list = $derived.by(() => {
    const projectId = filter.projectId;
    return createPagedList<DeckWithProjects>(
      async (p) => {
        try {
          const { presentations, nextCursor } = await deckProjects.decksOf(projectId, p);
          return { items: presentations, nextCursor };
        } catch (e) {
          if (projectId && isNotFound(e)) filter.forget();
          throw e;
        }
      },
      { remember: filter.listName('decks') }
    );
  });

  $effect(() => {
    void filter.load();
  });
  $effect(() => {
    void list.load();
  });

  const decks = $derived(list.items);

  // Cards are how a deck is shown (PRDCT-2437); the table stays as a desk
  // option for whoever sorts by column, and a phone never gets it. The
  // choice is the first group of the toolbar's View menu, the same outline
  // button every table carries; with the table chosen the menu's second
  // group is the table's own column toggles, bound to the table.
  const VIEW_KEY = 'slideless.decks.view';
  const phone = new IsMobile();
  let chosen = $state<'cards' | 'table'>('cards');
  $effect(() => {
    try {
      if (localStorage.getItem(VIEW_KEY) === 'table') chosen = 'table';
    } catch {
      /* privacy modes: cards */
    }
  });
  function choose(view: string) {
    if (view !== 'cards' && view !== 'table') return;
    chosen = view;
    try {
      localStorage.setItem(VIEW_KEY, view);
    } catch {
      /* not persisted, still applied */
    }
  }
  const view = $derived(phone.current ? 'cards' : chosen);
  let columnVisibility = $state<VisibilityState>({});
  const columnShown = (id: string) => columnVisibility[id] !== false;

  // One search for both views, and the count beside it: how many decks, or
  // how many of how many while the search filters.
  let query = $state('');
  const shown = $derived(
    query.trim() ? decks.filter((d) => d.title.toLowerCase().includes(query.trim().toLowerCase())) : decks
  );
  const countLine = $derived(
    list.nextCursor ? undefined : rowCount('decks.countOne', 'decks.count')(shown.length, decks.length)
  );
  // the toolbar sits above the table too: the column header sticks under it
  let toolbarHeight = $state(0);

  // The grid's cards settle in one after the other when the grid ARRIVES (the
  // page loads, the view switches). The mark is lifted once that is over, so
  // a card a search brings back, or a further page, just appears.
  function entering(node: HTMLElement) {
    node.dataset.entering = '';
    const timer = setTimeout(() => delete node.dataset.entering, 700);
    return { destroy: () => clearTimeout(timer) };
  }

  // "New deck" is instructions, not an upload form — decks arrive via push.
  let showPushDialog = $state(false);

  const columns: ColumnDef<DeckWithProjects, unknown>[] = $derived([
    {
      accessorKey: 'title',
      header: ({ column }) => renderComponent(DataTableColumnHeader, { column, title: t('decks.colTitle') }),
      // SECURITY: deck titles are USER-AUTHORED. Returning the plain string
      // renders through FlexRender's `{result}` text interpolation — always
      // escaped. Never wrap this value in createRawSnippet / {@html}.
      cell: ({ row }) => row.getValue('title'),
      meta: { title: t('decks.colTitle') }
    },
    {
      accessorKey: 'kind',
      header: ({ column }) => renderComponent(DataTableColumnHeader, { column, title: t('decks.colKind') }),
      cell: ({ row }) =>
        `${kindLabel(row.original.kind)}${row.original.interactive ? ` · ${t('decks.badgeInteractive')}` : ''}`,
      meta: { title: t('decks.colKind'), width: '160px' }
    },
    {
      id: 'projects',
      header: () => t('deckProjects.colProjects'),
      // SECURITY: project names are USER-AUTHORED; the tags render them as text.
      cell: ({ row }) => renderComponent(DeckProjectTags, { deck: row.original }),
      meta: { title: t('deckProjects.colProjects'), width: '200px' }
    },
    {
      accessorKey: 'currentVersion',
      header: ({ column }) =>
        renderComponent(DataTableColumnHeader, { column, title: t('decks.colVersion') }),
      cell: ({ row }) =>
        row.original.currentVersion > 0 ? `v${row.original.currentVersion}` : t('decks.noVersions'),
      meta: { title: t('decks.colVersion'), width: '110px' }
    },
    {
      accessorKey: 'totalViews',
      header: ({ column }) => renderComponent(DataTableColumnHeader, { column, title: t('decks.colViews') }),
      cell: ({ row }) => String(row.original.totalViews),
      meta: { title: t('decks.colViews'), width: '90px' }
    },
    {
      accessorKey: 'updatedAt',
      header: ({ column }) =>
        renderComponent(DataTableColumnHeader, { column, title: t('decks.colUpdated') }),
      cell: ({ row }) => formatTimeAgo(row.getValue('updatedAt') as string),
      meta: { title: t('decks.colUpdated'), width: '130px' }
    }
  ]);
  const columnId = (column: ColumnDef<DeckWithProjects, unknown>) =>
    'accessorKey' in column ? String(column.accessorKey) : (column.id ?? '');
  // the columns a reader may hide: every one but the title
  const hideable = $derived(columns.filter((column) => columnId(column) !== 'title'));
</script>

<!-- the page opens as the overview and the brands do: on a field, the
     page's name and its sentence on it -->
<HeroBand drawing="apollonian" seed={20260918}>
  <p class="hero-eyebrow">{t('nav.workspace')}</p>
  <h1 class="hero-title">{t('decks.title')}</h1>
  <p class="hero-lede">{t('decks.description')}</p>
</HeroBand>

<!-- The View button: cards or table first; with the table, its columns.
     A desk control: a phone shows cards and has no columns to toggle. -->
{#snippet viewMenu()}
  {#if !phone.current}
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        {#snippet child({ props })}
          <Button variant="outline" size="sm" class="h-8" {...props}>
            <Settings2 class="mr-2 h-4 w-4" />
            {t('table.view')}
          </Button>
        {/snippet}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="end" class="min-w-[176px]">
        <DropdownMenu.Label>{t('decks.viewAs')}</DropdownMenu.Label>
        <DropdownMenu.RadioGroup value={view} onValueChange={choose}>
          <DropdownMenu.RadioItem value="cards">{t('decks.viewCards')}</DropdownMenu.RadioItem>
          <DropdownMenu.RadioItem value="table">{t('decks.viewTable')}</DropdownMenu.RadioItem>
        </DropdownMenu.RadioGroup>
        {#if view === 'table'}
          <DropdownMenu.Separator />
          <DropdownMenu.Label>{t('table.columns')}</DropdownMenu.Label>
          {#each hideable as column (columnId(column))}
            {@const id = columnId(column)}
            <DropdownMenu.CheckboxItem
              checked={columnShown(id)}
              closeOnSelect={false}
              onCheckedChange={(value) => (columnVisibility = { ...columnVisibility, [id]: !!value })}
            >
              {column.meta?.title ?? id}
            </DropdownMenu.CheckboxItem>
          {/each}
        {/if}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  {/if}
{/snippet}

{#snippet projectFilter()}
  <ProjectFilter {filter} id="decks-project-filter" />
{/snippet}

{#snippet newDeck()}
  {#if !isGuest}
    <Button size="sm" class="h-8 gap-1.5" onclick={() => (showPushDialog = true)}>
      <Plus class="h-4 w-4" />
      {t('decks.newDeck')}
    </Button>
  {/if}
{/snippet}

<FormError
  message={list.error && decks.length ? t('common.refreshFailedCached', { error: list.error }) : null}
  class="pb-3"
/>
{#if list.loading}
  <TableSkeleton columns={5} />
{:else if list.error && !decks.length}
  <p class="text-sm text-destructive" in:appear>{t('decks.loadFailed', { error: list.error })}</p>
{:else if !decks.length && !filter.projectId}
  <Card.Root class="mx-auto mt-6 max-w-xl">
    <Card.Header>
      <Card.Title class="text-base">{t('decks.emptyTitle')}</Card.Title>
      <Card.Description>{t('decks.emptyBody')}</Card.Description>
    </Card.Header>
    {#if !isGuest}
      <Card.Content>
        <PushInstructions />
      </Card.Content>
    {/if}
  </Card.Root>
{:else}
  <!-- the one toolbar over both views, the shape every table has -->
  <div class="table-card mt-4">
    <TableToolbar
      searchPlaceholder={t('decks.searchPlaceholder')}
      bind:searchValue={query}
      count={decks.length ? countLine : undefined}
      filters={projectFilter}
      view={viewMenu}
      actions={newDeck}
      bind:height={toolbarHeight}
    />
    {#if !decks.length}
      <!-- a project with no deck: the toolbar stays, so the filter can be changed -->
      <p class="py-10 text-center text-sm text-muted-foreground" in:appear>
        {t('deckProjects.emptyDecks')}
      </p>
    {:else if view === 'cards'}
      <div in:appear>
        {#if shown.length}
          <div class="deck-grid grid gap-4 sm:grid-cols-2 xl:grid-cols-3" use:entering>
            {#each shown as deck (deck.id)}
              <DeckCard {deck} />
            {/each}
          </div>
        {:else}
          <p class="py-10 text-center text-sm text-muted-foreground">{t('decks.noMatch', { query })}</p>
        {/if}
      </div>
    {:else}
      <div in:appear>
        <DataTable
          data={shown}
          {columns}
          bind:columnVisibility
          showViewOptions={false}
          stickyOffset={toolbarHeight}
          onRowClick={(deck) => void goto(`/decks/${deck.id}`)}
        />
      </div>
    {/if}
  </div>
  {#if list.nextCursor}
    <div class="flex justify-center py-4" transition:reveal>
      <Button variant="outline" onclick={() => void list.loadMore()} disabled={list.loadingMore}>
        {list.loadingMore ? t('common.loading') : t('common.loadMore')}
      </Button>
    </div>
  {/if}
{/if}

{#snippet pushAside()}
  <Dialog.Illustration eyebrow={t('decks.pushAsideEyebrow')} caption={t('decks.pushAsideCaption')}>
    <DialogDrawing kind="push" />
  </Dialog.Illustration>
{/snippet}

<Dialog.Root bind:open={showPushDialog}>
  <Dialog.Content size="lg" aside={pushAside} framed>
    <Dialog.Header>
      <Dialog.Title>{t('decks.pushTitle')}</Dialog.Title>
    </Dialog.Header>
    <Dialog.Body>
      <PushInstructions />
    </Dialog.Body>
    <Dialog.Footer>
      <Button onclick={() => (showPushDialog = false)}>{t('common.done')}</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<style>
  /* the cards settle in one after the other, once, when the grid arrives; a
     search or a further page never replays it (see `entering`) */
  @media (prefers-reduced-motion: no-preference) {
    .deck-grid:global([data-entering]) > :global(*) {
      animation: deck-cell-in calc(var(--motion-duration) * 1.4) var(--motion-ease) backwards;
    }
    .deck-grid:global([data-entering]) > :global(:nth-child(2)) {
      animation-delay: 35ms;
    }
    .deck-grid:global([data-entering]) > :global(:nth-child(3)) {
      animation-delay: 70ms;
    }
    .deck-grid:global([data-entering]) > :global(:nth-child(4)) {
      animation-delay: 105ms;
    }
    .deck-grid:global([data-entering]) > :global(:nth-child(5)) {
      animation-delay: 140ms;
    }
    .deck-grid:global([data-entering]) > :global(:nth-child(n + 6)) {
      animation-delay: 175ms;
    }
  }
  @keyframes deck-cell-in {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
  }
</style>
