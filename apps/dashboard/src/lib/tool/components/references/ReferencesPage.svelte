<script lang="ts">
  /* The Brands and Templates sections (PRDCT-2421): one page, the type as a
     prop. The decks page's toolbar as is (the search on the title and the
     description, the count, the View menu with the cards-or-table choice kept
     per section, the add button that opens the command-line instructions),
     the references as cards or as a table, and the side sheet that opens on a
     card or a row. The list is the server's `type` filter; nothing here
     edition-sniffs, the page reads /me and the list answer. */
  import { type ColumnDef, type VisibilityState } from '@tanstack/table-core';
  import { renderComponent } from '$lib/components/ui/data-table/index.js';
  import HeroBand from '$lib/components/brand/HeroBand.svelte';
  import DataTable, { rowCount } from '$lib/components/shared/DataTable.svelte';
  import DataTableColumnHeader from '$lib/components/shared/DataTableColumnHeader.svelte';
  import TableToolbar from '$lib/components/shared/TableToolbar.svelte';
  import TableSkeleton from '$lib/components/shared/TableSkeleton.svelte';
  import DialogDrawing from '$lib/components/brand/DialogDrawing.svelte';
  import FormError from '$lib/components/shared/FormError.svelte';
  import ReferenceCard from './ReferenceCard.svelte';
  import ReferenceSheet from './ReferenceSheet.svelte';
  import ReferencePushInstructions from './ReferencePushInstructions.svelte';
  import { appear, reveal } from '$lib/components/ui/reveal/index.js';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
  import * as Card from '$lib/components/ui/card/index.js';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import Settings2 from '@lucide/svelte/icons/settings-2';
  import Plus from '@lucide/svelte/icons/plus';
  import { IsMobile } from '$lib/hooks/is-mobile.svelte';
  import { createPagedList } from '$lib/stores/pagedList.svelte';
  import { api } from '$lib/api';
  import { matchesQuery, readView, writeView, type ReferenceView } from '$lib/tool/references';
  import { formatTimeAgo } from '$lib/format';
  import { t } from '$lib/i18n';
  import type { MeResponse, Presentation, ReferenceType } from '@slideless/contract';

  interface Props {
    type: ReferenceType;
    me: MeResponse;
    instanceName: string;
  }

  let { type, me, instanceName }: Props = $props();

  const brand = $derived(type === 'brand');
  const title = $derived(brand ? t('nav.brands') : t('nav.templates'));

  // A guest reads no workspace reference and creates no deck (D2): the
  // sections are not in a guest's navigation, and the add button never shows.
  const isGuest = $derived(me.origin === 'guest');

  // the page is made anew for each type (brands, templates are two routes)
  // svelte-ignore state_referenced_locally
  const list = createPagedList<Presentation>(
    async (p) => {
      const { presentations, nextCursor } = await api.presentations({ ...p, type });
      return { items: presentations, nextCursor };
    },
    { remember: `references.${type}` }
  );
  $effect(() => {
    void list.load();
  });

  // A change made in the sheet (the audience, the default) is shown at once
  // from the server's answer, and the whole page is refreshed behind it: a
  // default set here clears the previous default's crown elsewhere.
  let overrides = $state<Record<string, Presentation>>({});
  const decks = $derived(list.items.map((d) => overrides[d.id] ?? d));
  async function changed(updated: Presentation) {
    overrides = { ...overrides, [updated.id]: updated };
    await list.refresh();
    if (!list.error) overrides = {};
  }

  // Cards or table, kept per section; a phone shows cards.
  const phone = new IsMobile();
  // the remembered choice, written over by the menu
  let chosen: ReferenceView = $derived(readView(type));
  function choose(view: string) {
    if (view !== 'cards' && view !== 'table') return;
    chosen = view;
    writeView(type, view);
  }
  const view = $derived(phone.current ? 'cards' : chosen);
  let columnVisibility = $state<VisibilityState>({});
  const columnShown = (id: string) => columnVisibility[id] !== false;

  let query = $state('');
  const shown = $derived(decks.filter((d) => matchesQuery(d, query)));
  const countLine = $derived(
    list.nextCursor
      ? undefined
      : rowCount(
          brand ? 'refs.countBrand' : 'refs.countTemplate',
          brand ? 'refs.countBrands' : 'refs.countTemplates'
        )(shown.length, decks.length)
  );
  let toolbarHeight = $state(0);

  function entering(node: HTMLElement) {
    node.dataset.entering = '';
    const timer = setTimeout(() => delete node.dataset.entering, 700);
    return { destroy: () => clearTimeout(timer) };
  }

  // The sheet: open on one reference, which stays the list's own object.
  let openId = $state<string | null>(null);
  let sheetOpen = $state(false);
  const selected = $derived(decks.find((d) => d.id === openId) ?? null);
  function open(deck: Presentation) {
    openId = deck.id;
    sheetOpen = true;
  }

  let showPushDialog = $state(false);

  const columns: ColumnDef<Presentation, unknown>[] = $derived([
    {
      accessorKey: 'title',
      header: ({ column }) => renderComponent(DataTableColumnHeader, { column, title: t('decks.colTitle') }),
      // SECURITY: titles are USER-AUTHORED; the plain string renders through
      // FlexRender's text interpolation, always escaped. Never {@html}.
      cell: ({ row }) => row.getValue('title'),
      meta: { title: t('decks.colTitle') }
    },
    {
      accessorKey: 'audience',
      header: ({ column }) =>
        renderComponent(DataTableColumnHeader, { column, title: t('refs.colAudience') }),
      cell: ({ row }) =>
        row.original.audience === 'workspace' ? t('refs.audienceWorkspace') : t('refs.audiencePrivate'),
      meta: { title: t('refs.colAudience'), width: '140px' }
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
      accessorKey: 'updatedAt',
      header: ({ column }) =>
        renderComponent(DataTableColumnHeader, { column, title: t('decks.colUpdated') }),
      cell: ({ row }) => formatTimeAgo(row.getValue('updatedAt') as string),
      meta: { title: t('decks.colUpdated'), width: '130px' }
    },
    {
      accessorKey: 'defaultReference',
      header: ({ column }) => renderComponent(DataTableColumnHeader, { column, title: t('refs.colDefault') }),
      cell: ({ row }) => (row.original.defaultReference ? t('refs.yes') : ''),
      meta: { title: t('refs.colDefault'), width: '100px' }
    }
  ]);
  const hideable = $derived(
    columns.filter((column) => 'accessorKey' in column && column.accessorKey !== 'title')
  );
  const columnId = (column: ColumnDef<Presentation, unknown>) =>
    'accessorKey' in column ? String(column.accessorKey) : (column.id ?? '');
</script>

<svelte:head>
  <title>{title} · {instanceName}</title>
</svelte:head>

<HeroBand drawing={brand ? 'orbits' : 'apollonian'} seed={brand ? 20260919 : 20260920}>
  <p class="hero-eyebrow">{t('nav.workspace')}</p>
  <h1 class="hero-title">{title}</h1>
  <p class="hero-lede">{brand ? t('refs.brandsDescription') : t('refs.templatesDescription')}</p>
</HeroBand>

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

{#snippet addButton()}
  {#if !isGuest}
    <Button size="sm" class="h-8 gap-1.5" onclick={() => (showPushDialog = true)}>
      <Plus class="h-4 w-4" />
      {brand ? t('refs.addBrand') : t('refs.addTemplate')}
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
  <p class="text-sm text-destructive" in:appear>{t('refs.loadFailed', { error: list.error })}</p>
{:else if !decks.length}
  <Card.Root class="mx-auto mt-6 max-w-xl">
    <Card.Header>
      <Card.Title class="text-base"
        >{brand ? t('refs.emptyBrandsTitle') : t('refs.emptyTemplatesTitle')}</Card.Title
      >
      <Card.Description>{brand ? t('refs.emptyBrandsBody') : t('refs.emptyTemplatesBody')}</Card.Description>
    </Card.Header>
    {#if !isGuest}
      <Card.Content>
        <ReferencePushInstructions {type} />
      </Card.Content>
    {/if}
  </Card.Root>
{:else}
  <div class="table-card mt-4">
    <TableToolbar
      searchPlaceholder={brand ? t('refs.searchBrands') : t('refs.searchTemplates')}
      bind:searchValue={query}
      count={countLine}
      view={viewMenu}
      actions={addButton}
      bind:height={toolbarHeight}
    />
    {#if view === 'cards'}
      <div in:appear>
        {#if shown.length}
          <div class="ref-grid grid gap-4 pt-3 sm:grid-cols-2 xl:grid-cols-3" use:entering>
            {#each shown as deck (deck.id)}
              <ReferenceCard {deck} selected={sheetOpen && deck.id === openId} onOpen={() => open(deck)} />
            {/each}
          </div>
        {:else}
          <p class="py-10 text-center text-sm text-muted-foreground">{t('refs.noMatch', { query })}</p>
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
          onRowClick={(deck) => open(deck)}
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

<ReferenceSheet deck={selected} {type} bind:open={sheetOpen} {me} onChanged={(d) => void changed(d)} />

{#snippet pushAside()}
  <Dialog.Illustration
    eyebrow={brand ? t('refs.pushAsideEyebrowBrand') : t('refs.pushAsideEyebrowTemplate')}
    caption={t('refs.pushAsideCaption')}
  >
    <DialogDrawing kind="push" />
  </Dialog.Illustration>
{/snippet}

<Dialog.Root bind:open={showPushDialog}>
  <Dialog.Content size="lg" aside={pushAside} framed>
    <Dialog.Header>
      <Dialog.Title>{brand ? t('refs.pushTitleBrand') : t('refs.pushTitleTemplate')}</Dialog.Title>
    </Dialog.Header>
    <Dialog.Body>
      <ReferencePushInstructions {type} />
    </Dialog.Body>
    <Dialog.Footer>
      <Button onclick={() => (showPushDialog = false)}>{t('common.done')}</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<style>
  /* the cards settle in one after the other, once, when the grid arrives */
  @media (prefers-reduced-motion: no-preference) {
    .ref-grid:global([data-entering]) > :global(*) {
      animation: ref-cell-in calc(var(--motion-duration) * 1.4) var(--motion-ease) backwards;
    }
    .ref-grid:global([data-entering]) > :global(:nth-child(2)) {
      animation-delay: 35ms;
    }
    .ref-grid:global([data-entering]) > :global(:nth-child(3)) {
      animation-delay: 70ms;
    }
    .ref-grid:global([data-entering]) > :global(:nth-child(n + 4)) {
      animation-delay: 105ms;
    }
  }
  @keyframes ref-cell-in {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
  }
</style>
