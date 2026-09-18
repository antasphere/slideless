<script lang="ts">
  import TableSkeleton from '$lib/components/shared/TableSkeleton.svelte';
  import ConfirmDialog from '$lib/components/shared/ConfirmDialog.svelte';
  import * as Card from '$lib/components/ui/card/index.js';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import * as Select from '$lib/components/ui/select/index.js';
  import * as Table from '$lib/components/ui/table/index.js';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Checkbox } from '$lib/components/ui/checkbox/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import Download from '@lucide/svelte/icons/download';
  import Paperclip from '@lucide/svelte/icons/paperclip';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import { createPagedList } from '$lib/stores/pagedList.svelte';
  import { api, errorMessage, PlatformApiError } from '$lib/api';
  import {
    buildResponsesCsv,
    formResponseFilesZipUrl,
    formResponseFileUrl,
    formResponsesFilesZipUrl,
    groupFilesByField
  } from '$lib/decks/form-responses';
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
   * (PRDCT-2403): text interpolation only. A download `href` is built from
   * IDS ONLY ($lib/decks/form-responses), never from a name, and the server
   * answers `attachment` + `nosniff`, so a respondent's bytes are saved,
   * never rendered on this origin.
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
  // Downloads are plain same-origin anchors, the deck attachments' way
  // (DeckMaster, VersionHistorySheet): the session cookie rides the
  // navigation, the browser saves what the server sends as `attachment`.
  // The bare `download` attribute names nothing (the server's
  // Content-Disposition keeps the file name): it only keeps the SvelteKit
  // router off the click and the person on this page if the answer is a 404.
  const anyFiles = $derived(list.items.some((response) => response.files.length > 0));
  const allFilesZipUrl = $derived(
    formResponsesFilesZipUrl(deckId, filterForm !== 'all' ? { form: filterForm } : {})
  );

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
    // guarded against formula injection ($lib/decks/form-responses).
    const csv = buildResponsesCsv(rows);
    // Filename: only the server-validated form slug may appear (defense in
    // depth — the charset gate already holds at the contract).
    const formPart =
      filterForm !== 'all' && /^[A-Za-z0-9._-]{1,64}$/.test(filterForm) ? `-${filterForm}` : '';
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `responses${formPart}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
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

<Card.Root>
  <Card.Header>
    <div class="flex flex-wrap items-start justify-between gap-4">
      <div class="space-y-1">
        <Card.Title class="text-base">{t('formResponses.title')}</Card.Title>
        <Card.Description>{t('formResponses.description')}</Card.Description>
      </div>
      <div class="flex flex-wrap items-end gap-3">
        <div class="space-y-1">
          <Label for="response-filter-form" class="text-xs text-muted-foreground">
            {t('formResponses.filterForm')}
          </Label>
          <Select.Root
            type="single"
            value={filterForm}
            onValueChange={(v) => {
              if (v) filterForm = v;
            }}
          >
            <Select.Trigger id="response-filter-form" class="h-8 w-[150px]">
              {filterForm === 'all' ? t('formResponses.filterAllForms') : filterForm}
            </Select.Trigger>
            <Select.Content>
              <Select.Item value="all" label={t('formResponses.filterAllForms')} />
              {#each formNames as formName (formName)}
                <Select.Item value={formName} label={formName} />
              {/each}
            </Select.Content>
          </Select.Root>
        </div>
        <div class="space-y-1">
          <Label for="response-filter-source" class="text-xs text-muted-foreground">
            {t('formResponses.filterSource')}
          </Label>
          <Select.Root
            type="single"
            value={filterSource}
            onValueChange={(v) => {
              if (v === 'all' || v === 'link' || v === 'embed') filterSource = v;
            }}
          >
            <Select.Trigger id="response-filter-source" class="h-8 w-[150px]">
              {filterSource === 'all' ? t('formResponses.filterAllSources') : sourceLabel(filterSource)}
            </Select.Trigger>
            <Select.Content>
              <Select.Item value="all" label={t('formResponses.filterAllSources')} />
              <Select.Item value="link" label={t('formResponses.sourceLink')} />
              <Select.Item value="embed" label={t('formResponses.sourceEmbed')} />
            </Select.Content>
          </Select.Root>
        </div>
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
            href={allFilesZipUrl}
            download
            data-testid="responses-files-zip"
          >
            <Paperclip class="mr-2 h-3.5 w-3.5" />
            {t('formResponses.downloadAllFiles')}
          </Button>
        {/if}
      </div>
    </div>
  </Card.Header>
  <Card.Content data-testid="form-responses-panel">
    {#if notify !== null}
      <div class="mb-4 flex items-start gap-2" data-testid="form-responses-notify">
        <Checkbox
          id="responses-notify"
          checked={notify}
          disabled={notifySaving}
          onCheckedChange={(v) => void setNotify(v === true)}
        />
        <Label for="responses-notify" class="font-normal">
          {t('formResponses.notifyLabel')}
          <span class="text-muted-foreground">{t('formResponses.notifyHint')}</span>
        </Label>
      </div>
    {/if}
    {#if list.loading || summaryLoading}
      <TableSkeleton columns={3} rows={2} showSearch={false} />
    {:else if noAccess}
      <p class="text-sm text-muted-foreground">{t('formResponses.noAccess')}</p>
    {:else if list.error && !list.items.length}
      <p class="text-sm text-destructive">{t('formResponses.loadFailed', { error: list.error })}</p>
    {:else}
      <div class="space-y-4">
        {#if summaryError}
          <p class="text-sm text-destructive">
            {t('formResponses.summaryLoadFailed', { error: summaryError })}
          </p>
        {:else if summary && summary.buckets.length}
          <div class="overflow-x-auto rounded-md border">
            <Table.Root>
              <Table.Header>
                <Table.Row>
                  <Table.Head>{t('formResponses.colForm')}</Table.Head>
                  <Table.Head>{t('formResponses.colLink')}</Table.Head>
                  <Table.Head>{t('formResponses.colSource')}</Table.Head>
                  <Table.Head>{t('formResponses.colPlacement')}</Table.Head>
                  <Table.Head>{t('formResponses.colCount')}</Table.Head>
                  <Table.Head>{t('formResponses.colLastActivity')}</Table.Head>
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
          <p class="text-xs text-muted-foreground">
            {t('formResponses.totalCount', { n: summary.total })}
          </p>
        {/if}

        {#if !list.items.length}
          <p class="text-sm text-muted-foreground">
            {hasFilters ? t('formResponses.emptyFiltered') : t('formResponses.empty')}
          </p>
        {:else}
          <ul class="space-y-3">
            {#each list.items as response (response.id)}
              <li class="space-y-2 rounded-md border p-4">
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
                  <div class="rounded-md bg-muted/40 px-2.5 py-2 text-xs" data-testid="response-files">
                    <div class="mb-1 inline-flex items-center gap-1 font-medium">
                      <Paperclip class="h-3 w-3" />
                      {t('formResponses.filesTitle', { n: response.files.length })}
                    </div>
                    <dl class="space-y-1">
                      {#each groupFilesByField(response.files) as group (group.field)}
                        <!-- SECURITY: field and file names are RAW anonymous-
                             respondent input — escaped {…} only, NEVER {@html}.
                             The href carries ids only, never a name. -->
                        <div class="flex gap-2">
                          <dt class="w-1/3 min-w-0 shrink-0 break-words font-medium">{group.field}</dt>
                          <dd class="min-w-0 flex-1">
                            <ul class="space-y-0.5">
                              {#each group.files as file (file.id)}
                                <li class="flex items-baseline justify-between gap-3">
                                  <a
                                    href={formResponseFileUrl(deckId, response.id, file.id)}
                                    download
                                    class="inline-flex min-w-0 items-baseline gap-1 underline-offset-4 hover:underline"
                                    title={t('formResponses.downloadFile')}
                                    data-testid="response-file"
                                  >
                                    <Download class="h-3 w-3 shrink-0 self-center text-muted-foreground" />
                                    <span class="min-w-0 truncate font-mono">{file.name}</span>
                                  </a>
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
                <div class="flex gap-2 pt-1">
                  {#if response.files.length}
                    <Button
                      variant="ghost"
                      size="sm"
                      href={formResponseFilesZipUrl(deckId, response.id)}
                      download
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
            <div class="flex justify-center py-2">
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
  </Card.Content>
</Card.Root>

<Dialog.Root bind:open={showHistory}>
  <Dialog.Content class="max-h-[85vh] overflow-y-auto sm:max-w-xl" data-testid="response-history">
    <Dialog.Header>
      <Dialog.Title>{t('formResponses.historyTitle')}</Dialog.Title>
      <Dialog.Description>{t('formResponses.historyDescription')}</Dialog.Description>
    </Dialog.Header>
    {#if historyLoading || !history}
      <TableSkeleton rows={3} />
    {:else}
      <ol class="space-y-3">
        {#each history.versions as revision (revision.revision)}
          <li class="space-y-2 rounded-md border p-3">
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
              <div class="rounded-md bg-muted/40 px-2.5 py-2 text-xs" data-testid="revision-files">
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
                              <span class="shrink-0 text-muted-foreground">{formatBytes(file.sizeBytes)}</span
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
