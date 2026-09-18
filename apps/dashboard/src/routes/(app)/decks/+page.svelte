<script lang="ts">
  import { goto } from '$app/navigation';
  import { type ColumnDef } from '@tanstack/table-core';
  import { renderComponent } from '$lib/components/ui/data-table/index.js';
  import PageHeader from '$lib/components/shared/PageHeader.svelte';
  import DataTable from '$lib/components/shared/DataTable.svelte';
  import DataTableColumnHeader from '$lib/components/shared/DataTableColumnHeader.svelte';
  import TableSkeleton from '$lib/components/shared/TableSkeleton.svelte';
  import PushInstructions from '$lib/components/decks/PushInstructions.svelte';
  import DeckCard from '$lib/components/decks/DeckCard.svelte';
  import DialogDrawing from '$lib/components/decks/drawings/DialogDrawing.svelte';
  import FormError from '$lib/components/shared/FormError.svelte';
  import { appear, reveal } from '$lib/components/ui/reveal/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import LayoutGrid from '@lucide/svelte/icons/layout-grid';
  import Rows3 from '@lucide/svelte/icons/rows-3';
  import { IsMobile } from '$lib/hooks/is-mobile.svelte';
  import * as Card from '$lib/components/ui/card/index.js';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { createPagedList } from '$lib/stores/pagedList.svelte';
  import { api } from '$lib/api';
  import { kindLabel } from '$lib/decks';
  import { formatTimeAgo } from '$lib/format';
  import { t } from '$lib/i18n';
  import type { Presentation } from '@slideless/contract';

  let { data } = $props();

  // Deck creation is guest-forbidden (D2): a per-deck collaborator pushes
  // to the decks they were invited to, never creates new ones here.
  const isGuest = $derived(data.me.origin === 'guest');

  const list = createPagedList<Presentation>(async (p) => {
    const { presentations, nextCursor } = await api.presentations(p);
    return { items: presentations, nextCursor };
  });

  $effect(() => {
    void list.load();
  });

  const decks = $derived(list.items);

  // Cards are how a deck is shown (PRDCT-2437); the table stays as a desk
  // option for whoever sorts by column, and a phone never gets it.
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
  function choose(view: 'cards' | 'table') {
    chosen = view;
    try {
      localStorage.setItem(VIEW_KEY, view);
    } catch {
      /* not persisted, still applied */
    }
  }
  const view = $derived(phone.current ? 'cards' : chosen);

  let query = $state('');
  const shown = $derived(
    query.trim() ? decks.filter((d) => d.title.toLowerCase().includes(query.trim().toLowerCase())) : decks
  );

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

  const columns: ColumnDef<Presentation, unknown>[] = $derived([
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
</script>

<PageHeader
  title={t('decks.title')}
  description={t('decks.description')}
  onAdd={isGuest ? undefined : () => (showPushDialog = true)}
  addLabel={t('decks.newDeck')}
/>

<FormError
  message={list.error && decks.length ? t('common.refreshFailedCached', { error: list.error }) : null}
  class="pb-3"
/>
{#if list.loading}
  <TableSkeleton columns={5} />
{:else if list.error && !decks.length}
  <p class="text-sm text-destructive" in:appear>{t('decks.loadFailed', { error: list.error })}</p>
{:else if !decks.length}
  <Card.Root class="mx-auto max-w-xl">
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
  <!-- one search and one switch for both views, in one row that never moves -->
  <div class="mb-5 flex items-center gap-3">
    <Input
      type="search"
      bind:value={query}
      placeholder={t('decks.searchPlaceholder')}
      class="h-10 max-w-sm flex-1 md:h-9"
    />
    <div class="view-toggle ml-auto" role="group" aria-label={t('decks.viewAs')}>
      <button
        type="button"
        class:on={view === 'cards'}
        aria-pressed={view === 'cards'}
        onclick={() => choose('cards')}
      >
        <LayoutGrid class="size-4" /><span class="sr-only">{t('decks.viewCards')}</span>
      </button>
      <button
        type="button"
        class:on={view === 'table'}
        aria-pressed={view === 'table'}
        onclick={() => choose('table')}
      >
        <Rows3 class="size-4" /><span class="sr-only">{t('decks.viewTable')}</span>
      </button>
    </div>
  </div>
  {#if view === 'cards'}
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
      <DataTable data={shown} {columns} onRowClick={(deck) => void goto(`/decks/${deck.id}`)} />
    </div>
  {/if}
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
  /* the cards-or-table switch is a desk control: it floats at the right of
     the search row, and a phone never sees it */
  .view-toggle {
    display: none;
  }
  @media (min-width: 768px) {
    .view-toggle {
      display: inline-flex;
      gap: 2px;
      padding: 3px;
      border: 1px solid var(--hairline);
      border-radius: var(--r-btn);
      background: var(--ground-2);
    }
  }
  .view-toggle button {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 28px;
    border-radius: calc(var(--r-btn) - 3px);
    color: var(--muted);
  }
  .view-toggle button.on {
    background: var(--ground);
    color: var(--ink);
    box-shadow: var(--shadow-sm);
  }
</style>
