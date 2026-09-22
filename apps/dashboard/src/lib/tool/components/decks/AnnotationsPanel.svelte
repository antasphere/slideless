<script lang="ts">
  import TableSkeleton from '$lib/components/shared/TableSkeleton.svelte';
  import { docsPage } from '$lib/docs';
  import TableToolbar from '$lib/components/shared/TableToolbar.svelte';
  import { rowCount } from '$lib/components/shared/DataTable.svelte';
  import ConfirmDialog from '$lib/components/shared/ConfirmDialog.svelte';
  import * as Card from '$lib/components/ui/card/index.js';
  import DeckSectionHeading from './DeckSectionHeading.svelte';
  import EmptyTable from './EmptyTable.svelte';
  import * as Select from '$lib/components/ui/select/index.js';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { appear, reveal } from '$lib/components/ui/reveal/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import { createPagedList } from '$lib/stores/pagedList.svelte';
  import { api, errorMessage } from '$lib/api';
  import { formatTimeAgo } from '$lib/format';
  import { toast } from 'svelte-sonner';
  import { t } from '$lib/i18n';
  import type { Annotation, AnnotationStatus, PresentationVersion } from '@slideless/contract';

  /**
   * SECURITY — READ BEFORE TOUCHING THE MARKUP BELOW.
   *
   * Annotation `body`, `authorName`, and `selection` are REVIEWER-CONTROLLED
   * and stored RAW server-side. This panel runs on the APP ORIGIN: rendering
   * any of these with {@html} is stored XSS = session takeover. Every render
   * site below uses Svelte's `{value}` text interpolation, which escapes.
   * NEVER introduce {@html}, innerHTML, or createRawSnippet on these fields.
   */

  interface Props {
    deckId: string;
    versions: PresentationVersion[];
    /** Resolves a user id to a display label (member email) — page-provided. */
    resolveUser: (userId: string) => string;
  }

  let { deckId, versions, resolveUser }: Props = $props();

  let filterVersion = $state('all');
  let filterStatus = $state<'all' | AnnotationStatus>('all');

  const list = createPagedList<Annotation>(async (p) => {
    const { annotations, nextCursor } = await api.annotations(deckId, {
      ...p,
      ...(filterVersion !== 'all' ? { version: Number(filterVersion) } : {}),
      ...(filterStatus !== 'all' ? { status: filterStatus } : {})
    });
    return { items: annotations, nextCursor };
  });

  const hasFilters = $derived(filterVersion !== 'all' || filterStatus !== 'all');
  // the toolbar's quiet line: how many notes match, once they are all here
  const noteCount = $derived(
    list.loading || list.nextCursor || !list.items.length
      ? undefined
      : rowCount('annotations.countOne', 'annotations.count')(list.items.length, list.items.length)
  );

  $effect(() => {
    // Track the filters so changing either re-fetches page 1.
    void [filterVersion, filterStatus];
    void list.load();
  });

  // Reviewer-facing author line. All parts are rendered as escaped text.
  function authorLabel(annotation: Annotation): string {
    if (annotation.authorName) return annotation.authorName;
    if (annotation.authorUserId) return resolveUser(annotation.authorUserId);
    return t('annotations.anonymous');
  }

  function selectionText(annotation: Annotation): string | null {
    const keys = Object.keys(annotation.selection);
    if (keys.length === 0) return null;
    try {
      return JSON.stringify(annotation.selection);
    } catch {
      return null;
    }
  }

  /** Where the overlay's annotations page lives on the public docs site. */
  const ANNOTATIONS_DOCS_URL = docsPage('sharing/annotations');

  interface AnchorSummary {
    label: string;
    quote: string | null;
    location: string;
  }

  function asString(v: unknown): string | null {
    return typeof v === 'string' && v.trim() !== '' ? v : null;
  }

  /**
   * Human rendering of the overlay's anchor descriptor (v2: type/page/
   * container/quote — see viewer/overlay.ts) with the v1 quote-only shape
   * still recognized. Unknown shapes fall back to the raw JSON line below.
   * Every returned string is reviewer-controlled — render with {…} only.
   */
  function anchorSummary(annotation: Annotation): AnchorSummary | null {
    const sel = annotation.selection as Record<string, unknown>;
    const type = asString(sel.type);
    const quote = asString(sel.quote);
    if (type !== 'text' && type !== 'point' && type !== 'region') {
      // Legacy v1 anchors ({type:'text', quote}) land here when type is
      // missing; anything quote-less and unrecognized gets the JSON line.
      return quote ? { label: t('annotations.anchorText'), quote: quote.slice(0, 200), location: '' } : null;
    }
    const bits: string[] = [];
    const page = asString(sel.page);
    if (page) bits.push(page);
    const container = sel.container;
    if (container && typeof container === 'object') {
      const c = container as Record<string, unknown>;
      const kind = asString(c.kind);
      if (kind && typeof c.index === 'number') bits.push(`${kind} ${c.index}`);
      const heading = asString(c.heading);
      if (heading) bits.push(`“${heading.slice(0, 120)}”`);
    }
    const label =
      type === 'point'
        ? t('annotations.anchorPoint')
        : type === 'region'
          ? t('annotations.anchorRegion')
          : t('annotations.anchorText');
    return { label, quote: quote ? quote.slice(0, 200) : null, location: bits.join(' · ') };
  }

  let mutatingId = $state<string | null>(null);

  async function setStatus(annotation: Annotation, status: AnnotationStatus) {
    mutatingId = annotation.id;
    try {
      await api.updateAnnotation(deckId, annotation.id, { status });
      toast.success(status === 'resolved' ? t('annotations.resolvedToast') : t('annotations.reopenedToast'));
      await list.refresh();
    } catch (e) {
      toast.error(errorMessage(e, t('common.updateFailed')));
    } finally {
      mutatingId = null;
    }
  }

  // ── Delete ─────────────────────────────────────────────────────────────
  let showDeleteDialog = $state(false);
  let deleteLoading = $state(false);
  let deleteTarget = $state<Annotation | null>(null);

  async function submitDelete() {
    if (!deleteTarget) return;
    deleteLoading = true;
    try {
      await api.deleteAnnotation(deckId, deleteTarget.id);
      toast.success(t('annotations.deletedToast'));
      showDeleteDialog = false;
      deleteTarget = null;
      await list.refresh();
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
  <Label for="annotation-filter-version" class="sr-only">{t('annotations.filterVersion')}</Label>
  <Select.Root
    type="single"
    value={filterVersion}
    onValueChange={(v) => {
      if (v) filterVersion = v;
    }}
  >
    <Select.Trigger id="annotation-filter-version" class="h-8 w-auto min-w-[150px] max-w-full">
      {filterVersion === 'all' ? t('annotations.filterAllVersions') : `v${filterVersion}`}
    </Select.Trigger>
    <Select.Content>
      <Select.Item value="all" label={t('annotations.filterAllVersions')} />
      {#each versions as version (version.version)}
        <Select.Item value={String(version.version)} label={`v${version.version}`} />
      {/each}
    </Select.Content>
  </Select.Root>
  <Label for="annotation-filter-status" class="sr-only">{t('annotations.filterStatus')}</Label>
  <Select.Root
    type="single"
    value={filterStatus}
    onValueChange={(v) => {
      if (v === 'all' || v === 'open' || v === 'resolved') filterStatus = v;
    }}
  >
    <Select.Trigger id="annotation-filter-status" class="h-8 w-auto min-w-[130px] max-w-full">
      {filterStatus === 'all'
        ? t('annotations.filterAll')
        : filterStatus === 'open'
          ? t('annotations.statusOpen')
          : t('annotations.statusResolved')}
    </Select.Trigger>
    <Select.Content>
      <Select.Item value="all" label={t('annotations.filterAll')} />
      <Select.Item value="open" label={t('annotations.statusOpen')} />
      <Select.Item value="resolved" label={t('annotations.statusResolved')} />
    </Select.Content>
  </Select.Root>
{/snippet}

<Card.Root class="deck-section gap-3">
  <DeckSectionHeading
    drawing="annotations"
    title={t('annotations.title')}
    description={t('annotations.description')}
  >
    <a
      href={ANNOTATIONS_DOCS_URL}
      target="_blank"
      rel="noreferrer"
      class="underline underline-offset-2 hover:text-foreground"
    >
      {t('annotations.learnMore')}
    </a>
  </DeckSectionHeading>
  <Card.Content data-testid="annotations-panel">
    <TableToolbar count={noteCount} {filters} sticky={false} />
    {#if list.loading}
      <TableSkeleton columns={3} rows={2} showSearch={false} />
    {:else if list.error && !list.items.length}
      <p class="text-sm text-destructive" in:appear>{t('annotations.loadFailed', { error: list.error })}</p>
    {:else if !list.items.length}
      <!-- the notes are a list, not a table: the empty section keeps its frame -->
      <EmptyTable message={hasFilters ? t('annotations.emptyFiltered') : t('annotations.empty')} />
    {:else}
      <ul class="space-y-3">
        {#each list.items as annotation (annotation.id)}
          <li class="space-y-2 rounded-[10px] border border-[var(--hairline)] bg-[var(--plate-strong)] p-4">
            <div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <!-- SECURITY: authorLabel() may return the reviewer-controlled
                   authorName — Svelte {…} interpolation renders it as escaped
                   text. NEVER switch this to {@html}. -->
              <span class="font-medium text-foreground">{authorLabel(annotation)}</span>
              {#if annotation.shareTokenId}
                <span>{t('annotations.viaShareLink')}</span>
              {/if}
              <span>{t('annotations.onVersion', { n: annotation.version })}</span>
              {#key annotation.status}
                <span class="inline-flex" in:appear>
                  <Badge variant={annotation.status === 'resolved' ? 'outline' : 'secondary'}>
                    {annotation.status === 'resolved'
                      ? t('annotations.statusResolved')
                      : t('annotations.statusOpen')}
                  </Badge>
                </span>
              {/key}
              <span>{formatTimeAgo(annotation.createdAt)}</span>
            </div>
            <!-- SECURITY: the note body is REVIEWER-CONTROLLED raw text.
                 Svelte {…} interpolation escapes it — a body like
                 "<img src=x onerror=…>" must appear as literal text, never
                 become an element. NEVER switch this to {@html}. -->
            <p class="whitespace-pre-wrap break-words text-sm">{annotation.body}</p>
            {#if anchorSummary(annotation)}
              {@const anchor = anchorSummary(annotation)!}
              <!-- SECURITY: quote, location, and page all come out of the
                   reviewer-controlled selection JSON — Svelte {…}
                   interpolation escapes them. NEVER switch to {@html}. -->
              <div class="space-y-1">
                {#if anchor.quote}
                  <blockquote class="border-l-2 pl-2 text-xs italic text-muted-foreground">
                    “{anchor.quote}”
                  </blockquote>
                {/if}
                <p class="text-xs text-muted-foreground">
                  {anchor.label}{anchor.location ? ` · ${anchor.location}` : ''}
                </p>
              </div>
            {:else if selectionText(annotation)}
              <!-- SECURITY: the selection anchor is reviewer-controlled JSON,
                   rendered as escaped text via {…} — never {@html}. -->
              <p class="break-all font-mono text-xs text-muted-foreground">
                {t('annotations.selectionLabel')}: {selectionText(annotation)}
              </p>
            {/if}
            <div class="flex gap-2 pt-1">
              {#if annotation.status === 'open'}
                <span class="inline-flex" in:appear>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={mutatingId === annotation.id}
                    onclick={() => void setStatus(annotation, 'resolved')}
                  >
                    {t('annotations.actionResolve')}
                  </Button>
                </span>
              {:else}
                <span class="inline-flex" in:appear>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={mutatingId === annotation.id}
                    onclick={() => void setStatus(annotation, 'open')}
                  >
                    {t('annotations.actionReopen')}
                  </Button>
                </span>
              {/if}
              <Button
                variant="ghost"
                size="sm"
                class="text-destructive hover:text-destructive"
                onclick={() => {
                  deleteTarget = annotation;
                  showDeleteDialog = true;
                }}
              >
                {t('annotations.actionDelete')}
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
  </Card.Content>
</Card.Root>

<ConfirmDialog
  bind:open={showDeleteDialog}
  title={t('annotations.deleteConfirmTitle')}
  description={t('annotations.deleteConfirmDescription')}
  confirmLabel={t('annotations.actionDelete')}
  onClose={() => {
    showDeleteDialog = false;
    deleteTarget = null;
  }}
  onConfirm={() => void submitDelete()}
  loading={deleteLoading}
/>
