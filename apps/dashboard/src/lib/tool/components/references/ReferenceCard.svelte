<script lang="ts">
  /* One reference as a card (PRDCT-2421): the reference deck itself, live,
     the title, the description its author wrote, its colours as a strip, its
     font names, who reads it, its version, and the crown when it is the
     workspace's default. The card is a button: it opens the side sheet, where
     everything else lives.

     The picture is the deck's first page rendered live, the way DeckCard and
     the version thumbnails do it (PRDCT-2308). SECURITY (ADR 012 Surface D):
     deck HTML renders ONLY inside the sandboxed iframe, never
     `allow-same-origin`; the frame takes no pointer events and no focus, it is
     a picture. The token is a hidden, stat-excluded preview token, asked for
     once the card has been in view and revoked when the card goes. The mint is
     owner-level on the server: a plain member reading a published reference
     sees the drawn plate instead. */
  import { onDestroy, untrack } from 'svelte';
  import { page } from '$app/state';
  import PatternCanvas from '$lib/components/brand/PatternCanvas.svelte';
  import { Tag } from '$lib/components/ui/tag';
  import DeckProjectTags from '$lib/tool/components/projects/DeckProjectTags.svelte';
  import { PREVIEW_SANDBOX } from '$lib/tool/decks';
  import { canPreviewDeck, createThumbnailController } from '$lib/tool/decks/preview.svelte';
  import { descriptionOf, fontsOf, swatchesOf } from '$lib/tool/references';
  import Crown from '@lucide/svelte/icons/crown';
  import Clock from '@lucide/svelte/icons/clock-3';
  import Lock from '@lucide/svelte/icons/lock';
  import Users from '@lucide/svelte/icons/users';
  import { DECK_PALETTES } from '$lib/brand/recipe.js';
  import { seedOf } from '$lib/brand/seed';
  import { formatTimeAgo } from '$lib/format';
  import { t } from '$lib/i18n';
  import type { DeckWithProjects } from '$lib/tool/projects-client';

  interface Props {
    deck: DeckWithProjects;
    /** The sheet is open on this reference. */
    selected?: boolean;
    onOpen: () => void;
  }

  let { deck, selected = false, onOpen }: Props = $props();

  const seed = $derived(seedOf(deck.id));
  const palette = $derived(DECK_PALETTES[seed % DECK_PALETTES.length]);
  const description = $derived(descriptionOf(deck.reference));
  const swatches = $derived(swatchesOf(deck.reference).filter((s) => s.hex));
  const fonts = $derived([...new Set(fontsOf(deck.reference).map((f) => f.family))]);

  let played = $state(false);

  const canThumb = $derived(deck.currentVersion > 0 && canPreviewDeck(page.data.me, deck));
  const thumbs = createThumbnailController(
    untrack(() => deck.id),
    { canPreview: () => canThumb }
  );
  onDestroy(() => thumbs.destroy());

  let box = $state<HTMLElement | null>(null);
  let width = $state(0);
  let loaded = $state(false);
  $effect(() => {
    if (!box || !canThumb) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        thumbs.request(deck.currentVersion);
        io.disconnect();
      }
    });
    io.observe(box);
    return () => io.disconnect();
  });
  const url = $derived(canThumb ? thumbs.url(deck.currentVersion) : null);
</script>

<!-- SECURITY: the title, the description and every frontmatter value are
     USER-AUTHORED; they render through text interpolation only, never
     {@html}. A swatch's colour reaches an inline style only as a checked hex
     (hexOf). -->
<button
  type="button"
  class="sheet tile ref"
  class:selected
  data-testid="reference-card"
  data-deck-id={deck.id}
  aria-pressed={selected}
  onclick={onOpen}
  onpointerenter={() => (played = true)}
  onpointerleave={() => (played = false)}
  onfocus={() => (played = true)}
  onblur={() => (played = false)}
>
  {#if deck.defaultReference}
    <span class="crown" data-testid="reference-default"
      ><Crown class="size-3.5" strokeWidth={1.6} />{t('refs.default')}</span
    >
  {/if}
  <div class="plate-window plate" bind:this={box} bind:clientWidth={width}>
    <PatternCanvas pattern="slides" {palette} {seed} active={played && !loaded} />
    {#if url && width}
      <iframe
        src={url}
        title={deck.title}
        sandbox={PREVIEW_SANDBOX}
        referrerpolicy="no-referrer"
        tabindex="-1"
        aria-hidden="true"
        loading="lazy"
        class="thumb"
        class:loaded
        style="transform: scale({width / 1280})"
        onload={() => (loaded = true)}
      ></iframe>
    {/if}
    {#if deck.currentVersion > 0}
      <span class="chip">{t('refs.version', { n: deck.currentVersion })}</span>
    {/if}
  </div>
  <div class="body">
    <h3 class="title">{deck.title}</h3>
    {#if description}
      <p class="description">{description}</p>
    {/if}
    {#if swatches.length}
      <div class="swatches" role="img" aria-label={swatches.map((s) => s.name).join(', ')}>
        {#each swatches as swatch (swatch.name + swatch.hex)}
          <span class="sw" style="background: {swatch.hex}" title={swatch.name}></span>
        {/each}
      </div>
    {/if}
    {#if fonts.length}
      <p class="fonts">{fonts.join(' · ')}</p>
    {/if}
    <p class="facts">
      {#if deck.audience === 'workspace'}
        <Tag label={t('refs.audienceWorkspace')} tone="green" icon={Users} />
      {:else}
        <Tag label={t('refs.audiencePrivate')} tone="slate" icon={Lock} />
      {/if}
      {#if deck.currentVersion > 0}
        <span class="fact"><Clock class="size-3.5" />{formatTimeAgo(deck.updatedAt)}</span>
      {:else}
        <span class="fact">{t('decks.noVersions')}</span>
      {/if}
    </p>
    <!-- the projects the reference sits in (PRDCT-2584): the reader's own only -->
    <DeckProjectTags {deck} />
  </div>
</button>

<style>
  .ref {
    position: relative;
    display: flex;
    flex-direction: column;
    padding: 8px;
    min-width: 0;
    text-align: left;
    font: inherit;
    color: inherit;
  }
  .ref.selected {
    border-color: color-mix(in oklab, var(--accent) 45%, var(--hairline));
    box-shadow: var(--shadow-md);
  }
  /* the default's mark: a warm gold tab riding the card's top edge, opaque so
     the edge passes behind it; the gold lightens on the dark ground */
  .crown {
    --gold: #b8923a;
    position: absolute;
    top: -12px;
    left: 20px;
    z-index: 1;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 24px;
    padding: 0 11px 0 9px;
    border-radius: 999px;
    border: 1px solid color-mix(in oklab, var(--gold) 58%, var(--ground));
    background: color-mix(in oklab, var(--gold) 22%, var(--ground));
    color: color-mix(in oklab, var(--gold) 72%, var(--ink));
    font-size: 12px;
    font-weight: 500;
    letter-spacing: 0.02em;
    line-height: 1;
    box-shadow: 0 1px 2px rgb(28 25 21 / 0.08);
    pointer-events: none;
  }
  .crown :global(svg) {
    color: var(--gold);
  }
  :global(:root.dark) .crown {
    --gold: #d2ad55;
  }
  .plate {
    aspect-ratio: 16 / 9;
  }
  .thumb {
    position: absolute;
    left: 0;
    top: 0;
    width: 1280px;
    height: 720px;
    border: 0;
    transform-origin: top left;
    pointer-events: none;
    background: var(--ground);
    opacity: 0;
    transition: opacity 320ms var(--motion-ease);
  }
  .thumb.loaded {
    opacity: 1;
  }
  .chip {
    position: absolute;
    right: 10px;
    bottom: 10px;
    padding: 3px 9px;
    border-radius: 999px;
    background: var(--plate-strong);
    border: 1px solid var(--plate-edge);
    font-family: var(--mono);
    font-size: 11px;
    color: var(--ink-soft);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
  }
  .body {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 14px 8px 8px;
    min-width: 0;
  }
  .title {
    font-family: var(--display);
    font-weight: 400;
    font-size: 18px;
    line-height: 1.2;
    letter-spacing: -0.01em;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }
  .description {
    font-size: 13.5px;
    line-height: 1.45;
    color: var(--muted);
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }
  .swatches {
    display: flex;
    height: 14px;
    border-radius: 5px;
    overflow: hidden;
    border: 1px solid var(--hairline);
  }
  .sw {
    flex: 1;
  }
  .fonts {
    font-size: 13px;
    color: var(--ink-soft);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .facts {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 14px;
    margin-top: 2px;
    font-size: 13px;
    color: var(--muted);
  }
  .fact {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
</style>
