<script lang="ts">
  import { Tag } from '$lib/components/ui/tag';
  import { viaTag } from '$lib/tags';
  import PageHeader from '$lib/components/shared/PageHeader.svelte';
  import TableSkeleton from '$lib/components/shared/TableSkeleton.svelte';
  import * as Table from '$lib/components/ui/table/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { createPagedList } from '$lib/stores/pagedList.svelte';
  import { api } from '$lib/api';
  import { formatDate, formatDateTime, formatTimeAgo } from '$lib/format';
  import * as Sheet from '$lib/components/ui/sheet/index.js';
  import { CodeBlock } from '$lib/components/ui/code-block/index.js';
  import { appear, reveal } from '$lib/components/ui/reveal/index.js';
  import FormError from '$lib/components/shared/FormError.svelte';
  import { IsMobile } from '$lib/hooks/is-mobile.svelte';
  import KeyRound from '@lucide/svelte/icons/key-round';
  import Mail from '@lucide/svelte/icons/mail';
  import Users from '@lucide/svelte/icons/users';
  import Presentation from '@lucide/svelte/icons/presentation';
  import Folder from '@lucide/svelte/icons/folder';
  import Activity from '@lucide/svelte/icons/activity';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import { t } from '$lib/i18n';
  import type { AuditEntry } from '@slideless/contract';

  const list = createPagedList<AuditEntry>(
    async (p) => {
      const { entries, nextCursor } = await api.audit(p);
      return { items: entries, nextCursor };
    },
    { limit: 50 }
  );

  $effect(() => {
    void list.load();
  });

  const entries = $derived(list.items);

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
    if (/present|deck|share|version/.test(kind)) return Presentation;
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

<PageHeader title={t('audit.title')} description={t('audit.description')} />

{#if list.loading}
  <TableSkeleton columns={6} showSearch={false} />
{:else if list.error && entries.length === 0}
  <p class="text-sm text-destructive" in:appear>{list.error}</p>
{:else if phone.current}
  {#each days as group (group.day)}
    <h2 class="eyebrow mb-2 mt-6 first:mt-0">{group.day}</h2>
    <ul class="sheet divide-y divide-[var(--hairline)] overflow-hidden">
      {#each group.entries as entry (entry.id)}
        {@const Glyph = glyph(entry)}
        <li>
          <button type="button" class="line" onclick={() => (opened = entry)}>
            <span class="well"><Glyph class="size-4" strokeWidth={1.6} /></span>
            <span class="min-w-0 flex-1 text-left">
              <code class="block break-words text-[12.5px] leading-snug text-foreground">{entry.action}</code>
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
    <p class="py-16 text-center text-sm text-muted-foreground">{t('audit.empty')}</p>
  {/each}
{:else}
  <!-- clip, not hidden: the corners are still cut and the column header can
       stick to the page's scroll (app.css, the table's card) -->
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
              ><span class="action block truncate" title={entry.action}>{entry.action}</span></Table.Cell
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
            <Table.Cell colspan={6} class="h-24 text-center text-muted-foreground">
              {t('audit.empty')}
            </Table.Cell>
          </Table.Row>
        {/each}
      </Table.Body>
    </Table.Root>
  </div>
{/if}

{#if !list.loading && entries.length}
  <FormError message={list.error} class="mt-3" />

  {#if list.nextCursor}
    <div class="flex justify-center py-4" transition:reveal>
      <Button variant="outline" onclick={() => void list.loadMore()} disabled={list.loadingMore}>
        {list.loadingMore ? t('common.loading') : t('common.loadMore')}
      </Button>
    </div>
  {/if}
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
</style>
