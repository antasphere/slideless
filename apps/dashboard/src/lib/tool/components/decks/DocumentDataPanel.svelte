<script lang="ts">
  /*
   * The Data tab of a DOCUMENT (PRDCT-3641, data-bound templates): the
   * template it is made from and the version it is pinned to (with the
   * upgrade when the template has moved on), the data its current version
   * was rendered from, the forms' answers as the data holds them, and the
   * push history with each version's data and what changed.
   *
   * Out of scope here, on purpose: editing the document's data from the
   * dashboard (the CLI and the API do it: `PUT`/`PATCH /presentations/{id}/data`),
   * and the template page's list of the documents made from it.
   *
   * SECURITY: the data and the answers are deck-author and RESPONDENT input
   * on the APP ORIGIN. Every value renders through text interpolation
   * (CodeBlock, Tag, `{value}`), never {@html}, innerHTML or
   * createRawSnippet.
   */
  import * as Card from '$lib/components/ui/card/index.js';
  import * as Table from '$lib/components/ui/table/index.js';
  import * as Alert from '$lib/components/ui/alert/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { CodeBlock } from '$lib/components/ui/code-block/index.js';
  import { Tag, type TagTone } from '$lib/components/ui/tag/index.js';
  import TableSkeleton from '$lib/components/shared/TableSkeleton.svelte';
  import { appear, reveal } from '$lib/components/ui/reveal/index.js';
  import ArrowUpCircle from '@lucide/svelte/icons/circle-arrow-up';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import LayoutTemplate from '@lucide/svelte/icons/layout-template';
  import DeckSectionHeading from './DeckSectionHeading.svelte';
  import EmptyTable from './EmptyTable.svelte';
  import { createPagedList } from '$lib/stores/pagedList.svelte';
  import { api, errorMessage, PlatformApiError } from '$lib/api';
  import { refusalCard, toastApiError } from '$lib/billing-refusal';
  import { diffTopLevel, jsonText, refusalLines, type TopLevelChange } from '$lib/tool/decks/data';
  import { formatDateTime } from '$lib/format';
  import { toast } from 'svelte-sonner';
  import { t } from '$lib/i18n';
  import type {
    DocumentAnswers,
    DocumentData,
    DocumentDataSource,
    DocumentDataVersion
  } from '@slideless/contract';

  interface Props {
    deckId: string;
    /** A user id as the page names it (an email, or a shortened id). */
    resolveUser: (userId: string) => string;
    /** The tab bar's count: the push history's length, `undefined` while unknown. */
    oncount?: (n: number | undefined) => void;
    /** An upgrade made a new version: the page reloads the deck. */
    onchange?: () => void;
  }

  let { deckId, resolveUser, oncount, onchange }: Props = $props();

  // ── The data and its template ───────────────────────────────────────────
  let doc = $state<DocumentData | null>(null);
  let docLoading = $state(true);
  let docError = $state<string | null>(null);
  /** The template's current version; null while unknown or when it cannot be read (no button). */
  let templateCurrent = $state<number | null>(null);
  /** The template's title, when this reader can read the template. */
  let templateTitle = $state<string | null>(null);

  async function loadData() {
    try {
      doc = await api.documentData(deckId);
      docError = null;
    } catch (e) {
      docError = errorMessage(e, t('common.genericError'));
      return;
    } finally {
      docLoading = false;
    }
    try {
      const template = await api.presentation(doc.template.templateId);
      templateCurrent = template.currentVersion;
      templateTitle = template.title;
    } catch {
      // a template gone or unreadable to this reader (404): no upgrade to offer
      templateCurrent = null;
      templateTitle = null;
    }
  }

  let answers = $state<DocumentAnswers | null>(null);
  let answersError = $state<string | null>(null);
  async function loadAnswers() {
    try {
      answers = await api.documentAnswers(deckId);
      answersError = null;
    } catch (e) {
      answersError = errorMessage(e, t('common.genericError'));
    }
  }

  const history = createPagedList<DocumentDataVersion>(async (p) => {
    const { versions, nextCursor } = await api.documentDataVersions(deckId, p);
    return { items: versions, nextCursor };
  });

  $effect(() => {
    void loadData();
    void loadAnswers();
    void history.load();
  });

  $effect(() => {
    oncount?.(history.loading || history.nextCursor || history.error ? undefined : history.items.length);
  });

  async function reloadAll() {
    expanded = {};
    details = {};
    await Promise.all([loadData(), loadAnswers(), history.refresh()]);
  }

  // ── The upgrade ─────────────────────────────────────────────────────────
  const pinned = $derived(doc?.template.templateVersion ?? null);
  const canUpgrade = $derived(templateCurrent !== null && pinned !== null && templateCurrent > pinned);
  let upgrading = $state(false);
  let upgradeError = $state<{ message: string; lines: string[] } | null>(null);

  async function upgrade() {
    if (templateCurrent === null) return;
    const toVersion = templateCurrent;
    upgrading = true;
    upgradeError = null;
    try {
      await api.upgradeDocument(deckId, { toVersion });
      toast.success(t('docData.upgradedToast', { n: toVersion }));
      await reloadAll();
      onchange?.();
    } catch (e) {
      if (refusalCard(e)) {
        toastApiError(e, t('common.genericError'));
      } else {
        // never only a toast: the issues stay on the page until the next try
        upgradeError = {
          message:
            e instanceof PlatformApiError && e.code === 'data_invalid'
              ? t('docData.upgradeInvalid', { n: toVersion })
              : t('docData.upgradeFailed', { error: errorMessage(e, t('common.genericError')) }),
          lines: e instanceof PlatformApiError ? refusalLines(e.code, e.details) : []
        };
      }
    } finally {
      upgrading = false;
    }
  }

  // ── The push history ────────────────────────────────────────────────────
  const SOURCE_TONES: Record<DocumentDataSource, TagTone> = {
    create: 'green',
    push: 'indigo',
    answer: 'amber',
    upgrade: 'violet'
  };
  function sourceLabel(source: DocumentDataSource): string {
    if (source === 'create') return t('docData.sourceCreate');
    if (source === 'push') return t('docData.sourcePush');
    if (source === 'answer') return t('docData.sourceAnswer');
    return t('docData.sourceUpgrade');
  }
  function whoLabel(v: DocumentDataVersion): string {
    if (v.source === 'answer') return v.answeredBy ?? t('docData.unnamedLink');
    return v.createdBy ? resolveUser(v.createdBy) : '—';
  }

  const historyHeads = $derived([
    { title: t('docData.colVersion'), width: '110px' },
    { title: t('docData.colWhen'), width: '170px' },
    { title: t('docData.colSource'), width: '120px' },
    { title: t('docData.colWho'), width: '22%' },
    { title: t('docData.colChanged'), width: undefined }
  ]);

  interface VersionDetail {
    loading: boolean;
    error: string | null;
    data: Record<string, unknown> | null;
    changes: TopLevelChange[];
    first: boolean;
  }
  let expanded = $state<Record<number, boolean>>({});
  let details = $state<Record<number, VersionDetail>>({});

  async function loadDetail(n: number) {
    details[n] = { loading: true, error: null, data: null, changes: [], first: n <= 1 };
    try {
      const [current, previous] = await Promise.all([
        api.documentDataVersion(deckId, n),
        n > 1 ? api.documentDataVersion(deckId, n - 1) : Promise.resolve(null)
      ]);
      details[n] = {
        loading: false,
        error: null,
        data: current.data,
        changes: diffTopLevel(previous?.data ?? null, current.data),
        first: previous === null
      };
    } catch (e) {
      details[n] = {
        loading: false,
        error: errorMessage(e, t('common.genericError')),
        data: null,
        changes: [],
        first: n <= 1
      };
    }
  }

  function toggle(n: number) {
    expanded[n] = !expanded[n];
    if (expanded[n] && (!details[n] || details[n].error)) void loadDetail(n);
  }

  const KIND_TONES: Record<TopLevelChange['kind'], TagTone> = {
    added: 'green',
    removed: 'danger',
    changed: 'amber'
  };
  function kindLabel(kind: TopLevelChange['kind']): string {
    if (kind === 'added') return t('docData.diffAdded');
    if (kind === 'removed') return t('docData.diffRemoved');
    return t('docData.diffChanged');
  }
</script>

{#snippet fieldValue(value: string | string[])}
  {#if Array.isArray(value)}
    <span class="flex flex-wrap gap-1">
      {#each value as item, i (i)}<Tag label={item} />{/each}
    </span>
  {:else if value}
    <span class="whitespace-pre-wrap break-words">{value}</span>
  {:else}
    <span class="text-muted-foreground">—</span>
  {/if}
{/snippet}

<div class="space-y-6" data-testid="document-data-panel">
  <!-- the template, its pin, and the way to the newer version -->
  <Card.Root class="deck-section gap-3">
    <DeckSectionHeading
      drawing="details"
      title={t('docData.templateTitle')}
      description={t('docData.templateDescription')}
    />
    <Card.Content class="space-y-4">
      {#if docLoading}
        <p class="text-sm text-muted-foreground">{t('common.loading')}</p>
      {:else if docError || !doc}
        <p class="text-sm text-destructive" in:appear>
          {t('docData.dataLoadFailed', { error: docError ?? '' })}
        </p>
      {:else}
        <div class="flex flex-wrap items-center gap-2">
          <a
            href={`/decks/${encodeURIComponent(doc.template.templateId)}`}
            class="inline-flex items-center gap-1.5 text-sm font-medium underline-offset-4 hover:underline"
            data-testid="document-template-link"
          >
            <LayoutTemplate class="h-4 w-4" />
            <!-- SECURITY: the template's title is user-authored: escaped text only -->
            {templateTitle ?? t('docData.openTemplate')}
          </a>
          <Tag label={t('docData.templatePinned', { n: doc.template.templateVersion })} tone="indigo" />
          <Tag label={t('docData.schemaVersion', { v: doc.template.schemaVersion })} mono />
          {#if canUpgrade && templateCurrent !== null}
            <Button
              size="sm"
              variant="outline"
              class="ml-auto"
              onclick={() => void upgrade()}
              disabled={upgrading}
              data-testid="document-upgrade"
            >
              <ArrowUpCircle class="mr-2 h-3.5 w-3.5" />
              {upgrading ? t('docData.upgrading') : t('docData.upgrade', { n: templateCurrent })}
            </Button>
          {/if}
        </div>
        {#if upgradeError}
          <div transition:reveal>
            <Alert.Root variant="destructive" data-testid="document-upgrade-error">
              <Alert.Title>{upgradeError.message}</Alert.Title>
              {#if upgradeError.lines.length}
                <Alert.Description>
                  <p>{t('docData.upgradeInvalidHint')}</p>
                  <ul class="mt-1 list-disc space-y-0.5 pl-5 font-mono text-xs">
                    {#each upgradeError.lines as line, i (i)}
                      <li>{line}</li>
                    {/each}
                  </ul>
                </Alert.Description>
              {/if}
            </Alert.Root>
          </div>
        {/if}
      {/if}
    </Card.Content>
  </Card.Root>

  <!-- the data the current version was rendered from -->
  <Card.Root class="deck-section gap-3">
    <DeckSectionHeading
      drawing="details"
      title={t('docData.dataTitle')}
      description={t('docData.dataDescription')}
    />
    <Card.Content>
      {#if docLoading}
        <TableSkeleton columns={1} rows={3} showSearch={false} />
      {:else if doc}
        <CodeBlock code={jsonText(doc.data)} label="data.json" language="json" wrap={false} />
      {:else}
        <p class="text-sm text-destructive" in:appear>
          {t('docData.dataLoadFailed', { error: docError ?? '' })}
        </p>
      {/if}
    </Card.Content>
  </Card.Root>

  <!-- the forms' answers, one card per form -->
  <Card.Root class="deck-section gap-3">
    <DeckSectionHeading
      drawing="forms"
      title={t('docData.answersTitle')}
      description={t('docData.answersDescription')}
    />
    <Card.Content>
      {#if answersError}
        <p class="text-sm text-destructive" in:appear>
          {t('docData.answersLoadFailed', { error: answersError })}
        </p>
      {:else if !answers}
        <TableSkeleton columns={2} rows={2} showSearch={false} />
      {:else if !answers.answers.length}
        <EmptyTable message={t('docData.noAnswers')} />
      {:else}
        <div class="grid gap-4 md:grid-cols-2" data-testid="document-answers">
          {#each answers.answers as answer (answer.form)}
            <section class="sheet space-y-3 p-4">
              <h4 class="font-mono text-sm font-medium">{answer.form}</h4>
              <dl class="space-y-2 text-sm">
                {#each Object.entries(answer.fields) as [field, value] (field)}
                  <div class="grid gap-0.5">
                    <dt class="text-xs text-muted-foreground">{field}</dt>
                    <dd>{@render fieldValue(value)}</dd>
                  </div>
                {/each}
              </dl>
              <p class="text-xs text-muted-foreground">
                {t('docData.answeredBy', {
                  who: answer.answeredBy ?? t('docData.unnamedLink'),
                  date: formatDateTime(answer.answeredAt)
                })}
              </p>
            </section>
          {/each}
        </div>
      {/if}
    </Card.Content>
  </Card.Root>

  <!-- the push history: a row opens its version's data and its diff -->
  <Card.Root class="deck-section gap-3">
    <DeckSectionHeading
      drawing="versions"
      title={t('docData.historyTitle')}
      description={t('docData.historyDescription')}
    />
    <Card.Content>
      {#if history.loading}
        <TableSkeleton columns={5} rows={2} showSearch={false} />
      {:else if history.error && !history.items.length}
        <p class="text-sm text-destructive" in:appear>
          {t('docData.historyLoadFailed', { error: history.error })}
        </p>
      {:else if !history.items.length}
        <EmptyTable message={t('docData.historyEmpty')} columns={historyHeads} />
      {:else}
        <div class="sheet overflow-x-auto">
          <Table.Root class="table-fixed" style="min-width: 680px" data-testid="document-history">
            <Table.Header>
              <Table.Row>
                {#each historyHeads as head (head.title)}
                  <Table.Head style={head.width ? `width: ${head.width}` : undefined}>{head.title}</Table.Head
                  >
                {/each}
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {#each history.items as v (v.version)}
                {@const open = !!expanded[v.version]}
                <Table.Row
                  class="cursor-pointer"
                  onclick={() => toggle(v.version)}
                  data-testid="document-history-row"
                >
                  <Table.Cell>
                    <button
                      type="button"
                      class="inline-flex items-center gap-1 font-medium"
                      aria-expanded={open}
                      aria-label={open
                        ? t('docData.collapse', { n: v.version })
                        : t('docData.expand', { n: v.version })}
                      onclick={(e) => {
                        e.stopPropagation();
                        toggle(v.version);
                      }}
                    >
                      <ChevronRight class="h-3.5 w-3.5 transition-transform {open ? 'rotate-90' : ''}" />
                      v{v.version}
                    </button>
                  </Table.Cell>
                  <Table.Cell>{formatDateTime(v.createdAt)}</Table.Cell>
                  <Table.Cell><Tag label={sourceLabel(v.source)} tone={SOURCE_TONES[v.source]} /></Table.Cell>
                  <Table.Cell class="truncate">{whoLabel(v)}</Table.Cell>
                  <Table.Cell>
                    {#if v.changed.length}
                      <span class="flex flex-wrap gap-1">
                        {#each v.changed as key (key)}<Tag label={key} mono />{/each}
                      </span>
                    {:else}
                      <span class="text-muted-foreground">{t('docData.nothingChanged')}</span>
                    {/if}
                  </Table.Cell>
                </Table.Row>
                {#if open}
                  {@const detail = details[v.version]}
                  <Table.Row class="hover:!bg-transparent">
                    <Table.Cell colspan={5} class="whitespace-normal">
                      <div class="space-y-4 py-2" data-testid="document-history-detail">
                        {#if !detail || detail.loading}
                          <p class="text-sm text-muted-foreground">{t('common.loading')}</p>
                        {:else if detail.error}
                          <p class="text-sm text-destructive">
                            {t('docData.versionLoadFailed', { n: v.version, error: detail.error })}
                          </p>
                        {:else}
                          <div class="space-y-2">
                            <p class="text-sm font-medium">
                              {detail.first
                                ? t('docData.diffFirst')
                                : t('docData.diffTitle', { n: v.version - 1 })}
                            </p>
                            {#if !detail.changes.length}
                              <p class="text-sm text-muted-foreground">{t('docData.diffNone')}</p>
                            {:else}
                              <ul class="space-y-3">
                                {#each detail.changes as change (change.key)}
                                  <li class="space-y-1.5">
                                    <span class="flex items-center gap-2">
                                      <span class="font-mono text-sm">{change.key}</span>
                                      <Tag label={kindLabel(change.kind)} tone={KIND_TONES[change.kind]} />
                                    </span>
                                    <div
                                      class="grid gap-2 {change.kind === 'changed' ? 'md:grid-cols-2' : ''}"
                                    >
                                      {#if change.kind !== 'added'}
                                        <CodeBlock
                                          code={jsonText(change.before)}
                                          label={t('docData.before')}
                                          language="json"
                                        />
                                      {/if}
                                      {#if change.kind !== 'removed'}
                                        <CodeBlock
                                          code={jsonText(change.after)}
                                          label={t('docData.after')}
                                          language="json"
                                        />
                                      {/if}
                                    </div>
                                  </li>
                                {/each}
                              </ul>
                            {/if}
                          </div>
                          {#if detail.data}
                            <CodeBlock
                              code={jsonText(detail.data)}
                              label={t('docData.versionData', { n: v.version })}
                              language="json"
                              wrap={false}
                            />
                          {/if}
                        {/if}
                      </div>
                    </Table.Cell>
                  </Table.Row>
                {/if}
              {/each}
            </Table.Body>
          </Table.Root>
        </div>
        {#if history.nextCursor}
          <div class="flex justify-center py-2" transition:reveal>
            <Button
              variant="outline"
              size="sm"
              onclick={() => void history.loadMore()}
              disabled={history.loadingMore}
            >
              {history.loadingMore ? t('common.loading') : t('common.loadMore')}
            </Button>
          </div>
        {/if}
      {/if}
    </Card.Content>
  </Card.Root>
</div>
