<script lang="ts">
  /* One deck as a card (PRDCT-2437): the deck itself, the title, and the two or
     three facts a person who is not technical cares about. No id, no hash, no
     version number. The picture is the deck's first page, rendered live the way
     the version thumbnails are (PRDCT-2308). Under it, and in its place for a
     deck with no version or a person who may not preview, sits the deck's own
     drawn plate: its pattern says what kind of deck it is, its field is seeded
     from the deck's id.

     SECURITY (ADR 012 Surface D): deck HTML renders ONLY inside the sandboxed
     iframe, never `allow-same-origin`; the frame takes no pointer events and no
     focus, it is a picture. The token is a hidden, stat-excluded preview token,
     asked for once the card has been in view and revoked when the card goes. */
  import { onDestroy, untrack } from 'svelte';
  import { page } from '$app/state';
  import PatternCanvas from '$lib/components/brand/PatternCanvas.svelte';
  import DeckProjectTags from '$lib/tool/components/projects/DeckProjectTags.svelte';
  import { PREVIEW_SANDBOX } from '$lib/tool/decks';
  import { canPreviewDeck, createThumbnailController } from '$lib/tool/decks/preview.svelte';
  import Eye from '@lucide/svelte/icons/eye';
  import Clock from '@lucide/svelte/icons/clock-3';
  import { DECK_PALETTES, DECK_PATTERNS } from '$lib/brand/recipe.js';
  import { seedOf } from '$lib/brand/seed';
  import { kindLabel } from '$lib/tool/decks';
  import { formatTimeAgo } from '$lib/format';
  import { t } from '$lib/i18n';
  import type { DeckWithProjects } from '$lib/tool/projects-client';

  interface Props {
    deck: DeckWithProjects;
    /** A shorter plate, for a row of recent decks. */
    compact?: boolean;
    /** A project its tags leave out: the one whose page the card is on. */
    exceptProject?: string;
  }

  let { deck, compact = false, exceptProject }: Props = $props();

  const seed = $derived(seedOf(deck.id));
  const palette = $derived(DECK_PALETTES[seed % DECK_PALETTES.length]);
  const pattern = $derived(DECK_PATTERNS[deck.kind] ?? 'slides');

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

<!-- SECURITY: the title is USER-AUTHORED; it renders through text
     interpolation only, never {@html}. -->
<a
  href="/decks/{deck.id}"
  class="sheet tile deck"
  onpointerenter={() => (played = true)}
  onpointerleave={() => (played = false)}
  onfocus={() => (played = true)}
  onblur={() => (played = false)}
>
  <div class="plate-window plate" class:compact bind:this={box} bind:clientWidth={width}>
    <PatternCanvas {pattern} {palette} {seed} active={played && !loaded} />
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
    <span class="kind">{kindLabel(deck.kind)}</span>
    {#if deck.interactive}
      <span class="kind kind--right">{t('decks.badgeInteractive')}</span>
    {/if}
  </div>
  <div class="body">
    <h3 class="title">{deck.title}</h3>
    <p class="facts">
      {#if deck.currentVersion > 0}
        <span class="fact"><Clock class="size-3.5" />{formatTimeAgo(deck.updatedAt)}</span>
        <span class="fact">
          <Eye class="size-3.5" />
          {deck.totalViews === 0
            ? t('decks.noOpens')
            : deck.totalViews === 1
              ? t('decks.oneOpen')
              : t('decks.opens', { count: String(deck.totalViews) })}
        </span>
      {:else}
        <span class="fact">{t('decks.noVersions')}</span>
      {/if}
    </p>
    <!-- the projects the deck sits in (PRDCT-2584): the reader's own only -->
    <div class="projects"><DeckProjectTags {deck} except={exceptProject} /></div>
  </div>
</a>

<style>
  .deck {
    display: flex;
    flex-direction: column;
    padding: 8px;
    min-width: 0;
  }
  .plate {
    aspect-ratio: 16 / 9;
  }
  .plate.compact {
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
  .kind {
    position: absolute;
    left: 10px;
    bottom: 10px;
    padding: 3px 9px;
    border-radius: 999px;
    background: var(--plate-strong);
    border: 1px solid var(--plate-edge);
    font-size: 11px;
    color: var(--ink-soft);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
  }
  .kind--right {
    left: auto;
    right: 10px;
  }
  .body {
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
  .facts {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 14px;
    margin-top: 8px;
    font-size: 13px;
    color: var(--muted);
  }
  .projects:not(:empty) {
    margin-top: 10px;
  }
  .fact {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
</style>
