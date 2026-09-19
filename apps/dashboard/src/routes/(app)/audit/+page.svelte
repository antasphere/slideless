<script lang="ts">
  import { Tag } from '$lib/components/ui/tag';
  import { viaTag } from '$lib/tags';
  import SectionHero from '$lib/components/shared/SectionHero.svelte';
  import TableSkeleton from '$lib/components/shared/TableSkeleton.svelte';
  import TableToolbar from '$lib/components/shared/TableToolbar.svelte';
  import { stuck } from '$lib/components/shared/stuck';
  import * as Table from '$lib/components/ui/table/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import * as Popover from '$lib/components/ui/popover/index.js';
  import { createPagedList } from '$lib/stores/pagedList.svelte';
  import { api, errorMessage } from '$lib/api';
  import { formatDate, formatDateTime, formatTimeAgo } from '$lib/format';
  import * as Sheet from '$lib/components/ui/sheet/index.js';
  import { CodeBlock } from '$lib/components/ui/code-block/index.js';
  import { appear, reveal } from '$lib/components/ui/reveal/index.js';
  import FormError from '$lib/components/shared/FormError.svelte';
  import AuditFilterPanel from '$lib/components/audit/AuditFilterPanel.svelte';
  import {
    EMPTY_FILTERS,
    activeCount,
    activeFilters,
    filterKey,
    isFiltering,
    toApiParams,
    toSearchParams,
    type AuditFilters
  } from '$lib/components/audit/audit-filters';
  import { IsMobile } from '$lib/hooks/is-mobile.svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import KeyRound from '@lucide/svelte/icons/key-round';
  import Mail from '@lucide/svelte/icons/mail';
  import Users from '@lucide/svelte/icons/users';
  import Folder from '@lucide/svelte/icons/folder';
  import Activity from '@lucide/svelte/icons/activity';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import SlidersHorizontal from '@lucide/svelte/icons/sliders-horizontal';
  import X from '@lucide/svelte/icons/x';
  import { t } from '$lib/i18n';
  import { tool } from '$lib/tool';
  import type { AuditEntry, Member } from '@slideless/contract';

  let { data } = $props();

  // The filters are the URL's (+page.ts reads them); the page only ever
  // writes them back through `commit`, so a filtered view is a link that
  // survives a reload and a back button.
  const filters = $derived(data.filters);
  let current: AuditFilters = EMPTY_FILTERS;
  let total = $state<number | null>(null);

  const list = createPagedList<AuditEntry>(
    async (p) => {
      const { entries, nextCursor, total: counted } = await api.audit({ ...p, ...toApiParams(current) });
      if (!p.cursor) total = counted;
      return { items: entries, nextCursor };
    },
    { limit: 50 }
  );

  // A change of filters starts the list over from page 1. The rows already
  // shown stay until the fresh page arrives (refresh keeps them); a change
  // that lands while a fetch is in flight is not lost: the key is compared
  // again once the fetch returns.
  let started = false;
  let latestKey = '';
  let refreshing = $state(false);
  $effect(() => {
    const key = filterKey(filters);
    current = filters;
    latestKey = key;
    void run(key);
  });
  async function run(key: string) {
    if (!started) {
      started = true;
      await list.load();
    } else {
      refreshing = true;
      await list.refresh();
    }
    if (latestKey !== key) return;
    refreshing = false;
    if (latestKey !== filterKey(current)) void run(latestKey);
  }

  function commit(next: AuditFilters) {
    const qs = toSearchParams(next).toString();
    void goto(`${page.url.pathname}${qs ? `?${qs}` : ''}`, {
      replaceState: true,
      keepFocus: true,
      noScroll: true
    });
  }
  const clearAll = () => commit(EMPTY_FILTERS);

  // the search field waits a beat before the URL (and the list) follow it;
  // a URL change from elsewhere (a tag removed, the back button) resets it
  let query = $state('');
  let pushedQuery = '';
  let queryTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    if (filters.q !== pushedQuery) {
      pushedQuery = filters.q;
      query = filters.q;
    }
  });
  $effect(() => {
    const typed = query.trim();
    if (typed === pushedQuery) return;
    clearTimeout(queryTimer);
    queryTimer = setTimeout(() => {
      pushedQuery = typed;
      commit({ ...current, q: typed });
    }, 250);
    return () => clearTimeout(queryTimer);
  });

  // the roster for Who: loaded once, its failure shown inside the panel
  let members = $state<Member[]>([]);
  let membersError = $state<string | null>(null);
  $effect(() => {
    api
      .members({ limit: 100 })
      .then((r) => (members = r.members))
      .catch((e) => (membersError = errorMessage(e, t('audit.membersFailed'))));
  });
  const memberLabel = (userId: string) => {
    const member = members.find((m) => m.userId === userId);
    return member ? member.name || member.email : undefined;
  };

  const entries = $derived(list.items);
  const seenActions = $derived([...new Set(entries.map((e) => e.action))]);
  const seenResourceTypes = $derived([...new Set(entries.map((e) => e.resourceType))]);
  const filtering = $derived(isFiltering(filters));
  const activeN = $derived(activeCount(filters));
  const tags = $derived(
    activeFilters(
      filters,
      memberLabel,
      (via) => viaTag(via).label,
      (day) => formatDate(`${day}T12:00:00`)
    )
  );

  // "42 entries" once everything matching is shown, "50 of 120" while more
  // waits behind Load more, and the loaded count alone if no total came
  const countLine = $derived.by(() => {
    if (list.loading) return undefined;
    if (total === null) return t('audit.countLoaded', { n: entries.length });
    if (entries.length < total) return t('audit.countOf', { shown: entries.length, total });
    return total === 1 ? t('audit.countOne') : t('audit.count', { n: total });
  });

  let toolbarHeight = $state(0);
  let panelOpen = $state(false);

  // On a phone (PRDCT-2440) a line says three things: what happened, who did
  // it, roughly when. How it arrived, what it touched and the request that
  // carried it are one tap away, in the same detail a desk row opens.
  const phone = new IsMobile();
  let opened = $state<AuditEntry | null>(null);

  function glyph(entry: AuditEntry) {
    const kind = `${entry.resourceType} ${entry.action}`;
    if (/key/.test(kind)) return KeyRound;
    if (/invit/.test(kind)) return Mail;
    if (/member|user|collab/.test(kind)) return Users;
    for (const glyph of tool.audit.glyphs) if (glyph.test.test(kind)) return glyph.icon;
    if (/file|blob/.test(kind)) return Folder;
    return Activity;
  }

  // Phone lines are grouped under their day, so the time beside each stays short.
  const days = $derived.by(() => {
    const groups: { day: string; entries: AuditEntry[] }[] = [];
    for (const entry of entries) {
      const day = formatDate(entry.createdAt);
      const last = groups[groups.length - 1];
      if (last?.day === day) last.entries.push(entry);
      else groups.push({ day, entries: [entry] });
    }
    return groups;
  });

  const pretty = (value: unknown) => JSON.stringify(value, null, 2);
</script>

<SectionHero
  eyebrow={t('nav.system')}
  title={t('audit.title')}
  lede={t('audit.description')}
  drawing="harmonic"
/>

<!-- the Filters button, its count when any group holds something; what it
     opens is the floating material on a desk and a bottom sheet on a phone -->
{#snippet filterButton(props: Record<string, unknown> = {})}
  <Button
    variant="outline"
    size="sm"
    class="filters-btn h-8"
    data-active={activeN > 0 || undefined}
    {...props}
  >
    <SlidersHorizontal class="mr-2 h-4 w-4" />
    {activeN > 0 ? t('audit.filtersCount', { n: activeN }) : t('audit.filters')}
  </Button>
{/snippet}

{#snippet panel(idPrefix: string, layout: 'stack' | 'columns' = 'stack')}
  <AuditFilterPanel
    {layout}
    {filters}
    {members}
    {membersError}
    {seenActions}
    {seenResourceTypes}
    onchange={commit}
    {idPrefix}
  />
{/snippet}

{#snippet filterActs()}
  {#if phone.current}
    {@render filterButton({ onclick: () => (panelOpen = true) })}
  {:else}
    <Popover.Root bind:open={panelOpen}>
      <Popover.Trigger>
        {#snippet child({ props })}
          {@render filterButton(props)}
        {/snippet}
      </Popover.Trigger>
      <Popover.Content align="end" class="filter-float w-[680px] max-w-[calc(100vw-32px)] p-0">
        <div class="filter-head">
          <span class="text-[13.5px] font-medium">{t('audit.filtersTitle')}</span>
          {#if filtering}
            <button type="button" class="clear-link" onclick={clearAll}>{t('audit.clearAll')}</button>
          {/if}
        </div>
        <div class="filter-body">
          {@render panel('desk', 'columns')}
        </div>
      </Popover.Content>
    </Popover.Root>
  {/if}
{/snippet}

<!-- one tag per active filter, each removable, and the way to drop them all -->
{#snippet activeTags()}
  {#if tags.length}
    <ul class="active" aria-label={t('audit.activeFiltersAria')} transition:reveal>
      {#each tags as tag (tag.key)}
        <li>
          <span class="chip">
            <span class="chip-label">{tag.label}</span>
            <button
              type="button"
              class="chip-x"
              aria-label={t('audit.removeFilter', { filter: tag.label })}
              onclick={() => commit(tag.remove)}
            >
              <X class="size-3" strokeWidth={2.2} />
            </button>
          </span>
        </li>
      {/each}
      <li>
        <button type="button" class="clear-link" onclick={clearAll}>{t('audit.clearAll')}</button>
      </li>
    </ul>
  {/if}
{/snippet}

{#snippet emptyState()}
  {#if filtering}
    <span class="block">{t('audit.emptyFiltered')}</span>
    <button type="button" class="clear-link mt-2 inline-block" onclick={clearAll}
      >{t('audit.clearFilters')}</button
    >
  {:else}
    {t('audit.empty')}
  {/if}
{/snippet}

{#if list.loading && entries.length === 0}
  <TableSkeleton columns={6} />
{:else if list.error && entries.length === 0 && !filtering}
  <p class="text-sm text-destructive" in:appear>{list.error}</p>
{:else}
  <div class="table-card" style="--toolbar-h: {toolbarHeight}px">
    <TableToolbar
      searchPlaceholder={t('audit.searchPlaceholder')}
      bind:searchValue={query}
      count={countLine}
      actions={filterActs}
      bind:height={toolbarHeight}
      testid="audit-toolbar"
    />
    {@render activeTags()}
    <FormError message={list.error} class="pb-3" />

    <div class="rows" class:is-refreshing={refreshing} aria-busy={refreshing}>
      {#if phone.current}
        {#each days as group (group.day)}
          <h2 class="eyebrow mb-2 mt-6 first:mt-0">{group.day}</h2>
          <ul class="sheet divide-y divide-[var(--hairline)] overflow-hidden">
            {#each group.entries as entry (entry.id)}
              {@const Glyph = glyph(entry)}
              <li>
                <button type="button" class="line" onclick={() => (opened = entry)}>
                  <span class="well"><Glyph class="size-4" strokeWidth={1.6} /></span>
                  <span class="min-w-0 flex-1 text-left">
                    <code class="block break-words text-[12.5px] leading-snug text-foreground"
                      >{entry.action}</code
                    >
                    <span class="mt-0.5 block truncate text-[13px] text-muted-foreground">
                      {entry.actorEmail ?? t('audit.system')} · {formatTimeAgo(entry.createdAt)}
                    </span>
                  </span>
                  <ChevronRight class="size-4 shrink-0 text-muted-foreground/60" />
                </button>
              </li>
            {/each}
          </ul>
        {:else}
          <p class="py-16 text-center text-sm text-muted-foreground">{@render emptyState()}</p>
        {/each}
      {:else}
        <!-- clip, not hidden: the corners are still cut and the column header can
             stick to the page's scroll; the cap redraws the card's rounded top over
             the header while it is held (app.css, a table) -->
        <div class="table-cap" aria-hidden="true" use:stuck></div>
        <div class="sheet overflow-clip">
          <Table.Root scroll={false} class="table-sticky">
            <Table.Header>
              <Table.Row>
                <Table.Head class="w-[190px]">{t('audit.colTime')}</Table.Head>
                <Table.Head>{t('audit.colActor')}</Table.Head>
                <Table.Head class="w-[90px]">{t('audit.colVia')}</Table.Head>
                <Table.Head>{t('audit.colAction')}</Table.Head>
                <Table.Head>{t('audit.colResource')}</Table.Head>
                <Table.Head class="w-[130px]">{t('audit.colRequest')}</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {#each entries as entry (entry.id)}
                <Table.Row
                  class="cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--focus)]"
                  tabindex={0}
                  role="button"
                  aria-label={`${entry.action} · ${entry.actorEmail ?? t('audit.system')}`}
                  onclick={() => (opened = entry)}
                  onkeydown={(e: KeyboardEvent) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      opened = entry;
                    }
                  }}
                >
                  <Table.Cell class="whitespace-nowrap">
                    <span class="block">{formatTimeAgo(entry.createdAt)}</span>
                    <span class="block text-xs font-normal text-muted-foreground"
                      >{formatDateTime(entry.createdAt)}</span
                    >
                  </Table.Cell>
                  <Table.Cell>{entry.actorEmail ?? t('audit.system')}</Table.Cell>
                  <Table.Cell>
                    <Tag {...viaTag(entry.actorVia)} />
                  </Table.Cell>
                  <Table.Cell class="max-w-[340px]"
                    ><span class="action block truncate" title={entry.action}>{entry.action}</span
                    ></Table.Cell
                  >
                  <Table.Cell class="max-w-[220px] truncate text-muted-foreground">
                    {entry.resourceType}{entry.resourceId ? ` · ${entry.resourceId}` : ''}
                  </Table.Cell>
                  <Table.Cell>
                    {#if entry.requestId}
                      <code class="text-xs text-muted-foreground" title={entry.requestId}>
                        {entry.requestId.slice(0, 8)}…
                      </code>
                    {:else}
                      <span class="text-muted-foreground">—</span>
                    {/if}
                  </Table.Cell>
                </Table.Row>
              {:else}
                <Table.Row>
                  <Table.Cell colspan={6} class="h-24 text-center !font-normal !text-muted-foreground">
                    {@render emptyState()}
                  </Table.Cell>
                </Table.Row>
              {/each}
            </Table.Body>
          </Table.Root>
        </div>
      {/if}
    </div>
  </div>

  {#if list.nextCursor && entries.length}
    <div class="flex justify-center py-4" transition:reveal>
      <Button variant="outline" onclick={() => void list.loadMore()} disabled={list.loadingMore}>
        {list.loadingMore ? t('common.loading') : t('common.loadMore')}
      </Button>
    </div>
  {/if}
{/if}

<!-- on a phone the panel is a bottom sheet; the head carries the title and
     the way to drop every filter, the foot the way out -->
{#if phone.current}
  <Sheet.Root bind:open={panelOpen}>
    <Sheet.Content side="bottom" class="flex max-h-[88dvh] flex-col gap-0 rounded-t-2xl p-0">
      <Sheet.Header class="filter-head px-5 pr-14">
        <Sheet.Title class="font-display text-xl font-normal">{t('audit.filtersTitle')}</Sheet.Title>
        <Sheet.Description class="sr-only">{t('audit.filtersDescription')}</Sheet.Description>
      </Sheet.Header>
      <div class="filter-body min-h-0 flex-1 overflow-y-auto px-5">
        {@render panel('phone')}
      </div>
      <Sheet.Footer class="filter-foot">
        {#if filtering}
          <Button variant="ghost" onclick={clearAll}>{t('audit.clearAll')}</Button>
        {/if}
        <Button onclick={() => (panelOpen = false)}>{t('audit.done')}</Button>
      </Sheet.Footer>
    </Sheet.Content>
  </Sheet.Root>
{/if}

<Sheet.Root open={opened !== null} onOpenChange={(open) => !open && (opened = null)}>
  <Sheet.Content
    side={phone.current ? 'bottom' : 'right'}
    class="max-h-[88dvh] overflow-y-auto max-md:rounded-t-2xl md:max-h-none md:max-w-md"
  >
    {#if opened}
      <Sheet.Header>
        <Sheet.Title class="font-display text-xl font-normal">
          <code class="text-[15px]">{opened.action}</code>
        </Sheet.Title>
        <Sheet.Description>{formatDateTime(opened.createdAt)}</Sheet.Description>
      </Sheet.Header>
      <dl class="facts">
        <dt>{t('audit.colActor')}</dt>
        <dd>{opened.actorEmail ?? t('audit.system')}</dd>
        <dt>{t('audit.colVia')}</dt>
        <dd><Tag {...viaTag(opened.actorVia)} /></dd>
        <dt>{t('audit.colResource')}</dt>
        <dd class="break-all">{opened.resourceType}{opened.resourceId ? ` · ${opened.resourceId}` : ''}</dd>
        {#if opened.requestId}
          <dt>{t('audit.colRequest')}</dt>
          <dd class="break-all"><code class="text-xs">{opened.requestId}</code></dd>
        {/if}
        {#if opened.ip}
          <dt>{t('audit.colIp')}</dt>
          <dd><code class="text-xs">{opened.ip}</code></dd>
        {/if}
      </dl>
      {#if opened.metadata}
        <!-- SECURITY: metadata may carry user-authored strings; text interpolation only
             (CodeBlock renders its code as text, never {@html}). -->
        <CodeBlock
          code={pretty(opened.metadata)}
          label={t('audit.colDetails')}
          ariaLabel={t('audit.colDetails')}
          class="mt-5 [--code-max-h:40dvh]"
        />
      {/if}
    {/if}
  </Sheet.Content>
</Sheet.Root>

<style>
  /* the action is what the line is about: the mono face, in ink, on a faint well */
  .action {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--ink);
  }
  .line {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    min-height: 60px;
    padding: 10px 12px;
    -webkit-tap-highlight-color: transparent;
  }
  .line:active {
    background: var(--ground-3);
  }
  .well {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: 34px;
    height: 34px;
    border-radius: 999px;
    background: var(--accent-soft);
    color: var(--accent-deep);
  }
  .facts {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 10px 18px;
    margin-top: 18px;
    font-size: 14px;
  }
  .facts dt {
    color: var(--muted);
  }
  /* a Filters button holding something takes the accent's edge, like a pressed range */
  :global(.filters-btn[data-active]) {
    border-color: color-mix(in oklab, var(--accent) 55%, var(--hairline));
    color: var(--accent-deep);
  }
  /* the rows fade a touch while a fresh page is on its way */
  .rows {
    transition: opacity var(--motion-duration) var(--motion-ease);
  }
  .rows.is-refreshing {
    opacity: 0.55;
  }
  /* the active filters, one row of removable chips under the toolbar */
  .active {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    padding: 0 0 10px;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    height: 24px;
    padding: 0 3px 0 8px;
    border-radius: 7px;
    border: 1px solid color-mix(in oklab, var(--accent) 24%, transparent);
    background: color-mix(in oklab, var(--accent) 9%, var(--plate-strong));
    color: var(--accent-deep);
    font-size: 12.5px;
    font-weight: 500;
    line-height: 1;
    white-space: nowrap;
    max-width: 100%;
  }
  .chip-label {
    overflow: hidden;
    text-overflow: ellipsis;
    /* room for the underscores of an action name */
    line-height: 18px;
  }
  .chip-x {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border-radius: 5px;
    color: inherit;
    opacity: 0.7;
  }
  .chip-x:hover {
    opacity: 1;
    background: color-mix(in oklab, var(--accent) 16%, transparent);
  }
  .chip-x:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 1px;
    opacity: 1;
  }
  .clear-link {
    font-size: 13px;
    color: var(--muted);
    text-decoration: underline;
    text-underline-offset: 3px;
    text-decoration-color: color-mix(in oklab, var(--muted) 45%, transparent);
  }
  .clear-link:hover {
    color: var(--ink);
  }
  .clear-link:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
    border-radius: 3px;
  }
  /* the popover's head, body and foot: a hairline under the title, the body scrolls */
  :global(.filter-float) {
    /* never taller than the room under the button: the floating layer says
       how much there is; the body scrolls inside the rest */
    max-height: min(calc(var(--bits-popover-content-available-height, 78vh) - 12px), 760px);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  :global(.filter-head) {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex: none;
    padding: 12px 16px;
    border-bottom: 1px solid var(--hairline);
  }
  :global(.filter-body) {
    min-height: 0;
    overflow-y: auto;
    padding: 16px;
  }
  :global(.filter-foot) {
    flex: none;
    gap: 8px;
    padding: 12px 20px;
    padding-bottom: max(12px, env(safe-area-inset-bottom));
    border-top: 1px solid var(--hairline);
  }
</style>
