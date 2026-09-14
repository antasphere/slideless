<script lang="ts">
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import VersionThumb from './VersionThumb.svelte';
  import type { ThumbnailController } from '$lib/decks/preview.svelte';
  import type { PagedList } from '$lib/stores/pagedList.svelte';
  import { formatTimeAgo } from '$lib/format';
  import { t } from '$lib/i18n';
  import type { PresentationVersionSummary } from '@slideless/contract';

  /**
   * The version popover's body (PRDCT-2308): every version newest first in
   * a scrollable list with a max height, each row a live thumbnail, the
   * version, its file count, its views and its downloads. One component for
   * both popovers — the title menu's sub-menu (rows are menu items, so the
   * arrow keys and Enter work) and the hover card on the bar's version badge
   * (rows are plain buttons). Picking a row shows that version in the frame;
   * the host closes the popover.
   */
  interface Props {
    list: PagedList<PresentationVersionSummary>;
    thumbs: ThumbnailController;
    currentVersion: number;
    /** The version the frame shows (page state). */
    shownVersion: number | null;
    /** Inside a dropdown menu the rows are menu items; elsewhere buttons. */
    menu?: boolean;
    onPick: (version: number) => void;
  }

  let { list, thumbs, currentVersion, shownVersion, menu = false, onPick }: Props = $props();
</script>

{#snippet row(version: PresentationVersionSummary)}
  <VersionThumb {thumbs} version={version.version} />
  <div class="min-w-0 flex-1 space-y-0.5">
    <div class="flex flex-wrap items-center gap-1.5 text-sm">
      <span class="font-mono font-medium">v{version.version}</span>
      {#if version.version === currentVersion}
        <Badge variant="latest" padding="px-1.5 py-0">{t('versions.badgeCurrent')}</Badge>
      {/if}
      {#if version.version === shownVersion}
        <Badge variant="secondary" padding="px-1.5 py-0">{t('master.historyShowing')}</Badge>
      {/if}
    </div>
    <p class="whitespace-nowrap text-xs text-muted-foreground">
      {t('master.historyFileCount', { n: version.fileCount })}
      · {t('master.versionViews', { n: version.viewCount })}
      · {t('master.versionDownloads', { n: version.downloadCount })}
    </p>
    <p class="text-xs text-muted-foreground">{formatTimeAgo(version.createdAt)}</p>
  </div>
{/snippet}

<div class="max-h-80 w-[26rem] overflow-y-auto" data-testid="version-list">
  {#if list.loading}
    <p class="px-2 py-2 text-sm text-muted-foreground">{t('common.loading')}</p>
  {:else if list.error && !list.items.length}
    <p class="px-2 py-2 text-sm text-destructive">{t('versions.loadFailed', { error: list.error })}</p>
  {:else if !list.items.length}
    <p class="px-2 py-2 text-sm text-muted-foreground">{t('versions.empty')}</p>
  {:else}
    {#each list.items as version (version.version)}
      {#if menu}
        <DropdownMenu.Item
          class="flex items-start gap-3"
          onSelect={() => onPick(version.version)}
          data-testid="version-pick"
          data-version={version.version}
        >
          {@render row(version)}
        </DropdownMenu.Item>
      {:else}
        <button
          type="button"
          class="flex w-full items-start gap-3 rounded-sm px-2 py-2 text-left outline-none hover:bg-accent focus-visible:bg-accent"
          onclick={() => onPick(version.version)}
          data-testid="version-pick"
          data-version={version.version}
        >
          {@render row(version)}
        </button>
      {/if}
    {/each}
    {#if list.nextCursor}
      <div class="flex justify-center py-1">
        <Button variant="ghost" size="sm" onclick={() => void list.loadMore()} disabled={list.loadingMore}>
          {list.loadingMore ? t('common.loading') : t('common.loadMore')}
        </Button>
      </div>
    {/if}
  {/if}
</div>
