<script lang="ts">
  import TableSkeleton from '$lib/components/shared/TableSkeleton.svelte';
  import ConfirmDialog from '$lib/components/shared/ConfirmDialog.svelte';
  import * as Card from '$lib/components/ui/card/index.js';
  import * as Select from '$lib/components/ui/select/index.js';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
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

<Card.Root>
  <Card.Header>
    <div class="flex flex-wrap items-start justify-between gap-4">
      <div class="space-y-1">
        <Card.Title class="text-base">{t('annotations.title')}</Card.Title>
        <Card.Description>{t('annotations.description')}</Card.Description>
      </div>
      <div class="flex items-end gap-3">
        <div class="space-y-1">
          <Label for="annotation-filter-version" class="text-xs text-muted-foreground">
            {t('annotations.filterVersion')}
          </Label>
          <Select.Root
            type="single"
            value={filterVersion}
            onValueChange={(v) => {
              if (v) filterVersion = v;
            }}
          >
            <Select.Trigger id="annotation-filter-version" class="h-8 w-[150px]">
              {filterVersion === 'all' ? t('annotations.filterAllVersions') : `v${filterVersion}`}
            </Select.Trigger>
            <Select.Content>
              <Select.Item value="all" label={t('annotations.filterAllVersions')} />
              {#each versions as version (version.version)}
                <Select.Item value={String(version.version)} label={`v${version.version}`} />
              {/each}
            </Select.Content>
          </Select.Root>
        </div>
        <div class="space-y-1">
          <Label for="annotation-filter-status" class="text-xs text-muted-foreground">
            {t('annotations.filterStatus')}
          </Label>
          <Select.Root
            type="single"
            value={filterStatus}
            onValueChange={(v) => {
              if (v === 'all' || v === 'open' || v === 'resolved') filterStatus = v;
            }}
          >
            <Select.Trigger id="annotation-filter-status" class="h-8 w-[130px]">
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
        </div>
      </div>
    </div>
  </Card.Header>
  <Card.Content data-testid="annotations-panel">
    {#if list.loading}
      <TableSkeleton columns={3} rows={2} showSearch={false} />
    {:else if list.error && !list.items.length}
      <p class="text-sm text-destructive">{t('annotations.loadFailed', { error: list.error })}</p>
    {:else if !list.items.length}
      <p class="text-sm text-muted-foreground">
        {hasFilters ? t('annotations.emptyFiltered') : t('annotations.empty')}
      </p>
    {:else}
      <ul class="space-y-3">
        {#each list.items as annotation (annotation.id)}
          <li class="space-y-2 rounded-md border p-4">
            <div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <!-- SECURITY: authorLabel() may return the reviewer-controlled
                   authorName — Svelte {…} interpolation renders it as escaped
                   text. NEVER switch this to {@html}. -->
              <span class="font-medium text-foreground">{authorLabel(annotation)}</span>
              {#if annotation.shareTokenId}
                <span>{t('annotations.viaShareLink')}</span>
              {/if}
              <span>{t('annotations.onVersion', { n: annotation.version })}</span>
              <Badge variant={annotation.status === 'resolved' ? 'outline' : 'secondary'}>
                {annotation.status === 'resolved'
                  ? t('annotations.statusResolved')
                  : t('annotations.statusOpen')}
              </Badge>
              <span>{formatTimeAgo(annotation.createdAt)}</span>
            </div>
            <!-- SECURITY: the note body is REVIEWER-CONTROLLED raw text.
                 Svelte {…} interpolation escapes it — a body like
                 "<img src=x onerror=…>" must appear as literal text, never
                 become an element. NEVER switch this to {@html}. -->
            <p class="whitespace-pre-wrap break-words text-sm">{annotation.body}</p>
            {#if selectionText(annotation)}
              <!-- SECURITY: the selection anchor is reviewer-controlled JSON,
                   rendered as escaped text via {…} — never {@html}. -->
              <p class="break-all font-mono text-xs text-muted-foreground">
                {t('annotations.selectionLabel')}: {selectionText(annotation)}
              </p>
            {/if}
            <div class="flex gap-2 pt-1">
              {#if annotation.status === 'open'}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={mutatingId === annotation.id}
                  onclick={() => void setStatus(annotation, 'resolved')}
                >
                  {t('annotations.actionResolve')}
                </Button>
              {:else}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={mutatingId === annotation.id}
                  onclick={() => void setStatus(annotation, 'open')}
                >
                  {t('annotations.actionReopen')}
                </Button>
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
        <div class="flex justify-center py-2">
          <Button variant="outline" size="sm" onclick={() => void list.loadMore()} disabled={list.loadingMore}>
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
