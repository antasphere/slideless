<script lang="ts">
  import TableSkeleton from '$lib/components/shared/TableSkeleton.svelte';
  import ConfirmDialog from '$lib/components/shared/ConfirmDialog.svelte';
  import * as Card from '$lib/components/ui/card/index.js';
  import * as Select from '$lib/components/ui/select/index.js';
  import * as Table from '$lib/components/ui/table/index.js';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import Download from '@lucide/svelte/icons/download';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import { createPagedList } from '$lib/stores/pagedList.svelte';
  import { api, errorMessage, PlatformApiError } from '$lib/api';
  import { buildCsv } from '$lib/csv';
  import { formatTimeAgo } from '$lib/format';
  import { toast } from 'svelte-sonner';
  import { t } from '$lib/i18n';
  import type { FormResponse, FormResponseSourceValue, FormResponsesSummary } from '@slideless/contract';

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

  function isUpdated(response: FormResponse): boolean {
    return new Date(response.updatedAt).getTime() > new Date(response.createdAt).getTime();
  }

  // ── CSV export of the currently filtered, currently loaded rows ────────
  function downloadCsv() {
    const rows = list.items;
    if (!rows.length) return;
    // Respondent-chosen payload keys become extra columns (union, in first-
    // seen order). buildCsv guards EVERY cell — keys included — against
    // formula injection.
    const payloadKeys = [...new Set(rows.flatMap((r) => Object.keys(r.payload)))];
    const header = ['form', 'link', 'source', 'placement', 'respondentEmail', 'version', 'createdAt', 'updatedAt', ...payloadKeys];
    const csv = buildCsv(
      header,
      rows.map((r) => [
        r.formName,
        r.shareTokenName ?? '',
        r.source,
        r.placement ?? '',
        r.respondentEmail ?? '',
        String(r.version),
        r.createdAt,
        r.updatedAt,
        ...payloadKeys.map((key) => {
          const value = r.payload[key];
          if (value === undefined) return '';
          return Array.isArray(value) ? value.join(', ') : value;
        })
      ])
    );
    // Filename: only the server-validated form slug may appear (defense in
    // depth — the charset gate already holds at the contract).
    const formPart = filterForm !== 'all' && /^[A-Za-z0-9._-]{1,64}$/.test(filterForm) ? `-${filterForm}` : '';
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
        <Button
          variant="outline"
          size="sm"
          class="h-8"
          onclick={downloadCsv}
          disabled={!list.items.length}
        >
          <Download class="mr-2 h-3.5 w-3.5" />
          {t('formResponses.downloadCsv')}
        </Button>
      </div>
    </div>
  </Card.Header>
  <Card.Content data-testid="form-responses-panel">
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
                  {#if response.respondentEmail !== null}
                    <span>· {response.respondentEmail}</span>
                  {/if}
                  <span>{t('formResponses.onVersion', { n: response.version })}</span>
                  <span>{formatTimeAgo(response.createdAt)}</span>
                  {#if isUpdated(response)}
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
                <div class="flex gap-2 pt-1">
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
