<script lang="ts">
  import * as Sheet from '$lib/components/ui/sheet/index.js';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { appear, reveal } from '$lib/components/ui/reveal/index.js';
  import Download from '@lucide/svelte/icons/download';
  import Paperclip from '@lucide/svelte/icons/paperclip';
  import VersionThumb from './VersionThumb.svelte';
  import type { PagedList } from '$lib/stores/pagedList.svelte';
  import { api, errorMessage } from '$lib/api';
  import { download } from '$lib/download';
  import { formatBytes, formatTimeAgo } from '$lib/format';
  import { t } from '$lib/i18n';
  import type { Attachment, PresentationVersionSummary } from '@slideless/contract';

  /**
   * The master page's version history (PRDCT-2279, thumbnails and counts
   * with PRDCT-2308): every push newest first, each with its still image
   * at the top of its row, the one the frame shows marked, its views and
   * downloads, and each version's own files (its `downloads/` entries, read
   * from the version detail the server derives — the page reads, it never
   * computes a diff). [[Show]] re-targets the preview through the host's
   * controller and closes the sheet by itself.
   */
  interface Props {
    deckId: string;
    open: boolean;
    /** Page-owned list — shared with the share sheet's pin selects. */
    list: PagedList<PresentationVersionSummary>;
    currentVersion: number;
    /** The version the frame shows (page state). */
    shownVersion: number | null;
    onShow: (version: number) => void;
  }

  let { deckId, open = $bindable(), list, currentVersion, shownVersion, onShow }: Props = $props();

  // One detail fetch per version that carries files, on first open of the
  // sheet; versions are immutable, so the answer never goes stale.
  let attachmentsByVersion = $state<Record<number, Attachment[]>>({});
  let attachmentErrors = $state<Record<number, string>>({});

  $effect(() => {
    if (!open) return;
    for (const version of list.items) {
      if (!version.hasDownloads) continue;
      if (version.version in attachmentsByVersion || version.version in attachmentErrors) continue;
      void loadAttachments(version.version);
    }
  });

  async function loadAttachments(version: number) {
    try {
      const detail = await api.presentationVersion(deckId, version);
      attachmentsByVersion = { ...attachmentsByVersion, [version]: detail.attachments };
    } catch (e) {
      attachmentErrors = { ...attachmentErrors, [version]: errorMessage(e, t('common.genericError')) };
    }
  }

  function show(version: number) {
    onShow(version);
    // The sheet closes by itself: the person asked to see the version, not
    // to keep reading the list (PRDCT-2308, point 4).
    open = false;
  }
</script>

<Sheet.Root bind:open>
  <Sheet.Content
    side="right"
    class="flex w-full flex-col overflow-y-auto sm:max-w-lg"
    data-testid="version-history"
  >
    <Sheet.Header>
      <Sheet.Title>{t('master.historyTitle')}</Sheet.Title>
      <Sheet.Description>{t('master.historyDescription')}</Sheet.Description>
    </Sheet.Header>
    {#if list.loading}
      <p class="text-sm text-muted-foreground">{t('common.loading')}</p>
    {:else if list.error && !list.items.length}
      <p class="text-sm text-destructive" in:appear>{t('versions.loadFailed', { error: list.error })}</p>
    {:else if !list.items.length}
      <p class="text-sm text-muted-foreground">{t('versions.empty')}</p>
    {:else}
      <ol class="divide-y rounded-[10px] border bg-[var(--plate-strong)]" in:appear>
        {#each list.items as version (version.version)}
          {@const shown = version.version === shownVersion}
          <li class="space-y-2 p-3" data-testid="version-row" data-version={version.version}>
            <VersionThumb {deckId} version={version.version} width={400} class="w-full max-w-full" />
            <div class="flex items-center justify-between gap-3">
              <div class="min-w-0 space-y-0.5">
                <div class="flex flex-wrap items-center gap-2 text-sm">
                  <span class="font-mono font-medium">v{version.version}</span>
                  <span class="text-muted-foreground">·</span>
                  <span class="text-muted-foreground">{formatTimeAgo(version.createdAt)}</span>
                  {#if version.version === currentVersion}
                    <Badge variant="latest">{t('versions.badgeCurrent')}</Badge>
                  {/if}
                </div>
                <p class="text-xs text-muted-foreground">
                  {version.createdByRole === 'owner' ? t('versions.roleOwner') : t('versions.roleDev')}
                  · {formatBytes(version.sizeBytes)}
                  · {t('master.historyFileCount', { n: version.fileCount })}
                </p>
                <p class="text-xs text-muted-foreground">
                  {t('master.versionViews', { n: version.viewCount })}
                  · {t('master.versionDownloads', { n: version.downloadCount })}
                </p>
              </div>
              {#if shown}
                <span class="inline-flex shrink-0" in:appear>
                  <Badge variant="secondary">{t('master.historyShowing')}</Badge>
                </span>
              {:else}
                <span class="inline-flex shrink-0" in:appear>
                  <Button variant="outline" size="sm" onclick={() => show(version.version)}>
                    {t('master.historyShow')}
                  </Button>
                </span>
              {/if}
            </div>
            {#if version.hasDownloads}
              <div
                class="rounded-[10px] border bg-[color-mix(in_oklab,var(--ground-2)_62%,transparent)] px-2.5 py-2 text-xs"
              >
                <div class="mb-1 flex items-center justify-between gap-2">
                  <span class="inline-flex items-center gap-1 font-medium">
                    <Paperclip class="h-3 w-3" />
                    {t('master.historyFiles')}
                  </span>
                  <!-- Through $lib/download, never a plain anchor (PRDCT-2426):
                       an anchor cannot carry the active workspace. -->
                  <button
                    type="button"
                    onclick={() =>
                      void download(() => api.downloadVersionAttachmentsZip(deckId, version.version), {
                        fallbackName: `v${version.version}.zip`
                      })}
                    class="inline-flex items-center gap-1 text-muted-foreground underline-offset-4 hover:underline"
                    data-testid="version-files-zip"
                  >
                    <Download class="h-3 w-3" />
                    {t('master.downloadAll')}
                  </button>
                </div>
                {#if attachmentErrors[version.version]}
                  <p class="text-destructive" role="alert" transition:reveal>
                    {attachmentErrors[version.version]}
                  </p>
                {:else if !attachmentsByVersion[version.version]}
                  <p class="text-muted-foreground">{t('common.loading')}</p>
                {:else}
                  <ul class="space-y-0.5" in:appear>
                    {#each attachmentsByVersion[version.version] as file (file.path)}
                      <!-- SECURITY: file names are DECK-AUTHORED text — escaped
                           {} interpolation only, never {@html}. -->
                      <li class="flex items-baseline justify-between gap-3">
                        <button
                          type="button"
                          onclick={() =>
                            void download(
                              () => api.downloadVersionAttachment(deckId, version.version, file.name),
                              { fallbackName: file.name }
                            )}
                          class="min-w-0 truncate text-left font-mono underline-offset-4 hover:underline"
                          data-testid="version-file"
                        >
                          {file.name}
                        </button>
                        <span class="shrink-0 text-muted-foreground">{formatBytes(file.sizeBytes)}</span>
                      </li>
                    {/each}
                  </ul>
                {/if}
              </div>
            {/if}
          </li>
        {/each}
      </ol>
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
  </Sheet.Content>
</Sheet.Root>
