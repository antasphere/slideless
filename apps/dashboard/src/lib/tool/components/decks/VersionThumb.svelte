<script lang="ts">
  import { PREVIEW_SANDBOX } from '$lib/tool/decks';
  import type { ThumbnailController } from '$lib/tool/decks/preview.svelte';
  import { t } from '$lib/i18n';

  /**
   * One version as a small live rendering (PRDCT-2308): the viewer's own
   * page for that version, framed at deck size and scaled down with a
   * transform, so what the thumbnail shows is exactly what a recipient
   * would see. LAZY: the token is asked for only once the box has been in
   * view, and the controller mints it once per version.
   *
   * SECURITY (ADR 012 Surface D): user-authored deck HTML renders ONLY inside
   * this sandboxed iframe, with the same sandbox set as the main preview —
   * never `allow-same-origin`. The frame takes no pointer events and no
   * focus; it is a picture.
   */
  interface Props {
    thumbs: ThumbnailController;
    version: number;
    /** The rendered width in CSS px; the deck is framed at 1280 × 720 and scaled to it. */
    width?: number;
    class?: string;
  }

  let { thumbs, version, width = 128, class: className }: Props = $props();

  let box = $state<HTMLElement | null>(null);
  let seen = $state(false);

  $effect(() => {
    if (!box || seen) return;
    if (typeof IntersectionObserver === 'undefined') {
      seen = true;
      return;
    }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        seen = true;
        io.disconnect();
      }
    });
    io.observe(box);
    return () => io.disconnect();
  });

  $effect(() => {
    if (seen) thumbs.request(version);
  });

  const url = $derived(thumbs.url(version));
  const height = $derived(Math.round((width * 9) / 16));
  const scale = $derived(width / 1280);
</script>

<div
  bind:this={box}
  class={['relative shrink-0 overflow-hidden rounded-[10px] border bg-[var(--ground-2)]', className]
    .filter(Boolean)
    .join(' ')}
  style="width: {width}px; height: {height}px"
  data-testid="version-thumb"
  data-version={version}
  data-loaded={url ? '' : undefined}
>
  {#if url}
    <iframe
      src={url}
      title={t('master.thumbTitle', { n: version })}
      sandbox={PREVIEW_SANDBOX}
      referrerpolicy="no-referrer"
      tabindex="-1"
      aria-hidden="true"
      loading="lazy"
      class="pointer-events-none absolute left-0 top-0 h-[720px] w-[1280px] origin-top-left border-0 bg-background"
      style="transform: scale({scale})"
    ></iframe>
  {/if}
</div>
