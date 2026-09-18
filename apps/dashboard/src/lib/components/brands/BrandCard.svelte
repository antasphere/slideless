<script lang="ts">
  /* One brand, read at a glance: a slide in its own look, its name, its
     colours, and one line about the deck it is. What it sets (how it looks,
     how it is set, how it moves, how it speaks, its pages and its files) stays
     folded inside the card until a person asks for it: the name is a real
     button, the whole resting card answers to it, and the fold opens in place
     (grid rows from 0fr to 1fr, the rows arriving one after the other). Escape
     or a second click folds it back; the page keeps one card open at a time. */
  import BrandSlide from './BrandSlide.svelte';
  import BrandPages from './BrandPages.svelte';
  import { Tag } from '$lib/components/ui/tag';
  import { fileTag } from '$lib/tags';
  import Check from '@lucide/svelte/icons/check';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import type { DeckBrand } from '$lib/brands-demo';
  import { t } from '$lib/i18n';

  interface Props {
    brand: DeckBrand;
    selected?: boolean;
    open?: boolean;
    onToggle?: () => void;
    onSelect?: () => void;
  }
  let { brand, selected = false, open = false, onToggle, onSelect }: Props = $props();

  let card = $state<HTMLElement>();
  let trigger = $state<HTMLButtonElement>();

  const MIME: Record<string, string> = {
    svg: 'image/svg+xml',
    woff2: 'font/woff2',
    md: 'text/markdown',
    css: 'text/css',
    pdf: 'application/pdf'
  };
  const mimeOf = (file: string) => MIME[file.split('.').pop() ?? ''] ?? 'application/octet-stream';

  const swatches = $derived([
    brand.colors.ground,
    brand.colors.surface,
    brand.colors.hairline,
    brand.colors.muted,
    brand.colors.ink,
    brand.colors.accent,
    brand.colors.accent2
  ]);

  function onKeydown(event: KeyboardEvent) {
    if (!open || event.key !== 'Escape' || event.defaultPrevented) return;
    // focus goes back to the name when it was inside what is about to fold
    if (card?.contains(document.activeElement)) trigger?.focus();
    onToggle?.();
  }
</script>

<svelte:window onkeydown={onKeydown} />

<article class="sheet brand" class:selected class:open bind:this={card}>
  <div class="rest">
    <!-- the slide is a sample of the look, not content: the name below says which brand this is -->
    <div class="slide" aria-hidden="true"><BrandSlide {brand} /></div>
    <div class="summary">
      <header class="top">
        <div class="min-w-0">
          <h3 class="name">
            <button
              type="button"
              class="trigger"
              bind:this={trigger}
              aria-expanded={open}
              aria-controls="brand-fold-{brand.id}"
              onclick={onToggle}
            >
              {brand.name}
            </button>
          </h3>
          <p class="tagline">{brand.tagline}</p>
        </div>
        {#if selected}
          <span class="default"><Check class="size-3" />{t('brands.default')}</span>
        {/if}
      </header>

      <div class="swatches" role="img" aria-label={t('brands.colours')}>
        {#each swatches as hex, i (i)}
          <span class="sw" style="background: {hex}"></span>
        {/each}
      </div>

      <p class="deck-line">
        <span>
          {t('brands.deckLine', {
            pages: String(brand.deck.pages),
            versions: String(brand.deck.versions),
            used: String(brand.deck.usedBy)
          })}
        </span>
        <span class="chevron" aria-hidden="true"><ChevronDown class="size-4" strokeWidth={1.5} /></span>
      </p>
    </div>
  </div>

  <div class="fold" id="brand-fold-{brand.id}" inert={!open}>
    <div class="fold-clip">
      <div class="details">
        <div class="row" style="--n: 0">
          <p class="eyebrow label">{t('brands.pages')}</p>
          <BrandPages {brand} />
        </div>

        <dl class="traits row" style="--n: 1">
          <div>
            <dt>{t('brands.titles')}</dt>
            <dd>
              <span
                class="specimen"
                style="font-family: '{brand.fonts.display.family}', serif; font-weight: {brand.fonts.display
                  .weight}; font-style: {brand.fonts.display.italic ? 'italic' : 'normal'}">Aa</span
              >
              {brand.fonts.display.family}
            </dd>
          </div>
          <div>
            <dt>{t('brands.text')}</dt>
            <dd>
              <span
                class="specimen"
                style="font-family: '{brand.fonts.body.family}', sans-serif; font-weight: {brand.fonts.body
                  .weight}">Aa</span
              >
              {brand.fonts.body.family}
            </dd>
          </div>
          <div>
            <dt>{t('brands.background')}</dt>
            <dd>{brand.background.label}</dd>
          </div>
          <div>
            <dt>{t('brands.shape')}</dt>
            <dd>{brand.shape.label}</dd>
          </div>
          <div>
            <dt>{t('brands.motion')}</dt>
            <dd>{brand.motion.label}</dd>
          </div>
          <div>
            <dt>{t('brands.voice')}</dt>
            <dd class="flex flex-wrap gap-1.5 pt-0.5">
              {#each brand.voice.tone as word (word)}
                <span class="tone">{word}</span>
              {/each}
            </dd>
          </div>
        </dl>

        <div class="row foot" style="--n: 2">
          <div class="min-w-0">
            <p class="eyebrow label">{t('brands.files')}</p>
            <div class="flex flex-wrap gap-1.5">
              {#each brand.deck.files as file (file)}
                <Tag {...fileTag(mimeOf(file))} label={file} />
              {/each}
            </div>
          </div>
          {#if onSelect}
            <button type="button" class="use" disabled={selected} onclick={onSelect}>
              {selected ? t('brands.isDefault') : t('brands.makeDefault')}
            </button>
          {/if}
        </div>
      </div>
    </div>
  </div>
</article>

<style>
  .brand {
    --fold: 440ms;
    display: flex;
    flex-direction: column;
    padding: 10px;
    container-type: inline-size;
    transition:
      border-color var(--motion-duration) var(--motion-ease),
      box-shadow 320ms var(--motion-ease);
  }
  .brand.selected {
    border-color: color-mix(in oklab, var(--accent) 60%, var(--hairline));
  }
  @media (hover: hover) {
    .brand:not(.open):has(.rest:hover) {
      border-color: color-mix(in oklab, var(--accent) 38%, var(--hairline));
      box-shadow: var(--shadow-md);
    }
  }
  .brand.open {
    box-shadow: var(--shadow-md);
  }

  /* at rest: everything above the fold answers to the one button */
  .rest {
    position: relative;
    cursor: pointer;
  }
  .trigger {
    text-align: left;
    font: inherit;
    letter-spacing: inherit;
    border-radius: 4px;
  }
  .trigger::after {
    content: '';
    position: absolute;
    inset: -10px -10px 0;
    border-radius: var(--r-lg) var(--r-lg) 0 0;
  }
  .trigger:focus-visible {
    outline: none;
  }
  .trigger:focus-visible::after {
    outline: 2px solid var(--focus);
    outline-offset: -2px;
  }
  .slide {
    overflow: hidden;
    border-radius: calc(var(--r-lg) - 4px);
  }
  .summary {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 18px 8px 8px;
  }
  .top {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }
  .name {
    font-family: var(--display);
    font-weight: 400;
    font-size: 22px;
    line-height: 1.15;
    letter-spacing: -0.01em;
  }
  .tagline {
    margin-top: 5px;
    font-size: 14px;
    line-height: 1.4;
    color: var(--muted);
  }
  .default {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex: none;
    padding: 3px 9px;
    border-radius: 999px;
    background: var(--accent-soft);
    color: var(--accent-deep);
    font-size: 11.5px;
  }
  .swatches {
    display: flex;
    height: 18px;
    border-radius: 6px;
    overflow: hidden;
    border: 1px solid var(--hairline);
  }
  .sw {
    flex: 1;
  }
  .deck-line {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    font-size: 13px;
    color: var(--muted);
  }
  .chevron {
    flex: none;
    display: flex;
    color: var(--ink-soft);
    transition: transform var(--fold) var(--motion-ease);
  }
  .open .chevron {
    transform: rotate(180deg);
  }

  /* the fold: height from nothing to its own, without measuring anything */
  .fold {
    display: grid;
    grid-template-rows: 0fr;
    visibility: hidden;
    transition:
      grid-template-rows var(--fold) var(--motion-ease),
      visibility 0s linear var(--fold);
  }
  .open .fold {
    grid-template-rows: 1fr;
    visibility: visible;
    transition:
      grid-template-rows var(--fold) var(--motion-ease),
      visibility 0s;
  }
  .fold-clip {
    min-height: 0;
    overflow: hidden;
  }
  .details {
    display: grid;
    gap: 22px;
    margin: 8px 8px 0;
    padding: 18px 0 8px;
    border-top: 1px solid var(--hairline);
  }
  /* the rows arrive one after the other, and leave together */
  .row {
    opacity: 0;
    transform: translateY(8px);
    transition:
      opacity 180ms var(--motion-ease),
      transform 180ms var(--motion-ease);
  }
  .open .row {
    opacity: 1;
    transform: none;
    transition:
      opacity 420ms var(--motion-ease),
      transform 520ms var(--motion-ease);
    transition-delay: calc(110ms + var(--n) * 70ms);
  }
  /* each fact is a small label over its value, two to a line */
  .traits {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 16px 24px;
    font-size: 14px;
    line-height: 1.4;
  }
  .traits dt {
    margin-bottom: 3px;
    font-size: 12.5px;
    color: var(--muted);
  }
  .specimen {
    display: inline-block;
    min-width: 30px;
    font-size: 19px;
    line-height: 1;
    color: var(--ink);
  }
  .tone {
    padding: 2px 9px;
    border: 1px solid var(--hairline);
    border-radius: 999px;
    font-size: 12px;
    color: var(--ink-soft);
  }
  .foot {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    justify-content: space-between;
    gap: 16px;
  }
  .label {
    margin-bottom: 8px;
  }
  .use {
    height: var(--control-h-md);
    padding: 0 16px;
    border-radius: 10px;
    border: 1px solid var(--hairline);
    font-size: 13.5px;
    transition: background-color var(--motion-duration) var(--motion-ease);
  }
  .use:hover:not(:disabled) {
    background: var(--accent-soft);
    border-color: color-mix(in oklab, var(--accent) 40%, var(--hairline));
  }
  .use:disabled {
    border-color: transparent;
    padding: 0;
    color: var(--muted);
  }
  @media (max-width: 767px) {
    .use {
      width: 100%;
      height: 44px;
    }
    .use:disabled {
      text-align: left;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .fold,
    .open .fold,
    .row,
    .open .row,
    .chevron {
      transition: none;
    }
  }
</style>
