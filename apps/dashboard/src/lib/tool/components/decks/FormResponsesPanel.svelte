<script lang="ts">
  import TableSkeleton from '$lib/components/shared/TableSkeleton.svelte';
  import TableToolbar from '$lib/components/shared/TableToolbar.svelte';
  import { rowCount } from '$lib/components/shared/DataTable.svelte';
  import ConfirmDialog from '$lib/components/shared/ConfirmDialog.svelte';
  import * as Card from '$lib/components/ui/card/index.js';
  import DeckSectionHeading from './DeckSectionHeading.svelte';
  import EmptyTable from './EmptyTable.svelte';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import * as Select from '$lib/components/ui/select/index.js';
  import * as Table from '$lib/components/ui/table/index.js';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Checkbox } from '$lib/components/ui/checkbox/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import { appear, reveal } from '$lib/components/ui/reveal/index.js';
  import FormError from '$lib/components/shared/FormError.svelte';
  import Download from '@lucide/svelte/icons/download';
  import Paperclip from '@lucide/svelte/icons/paperclip';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import { createPagedList } from '$lib/stores/pagedList.svelte';
  import { api, errorMessage, PlatformApiError } from '$lib/api';
  import { buildResponsesCsv, groupFilesByField } from '$lib/tool/decks/form-responses';
  import { download, saveBlob } from '$lib/download';
  import { formatBytes, formatTimeAgo } from '$lib/format';
  import { toast } from 'svelte-sonner';
  import { t } from '$lib/i18n';
  import type {
    FormResponse,
    FormResponseDetail,
    FormResponseSourceValue,
    FormResponsesSummary
  } from '@slideless/contract';

  /**
   * SECURITY — READ BEFORE TOUCHING THE MARKUP BELOW.
   *
   * Form-response payload KEYS and VALUES are ANONYMOUS-RESPONDENT input
   * stored RAW server-side (ADR 022 — the server enforces shape, never
   * meaning). This panel runs on the APP ORIGIN: rendering any of them with
   * {@html} is stored XSS = session takeover. Every render site below uses
   * Svelte's `{value}` text interpolation, which escapes. NEVER introduce
   * {@html}, innerHTML, or createRawSnippet on these fields. The CSV export
   * routes every cell through the formula-injection guard in $lib/csv.
   *
   * The same holds for an uploaded file's `field`, `name` and `contentType`
   * (PRDCT-2403): text interpolation only. A download is requested by IDS
   * ONLY (deck, response, file), never by a name, and goes through
   * $lib/download, which saves a respondent's bytes as octet-stream: they
   * are never rendered on this origin.
   */

  interface Props {
    deckId: string;
  }

  let { deckId }: Props = $props();

  let filterForm = $state('all');
  let filterSource = $state<'all' | FormResponseSourceValue>('all');

  // ADR 013 posture: the API answers 404 for non-writers (existence is not
  // advertised) — render the quiet no-access state, never an error.
  let noAccess = $state(false);

  const list = createPagedList<FormResponse>(async (p) => {
    try {
      const { responses, nextCursor } = await api.formResponses(deckId, {
        ...p,
        ...(filterForm !== 'all' ? { form: filterForm } : {}),
        ...(filterSource !== 'all' ? { source: filterSource } : {})
      });
      return { items: responses, nextCursor };
    } catch (e) {
      if (e instanceof PlatformApiError && e.status === 404) {
        noAccess = true;
        return { items: [], nextCursor: null };
      }
      throw e;
    }
  });

  // ── Summary (per form × link × source × placement) ─────────────────────
  let summary = $state<FormResponsesSummary | null>(null);
  let summaryLoading = $state(true);
  let summaryError = $state<string | null>(null);

  async function loadSummary() {
    summaryLoading = true;
    try {
      summary = await api.formResponsesSummary(deckId);
      summaryError = null;
    } catch (e) {
      if (e instanceof PlatformApiError && e.status === 404) {
        noAccess = true;
        summary = null;
      } else {
        summaryError = errorMessage(e);
      }
    } finally {
      summaryLoading = false;
    }
  }

  const hasFilters = $derived(filterForm !== 'all' || filterSource !== 'all');
  // the toolbar's quiet line: every response on the deck (the summary's
  // total), or how many of them the filters keep once they are all here
  const responseCount = $derived.by(() => {
    if (summaryLoading || !summary || noAccess) return undefined;
    const total = summary.total;
    const shown = hasFilters && !list.loading && !list.nextCursor ? list.items.length : total;
    return rowCount('formResponses.countOne', 'formResponses.count')(shown, total);
  });

  // The summary table's heads, shared by the table and its empty form.
  const summaryHeads = $derived(
    [
      t('formResponses.colForm'),
      t('formResponses.colLink'),
      t('formResponses.colSource'),
      t('formResponses.colPlacement'),
      t('formResponses.colCount'),
      t('formResponses.colLastActivity')
    ].map((title) => ({ title }))
  );

  $effect(() => {
    // Track the filters so changing either re-fetches page 1.
    void [filterForm, filterSource];
    void list.load();
  });

  $effect(() => {
    void loadSummary();
  });

  // No realtime/polling by design — this button is the refresh affordance.
  function refresh() {
    void list.refresh();
    void loadSummary();
  }

  // Filter options: every form name the summary or the loaded rows mention.
  const formNames = $derived.by(() => {
    const names = [
      ...(summary?.buckets ?? []).map((bucket) => bucket.formName),
      ...list.items.map((response) => response.formName),
      ...(filterForm !== 'all' ? [filterForm] : [])
    ];
    return names.filter((name, i) => names.indexOf(name) === i).sort();
  });

  function sourceLabel(source: FormResponseSourceValue): string {
    return source === 'embed' ? t('formResponses.sourceEmbed') : t('formResponses.sourceLink');
  }

  /** Flatten one payload for display; string[] joins with ", ". RAW input. */
  function payloadEntries(response: FormResponse): [string, string][] {
    return Object.entries(response.payload).map(([key, value]) => [
      key,
      Array.isArray(value) ? value.join(', ') : value
    ]);
  }

  // ── Files (PRDCT-2403) ─────────────────────────────────────────────────
  // Downloads go through $lib/download, never a plain anchor (PRDCT-2426):
  // an anchor cannot carry X-Workspace-Id, so in any workspace but the
  // default one it answered 404. The API client fetches (active workspace
  // included), the server's Content-Disposition names the file, and a
  // refusal is said on screen.
  const anyFiles = $derived(list.items.some((response) => response.files.length > 0));
  // One download at a time per control: a zip takes a while, and a second
  // click would fetch it twice.
  let downloading = $state<string | null>(null);

  async function runDownload(key: string, fetcher: () => Promise<Response>, fallbackName: string) {
    if (downloading === key) return;
    downloading = key;
    try {
      await download(fetcher, { fallbackName });
    } finally {
      if (downloading === key) downloading = null;
    }
  }

  function downloadAllFiles() {
    const filter = filterForm !== 'all' ? { form: filterForm } : {};
    return runDownload('all', () => api.downloadFormResponsesFilesZip(deckId, filter), 'form-files.zip');
  }

  function downloadResponseFiles(response: FormResponse) {
    return runDownload(
      `zip:${response.id}`,
      () => api.downloadFormResponseFilesZip(deckId, response.id),
      'response-files.zip'
    );
  }

  function downloadResponseFile(response: FormResponse, file: FormResponse['files'][number]) {
    // The fallback is the respondent's name for the file: $lib/download
    // flattens it to one safe path segment before it names anything.
    return runDownload(
      `file:${file.id}`,
      () => api.downloadFormResponseFile(deckId, response.id, file.id),
      file.name
    );
  }

  function isUpdated(response: FormResponse): boolean {
    return new Date(response.updatedAt).getTime() > new Date(response.createdAt).getTime();
  }

  // ── Edit history (PRDCT-2329): the owner sees every kept revision ──────
  let showHistory = $state(false);
  let historyLoading = $state(false);
  let history = $state<FormResponseDetail | null>(null);

  async function openHistory(response: FormResponse) {
    history = null;
    showHistory = true;
    historyLoading = true;
    try {
      history = await api.formResponse(deckId, response.id);
    } catch (e) {
      toast.error(t('formResponses.historyLoadFailed', { error: errorMessage(e) }));
      showHistory = false;
    } finally {
      historyLoading = false;
    }
  }

  /** Flatten one revision's payload for display; string[] joins with ", ". RAW input. */
  function versionEntries(payload: Record<string, string | string[]>): [string, string][] {
    return Object.entries(payload).map(([key, value]) => [
      key,
      Array.isArray(value) ? value.join(', ') : value
    ]);
  }

  // ── Owner mails (PRDCT-2330): the per-deck switch, read from the deck ──
  // null until the deck is read; the checkbox stays hidden meanwhile.
  let notify = $state<boolean | null>(null);
  let notifySaving = $state(false);

  $effect(() => {
    void api
      .presentation(deckId)
      .then((deck) => {
        notify = deck.notifyOnResponse;
      })
      .catch(() => {
        // A non-writer gets the quiet no-access state elsewhere; no switch.
        notify = null;
      });
  });

  async function setNotify(value: boolean) {
    if (notifySaving) return;
    const previous = notify;
    notify = value;
    notifySaving = true;
    try {
      const deck = await api.updatePresentation(deckId, { notifyOnResponse: value });
      notify = deck.notifyOnResponse;
      toast.success(
        t(deck.notifyOnResponse ? 'formResponses.notifyOnToast' : 'formResponses.notifyOffToast')
      );
    } catch (e) {
      notify = previous;
      toast.error(t('formResponses.notifyFailed', { error: errorMessage(e) }));
    } finally {
      notifySaving = false;
    }
  }

  // ── CSV export of the currently filtered, currently loaded rows ────────
  function downloadCsv() {
    const rows = list.items;
    if (!rows.length) return;
    // Payload keys and file fields become extra columns; every cell is
    // guarded against formula injection ($lib/tool/decks/form-responses).
    const csv = buildResponsesCsv(rows);
    // Filename: only the server-validated form slug may appear (defense in
    // depth — the charset gate already holds at the contract).
    const formPart =
      filterForm !== 'all' && /^[A-Za-z0-9._-]{1,64}$/.test(filterForm) ? `-${filterForm}` : '';
    saveBlob(
      new Blob([csv], { type: 'text/csv' }),
      `responses${formPart}-${new Date().toISOString().slice(0, 10)}.csv`
    );
  }

  // ── Delete ─────────────────────────────────────────────────────────────
  let showDeleteDialog = $state(false);
  let deleteLoading = $state(false);
  let deleteTarget = $state<FormResponse | null>(null);

  async function submitDelete() {
    if (!deleteTarget) return;
    deleteLoading = true;
    try {
      await api.deleteFormResponse(deckId, deleteTarget.id);
      toast.success(t('formResponses.deletedToast'));
      showDeleteDialog = false;
      deleteTarget = null;
      await list.refresh();
      void loadSummary();
    } catch (e) {
      toast.error(errorMessage(e, t('common.deleteFailed')));
    } finally {
      deleteLoading = false;
    }
  }
</script>

<!-- the two filters, at the left of the toolbar where a search would sit;
     each select says its own value, its name is for assistive technology -->
{#snippet filters()}
  <Label for="response-filter-form" class="sr-only">{t('formResponses.filterForm')}</Label>
  <Select.Root
    type="single"
    value={filterForm}
    onValueChange={(v) => {
      if (v) filterForm = v;
    }}
  >
    <Select.Trigger id="response-filter-form" class="h-8 w-auto min-w-[150px] max-w-full">
      {filterForm === 'all' ? t('formResponses.filterAllForms') : filterForm}
    </Select.Trigger>
    <Select.Content>
      <Select.Item value="all" label={t('formResponses.filterAllForms')} />
      {#each formNames as formName (formName)}
        <Select.Item value={formName} label={formName} />
      {/each}
    </Select.Content>
  </Select.Root>
  <Label for="response-filter-source" class="sr-only">{t('formResponses.filterSource')}</Label>
  <Select.Root
    type="single"
    value={filterSource}
    onValueChange={(v) => {
      if (v === 'all' || v === 'link' || v === 'embed') filterSource = v;
    }}
  >
    <Select.Trigger id="response-filter-source" class="h-8 w-auto min-w-[150px] max-w-full">
      {filterSource === 'all' ? t('formResponses.filterAllSources') : sourceLabel(filterSource)}
    </Select.Trigger>
    <Select.Content>
      <Select.Item value="all" label={t('formResponses.filterAllSources')} />
      <Select.Item value="link" label={t('formResponses.sourceLink')} />
      <Select.Item value="embed" label={t('formResponses.sourceEmbed')} />
    </Select.Content>
  </Select.Root>
{/snippet}

<!-- the section's acts, at the right of the toolbar -->
{#snippet actions()}
  <Button variant="outline" size="sm" class="h-8" onclick={refresh} disabled={list.loading}>
    <RefreshCw class="mr-2 h-3.5 w-3.5" />
    {t('formResponses.refresh')}
  </Button>
  <Button variant="outline" size="sm" class="h-8" onclick={downloadCsv} disabled={!list.items.length}>
    <Download class="mr-2 h-3.5 w-3.5" />
    {t('formResponses.downloadCsv')}
  </Button>
  {#if anyFiles}
    <Button
      variant="outline"
      size="sm"
      class="h-8"
      onclick={() => void downloadAllFiles()}
      disabled={downloading === 'all'}
      data-testid="responses-files-zip"
    >
      <Paperclip class="mr-2 h-3.5 w-3.5" />
      {t('formResponses.downloadAllFiles')}
    </Button>
  {/if}
{/snippet}

<Card.Root class="deck-section gap-3">
  <DeckSectionHeading
    drawing="forms"
    title={t('formResponses.title')}
    description={t('formResponses.description')}
  />
  <Card.Content data-testid="form-responses-panel">
    <TableToolbar count={responseCount} {filters} {actions} sticky={false} />
    {#if list.loading || summaryLoading}
      <TableSkeleton columns={3} rows={2} showSearch={false} />
    {:else if noAccess}
      <p class="text-sm text-muted-foreground">{t('formResponses.noAccess')}</p>
    {:else if list.error && !list.items.length}
      <p class="text-sm text-destructive" in:appear>
        {t('formResponses.loadFailed', { error: list.error })}
      </p>
    {:else}
      <div class="space-y-4">
        <FormError
          message={summaryError ? t('formResponses.summaryLoadFailed', { error: summaryError }) : null}
        />
        {#if !summaryError && summary && !summary.buckets.length}
          <!-- no response on any form yet: the summary table still stands,
               its heads over one quiet row -->
          <EmptyTable message={t('formResponses.empty')} columns={summaryHeads} />
        {:else if !summaryError && summary}
          <div class="sheet overflow-x-auto">
            <Table.Root>
              <Table.Header>
                <Table.Row>
                  {#each summaryHeads as head (head.title)}
                    <Table.Head>{head.title}</Table.Head>
                  {/each}
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {#each summary.buckets as bucket, i (i)}
                  <!-- SECURITY: shareTokenName is user text and placement is
                       visitor-influenced — escaped {} interpolation only. -->
                  <Table.Row>
                    <Table.Cell class="font-medium">{bucket.formName}</Table.Cell>
                    <Table.Cell>
                      {#if bucket.shareTokenName !== null}
                        {bucket.shareTokenName}
                      {:else}
                        <span class="text-muted-foreground">{t('formResponses.linkGone')}</span>
                      {/if}
                    </Table.Cell>
                    <Table.Cell>{sourceLabel(bucket.source)}</Table.Cell>
                    <Table.Cell>
                      {#if bucket.placement !== null}
                        {bucket.placement}
                      {:else}
                        <span class="text-muted-foreground">—</span>
                      {/if}
                    </Table.Cell>
                    <Table.Cell>{bucket.count}</Table.Cell>
                    <Table.Cell>{formatTimeAgo(bucket.lastResponseAt)}</Table.Cell>
                  </Table.Row>
                {/each}
              </Table.Body>
            </Table.Root>
          </div>
        {/if}

        {#if !list.items.length}
          <!-- One sentence, once: with no response at all the summary table
               above already says it. The responses are a list, so here the
               empty frame stands in for it. -->
          {#if summaryError || !summary || summary.buckets.length}
            <EmptyTable message={hasFilters ? t('formResponses.emptyFiltered') : t('formResponses.empty')} />
          {/if}
        {:else}
          <ul class="space-y-3">
            {#each list.items as response (response.id)}
              <li
                class="space-y-2 rounded-[10px] border border-[var(--hairline)] bg-[var(--plate-strong)] p-4"
              >
                <div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <!-- SECURITY: formName/shareTokenName are owner text and
                       placement is visitor-influenced — Svelte {…}
                       interpolation renders them escaped. NEVER {@html}. -->
                  <span class="font-medium text-foreground">{response.formName}</span>
                  {#if response.shareTokenName !== null}
                    <span>· {response.shareTokenName}</span>
                  {:else if response.shareTokenId === null}
                    <span>· {t('formResponses.linkGone')}</span>
                  {/if}
                  <Badge variant="secondary">{sourceLabel(response.source)}</Badge>
                  {#if response.placement !== null}
                    <span>· {response.placement}</span>
                  {/if}
                  <span>{t('formResponses.onVersion', { n: response.version })}</span>
                  <span>{formatTimeAgo(response.createdAt)}</span>
                  {#if response.revision > 1}
                    <Badge variant="outline" data-testid="response-revision">
                      {t('formResponses.revisionBadge', { n: response.revision })}
                    </Badge>
                  {:else if isUpdated(response)}
                    <Badge variant="outline">{t('formResponses.updatedBadge')}</Badge>
                  {/if}
                </div>
                <dl class="space-y-1">
                  {#each payloadEntries(response) as [key, value] (key)}
                    <!-- SECURITY: payload keys AND values are RAW anonymous-
                         respondent input. Svelte {…} interpolation escapes
                         them — "<img src=x onerror=…>" must appear as
                         literal text. NEVER switch to {@html} or move these
                         into attributes. -->
                    <div class="flex gap-2 text-sm">
                      <dt class="w-1/3 min-w-0 shrink-0 break-words font-medium">{key}</dt>
                      <dd class="min-w-0 whitespace-pre-wrap break-words">{value}</dd>
                    </div>
                  {/each}
                </dl>
                {#if response.files.length}
                  <div
                    class="rounded-[8px] border border-dashed border-[var(--hairline)] px-3 py-2 text-xs"
                    data-testid="response-files"
                  >
                    <div class="mb-1 inline-flex items-center gap-1 font-medium">
                      <Paperclip class="h-3 w-3" />
                      {t('formResponses.filesTitle', { n: response.files.length })}
                    </div>
                    <dl class="space-y-1">
                      {#each groupFilesByField(response.files) as group (group.field)}
                        <!-- SECURITY: field and file names are RAW anonymous-
                             respondent input — escaped {…} only, NEVER {@html}.
                             The request carries ids only, never a name. -->
                        <div class="flex gap-2">
                          <dt class="w-1/3 min-w-0 shrink-0 break-words font-medium">{group.field}</dt>
                          <dd class="min-w-0 flex-1">
                            <ul class="space-y-0.5">
                              {#each group.files as file (file.id)}
                                <li class="flex items-baseline justify-between gap-3">
                                  <button
                                    type="button"
                                    onclick={() => void downloadResponseFile(response, file)}
                                    disabled={downloading === `file:${file.id}`}
                                    class="inline-flex min-w-0 items-baseline gap-1 text-left underline-offset-4 hover:underline disabled:opacity-60"
                                    title={t('formResponses.downloadFile')}
                                    data-testid="response-file"
                                  >
                                    <Download class="h-3 w-3 shrink-0 self-center text-muted-foreground" />
                                    <span class="min-w-0 truncate font-mono">{file.name}</span>
                                  </button>
                                  <span class="shrink-0 text-muted-foreground">
                                    {formatBytes(file.sizeBytes)}
                                  </span>
                                </li>
                              {/each}
                            </ul>
                          </dd>
                        </div>
                      {/each}
                    </dl>
                  </div>
                {/if}
                <div class="-mx-2 flex flex-wrap gap-x-1 gap-y-1 pt-1">
                  {#if response.files.length}
                    <Button
                      variant="ghost"
                      size="sm"
                      onclick={() => void downloadResponseFiles(response)}
                      disabled={downloading === `zip:${response.id}`}
                      data-testid="response-files-zip"
                    >
                      <Download class="h-3.5 w-3.5" />
                      {t('formResponses.downloadFiles')}
                    </Button>
                  {/if}
                  {#if response.revision > 1}
                    <Button variant="ghost" size="sm" onclick={() => void openHistory(response)}>
                      {t('formResponses.actionHistory')}
                    </Button>
                  {/if}
                  <Button
                    variant="ghost"
                    size="sm"
                    class="text-destructive hover:text-destructive"
                    onclick={() => {
                      deleteTarget = response;
                      showDeleteDialog = true;
                    }}
                  >
                    {t('formResponses.actionDelete')}
                  </Button>
                </div>
              </li>
            {/each}
          </ul>
          {#if list.nextCursor}
            <div class="flex justify-center py-2" transition:reveal>
              <Button
                variant="outline"
                size="sm"
                onclick={() => void list.loadMore()}
                disabled={list.loadingMore}
              >
                {list.loadingMore ? t('common.loading') : t('common.loadMore')}
              </Button>
            </div>
          {/if}
        {/if}
      </div>
    {/if}
    {#if notify !== null}
      <!-- the owner's own switch, after the responses it is about: the whole
           row is the label (app.css `.choice`), the switch named by the
           title alone -->
      <label for="responses-notify" class="choice notify" data-testid="form-responses-notify" in:appear>
        <Checkbox
          id="responses-notify"
          checked={notify}
          disabled={notifySaving}
          onCheckedChange={(v) => void setNotify(v === true)}
          aria-labelledby="responses-notify-name"
          aria-describedby="responses-notify-hint"
          class="mt-0.5"
        />
        <span class="min-w-0">
          <span id="responses-notify-name" class="choice-name">{t('formResponses.notifyLabel')}</span>
          <span id="responses-notify-hint" class="choice-hint block">{t('formResponses.notifyHint')}</span>
        </span>
      </label>
    {/if}
  </Card.Content>
</Card.Root>

<Dialog.Root bind:open={showHistory}>
  <Dialog.Content size="lg" framed data-testid="response-history">
    <Dialog.Header>
      <Dialog.Title>{t('formResponses.historyTitle')}</Dialog.Title>
      <Dialog.Description>{t('formResponses.historyDescription')}</Dialog.Description>
    </Dialog.Header>
    <Dialog.Body>
      {#if historyLoading || !history}
        <TableSkeleton rows={3} />
      {:else}
        <ol class="space-y-3" in:appear>
          {#each history.versions as revision (revision.revision)}
            <li class="space-y-2 rounded-[10px] border border-[var(--hairline)] p-3">
              <div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <!-- SECURITY: shareTokenName is owner text and placement is
                   visitor-influenced — {…} interpolation escapes. NEVER {@html}. -->
                <span class="font-medium text-foreground">
                  {t('formResponses.historyRevision', { n: revision.revision })}
                </span>
                <span>{formatTimeAgo(revision.createdAt)}</span>
                {#if revision.shareTokenName !== null}
                  <span>· {revision.shareTokenName}</span>
                {:else if revision.shareTokenId === null}
                  <span>· {t('formResponses.linkGone')}</span>
                {/if}
                <Badge variant="secondary">{sourceLabel(revision.source)}</Badge>
                {#if revision.placement !== null}
                  <span>· {revision.placement}</span>
                {/if}
                <span>{t('formResponses.onVersion', { n: revision.version })}</span>
              </div>
              <dl class="space-y-1">
                {#each versionEntries(revision.payload) as [key, value] (key)}
                  <!-- SECURITY: RAW anonymous-respondent input at every revision.
                     {…} escapes it; NEVER {@html}, never an attribute. -->
                  <div class="flex gap-2 text-sm">
                    <dt class="w-1/3 min-w-0 shrink-0 break-words font-medium">{key}</dt>
                    <dd class="min-w-0 whitespace-pre-wrap break-words">{value}</dd>
                  </div>
                {/each}
              </dl>
              {#if revision.files?.length}
                <!-- A revision keeps the NAMES it held, never a handle on the
                   bytes: text only, no link. RAW respondent input — {…} only. -->
                <div
                  class="rounded-[8px] border border-dashed border-[var(--hairline)] px-3 py-2 text-xs"
                  data-testid="revision-files"
                >
                  <div class="mb-1 inline-flex items-center gap-1 font-medium">
                    <Paperclip class="h-3 w-3" />
                    {t('formResponses.filesTitle', { n: revision.files.length })}
                  </div>
                  <dl class="space-y-1">
                    {#each groupFilesByField(revision.files) as group (group.field)}
                      <div class="flex gap-2">
                        <dt class="w-1/3 min-w-0 shrink-0 break-words font-medium">{group.field}</dt>
                        <dd class="min-w-0 flex-1">
                          <ul class="space-y-0.5">
                            {#each group.files as file (file.id)}
                              <li class="flex items-baseline justify-between gap-3">
                                <span class="min-w-0 truncate font-mono">{file.name}</span>
                                <span class="shrink-0 text-muted-foreground"
                                  >{formatBytes(file.sizeBytes)}</span
                                >
                              </li>
                            {/each}
                          </ul>
                        </dd>
                      </div>
                    {/each}
                  </dl>
                </div>
              {/if}
            </li>
          {/each}
        </ol>
      {/if}
    </Dialog.Body>
    <Dialog.Footer>
      <Button onclick={() => (showHistory = false)}>{t('common.done')}</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<ConfirmDialog
  bind:open={showDeleteDialog}
  title={t('formResponses.deleteConfirmTitle')}
  description={t('formResponses.deleteConfirmDescription')}
  confirmLabel={t('formResponses.actionDelete')}
  onClose={() => {
    showDeleteDialog = false;
    deleteTarget = null;
  }}
  onConfirm={() => void submitDelete()}
  loading={deleteLoading}
/>

<style>
  /* the switch stands alone, in the ruled list's own frame */
  .notify {
    margin-top: 16px;
    border: 1px solid var(--hairline);
    border-radius: 10px;
    background: color-mix(in oklab, var(--ground-2) 38%, transparent);
  }
</style>
