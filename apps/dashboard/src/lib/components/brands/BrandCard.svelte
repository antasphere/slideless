<script lang="ts">
  /* One brand, read at a glance: a slide in its own look, then what it sets,
     in the order a person would describe a house style: how it looks, how it
     is set, how it moves, how it speaks. */
  import BrandSlide from './BrandSlide.svelte';
  import BrandPages from './BrandPages.svelte';
  import { Tag } from '$lib/components/ui/tag';
  import { fileTag } from '$lib/tags';
  import Layers from '@lucide/svelte/icons/layers';
  import Check from '@lucide/svelte/icons/check';
  import type { DeckBrand } from '$lib/brands-demo';
  import { t } from '$lib/i18n';

  interface Props {
    brand: DeckBrand;
    selected?: boolean;
    onSelect?: () => void;
  }
  let { brand, selected = false, onSelect }: Props = $props();

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
</script>

<article class="sheet brand" class:selected>
  <BrandSlide {brand} />
  <div class="body">
    <header class="flex items-start justify-between gap-3">
      <div class="min-w-0">
        <h3 class="font-display text-[19px] font-normal leading-tight tracking-[-0.01em]">{brand.name}</h3>
        <p class="mt-1 text-[13.5px] leading-snug text-muted-foreground">{brand.tagline}</p>
      </div>
      {#if selected}
        <span class="default"><Check class="size-3" />{t('brands.default')}</span>
      {/if}
    </header>

    <div class="swatches" aria-label={t('brands.colours')}>
      {#each swatches as hex, i (i)}
        <span class="sw" style="background: {hex}" title={hex}></span>
      {/each}
    </div>

    <dl class="facts">
      <dt>{t('brands.titles')}</dt>
      <dd>
        <span
          class="specimen"
          style="font-family: '{brand.fonts.display.family}', serif; font-weight: {brand.fonts.display
            .weight}; font-style: {brand.fonts.display.italic ? 'italic' : 'normal'}">Aa</span
        >
        {brand.fonts.display.family}
      </dd>
      <dt>{t('brands.text')}</dt>
      <dd>
        <span
          class="specimen"
          style="font-family: '{brand.fonts.body.family}', sans-serif; font-weight: {brand.fonts.body.weight}"
          >Aa</span
        >
        {brand.fonts.body.family}
      </dd>
      <dt>{t('brands.background')}</dt>
      <dd>{brand.background.label}</dd>
      <dt>{t('brands.shape')}</dt>
      <dd>{brand.shape.label}</dd>
      <dt>{t('brands.motion')}</dt>
      <dd>{brand.motion.label}</dd>
      <dt>{t('brands.voice')}</dt>
      <dd class="flex flex-wrap gap-1.5">
        {#each brand.voice.tone as word (word)}
          <span class="tone">{word}</span>
        {/each}
      </dd>
    </dl>

    <div class="deck">
      <p class="deck-line">
        <Layers class="size-3.5" />
        {t('brands.deckLine', {
          pages: String(brand.deck.pages),
          versions: String(brand.deck.versions),
          used: String(brand.deck.usedBy)
        })}
      </p>
      <BrandPages {brand} />
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
</article>

<style>
  .brand {
    display: flex;
    flex-direction: column;
    padding: 8px;
    transition:
      border-color var(--motion-duration) var(--motion-ease),
      box-shadow var(--motion-duration) var(--motion-ease);
  }
  .brand.selected {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent);
  }
  .body {
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 16px 8px 8px;
    flex: 1;
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
    height: 26px;
    border-radius: var(--r);
    overflow: hidden;
    border: 1px solid var(--hairline);
  }
  .sw {
    flex: 1;
  }
  .facts {
    display: grid;
    grid-template-columns: 92px 1fr;
    gap: 9px 12px;
    font-size: 13.5px;
    align-items: baseline;
  }
  .facts dt {
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
  .deck {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding-top: 14px;
    border-top: 1px solid var(--hairline);
  }
  .deck-line {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12.5px;
    color: var(--muted);
  }
  .use {
    margin-top: auto;
    height: var(--control-h-md);
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
    color: var(--muted);
  }
  @media (max-width: 767px) {
    .use {
      height: 44px;
    }
  }
</style>
