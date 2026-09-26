<script lang="ts">
  import DeckStill from './DeckStill.svelte';
  import { t } from '$lib/i18n';
  import type { StillState } from '$lib/tool/decks/stills';

  /**
   * One version as a small picture (PRDCT-2308, a still image since
   * PRDCT-2725): the WebP the server captured when that version was pushed,
   * shown to everyone who can read the deck. No deck HTML loads here. LAZY:
   * DeckStill asks for the image once the box has been in view, and the
   * loader fetches it once per version for the page's life. While it is
   * fetched or made a shimmering skeleton fills the box, and the image fades
   * in over it. `data-state` carries DeckStill's state; `data-loaded` marks
   * the box once the image is shown.
   */
  interface Props {
    deckId: string;
    version: number;
    /** The rendered width in CSS px; the height follows at 16:9. */
    width?: number;
    class?: string;
  }

  let { deckId, version, width = 128, class: className }: Props = $props();

  let still = $state<StillState>('idle');
  const height = $derived(Math.round((width * 9) / 16));
</script>

<div
  class={['relative shrink-0 overflow-hidden rounded-[10px] border bg-[var(--ground-2)]', className]
    .filter(Boolean)
    .join(' ')}
  style="width: {width}px; height: {height}px"
  data-testid="version-thumb"
  data-version={version}
  data-state={still}
  data-loaded={still === 'loaded' ? '' : undefined}
>
  <DeckStill {deckId} {version} alt={t('master.thumbTitle', { n: version })} bind:state={still} />
</div>
