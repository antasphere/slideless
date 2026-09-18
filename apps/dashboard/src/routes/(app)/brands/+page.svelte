<script lang="ts">
  /* A PREVIEW OF AN IDEA, entirely made up (see $lib/brands-demo.ts): what
     brands could look like in Slideless. Nothing on this page is saved on the
     server or applied to a deck; the default is remembered in this browser so
     the page behaves, and that is all. */
  import HeroBand from '$lib/components/brand/HeroBand.svelte';
  import StatTile from '$lib/components/brand/StatTile.svelte';
  import { THEMES } from '$lib/brand/recipe.js';
  import { toast } from 'svelte-sonner';
  import BrandCard from '$lib/components/brands/BrandCard.svelte';
  import Plus from '@lucide/svelte/icons/plus';
  import { BRAND_FONTS_HREF, DEMO_BRANDS } from '$lib/brands-demo';
  import { t } from '$lib/i18n';

  let { data } = $props();

  const KEY = 'slideless.brands.default';
  let chosen = $state(DEMO_BRANDS[0].id);
  $effect(() => {
    try {
      const stored = localStorage.getItem(KEY);
      if (stored && DEMO_BRANDS.some((b) => b.id === stored)) chosen = stored;
    } catch {
      /* privacy modes: the first brand */
    }
  });
  function choose(id: string) {
    chosen = id;
    try {
      localStorage.setItem(KEY, id);
    } catch {
      /* not persisted, still applied */
    }
  }
  const current = $derived(DEMO_BRANDS.find((b) => b.id === chosen) ?? DEMO_BRANDS[0]);
  // the figures are read off the made-up brands, so they stay true to the page
  const wearing = DEMO_BRANDS.reduce((n, b) => n + b.deck.usedBy, 0);
  const faces = new Set(
    DEMO_BRANDS.flatMap((b) => [b.fonts.display.family, b.fonts.body.family, b.fonts.label.family])
  ).size;
  const colours = DEMO_BRANDS.length * 7;
</script>

<svelte:head>
  <title>{t('brands.title')} · {data.instance.name}</title>
  <link rel="stylesheet" href={BRAND_FONTS_HREF} />
</svelte:head>

<HeroBand drawing="orbits" seed={20260918}>
  <p class="hero-eyebrow">{t('brands.preview')} · {t('brands.title')}</p>
  <h1 class="hero-title">{t('brands.heroTitle')}</h1>
  <p class="hero-lede">{t('brands.heroLede')}</p>
</HeroBand>

<div class="mt-4 grid grid-cols-2 gap-3 md:gap-4 lg:grid-cols-4">
  <StatTile
    label={t('brands.statBrands')}
    value={String(DEMO_BRANDS.length)}
    hint={t('brands.statBrandsHint', { brand: current.name })}
    form="diamond"
    color={THEMES.dawn.accent}
  />
  <StatTile
    label={t('brands.statDecks')}
    value={String(wearing)}
    hint={t('brands.statDecksHint')}
    form="square"
    color={THEMES.solar.accent}
  />
  <StatTile
    label={t('brands.statFaces')}
    value={String(faces)}
    hint={t('brands.statFacesHint')}
    form="arc"
    color={THEMES.reef.accent}
  />
  <StatTile
    label={t('brands.statColours')}
    value={String(colours)}
    hint={t('brands.statColoursHint')}
    form="circle"
    color={THEMES.iris.accent}
  />
</div>

<p class="preview"><span>{t('brands.preview')}</span>{t('brands.previewNote')}</p>

<div class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
  {#each DEMO_BRANDS as brand (brand.id)}
    <BrandCard {brand} selected={brand.id === chosen} onSelect={() => choose(brand.id)} />
  {/each}
</div>

<div class="mt-4 grid gap-4 lg:grid-cols-2">
  <!-- adding a brand: three blank pages that fan out, the way the brands do on the overview -->
  <button type="button" class="sheet tile new" onclick={() => toast(t('brands.newToast'))}>
    <span class="blank-fan" aria-hidden="true">
      {#each [0, 1, 2] as i (i)}
        <span class="blank" style="--i: {i}"
          >{#if i === 2}<Plus class="size-5" strokeWidth={1.5} />{/if}</span
        >
      {/each}
    </span>
    <span class="new-copy">
      <span class="new-title">{t('brands.newTitle')}</span>
      <span class="new-body">{t('brands.newBody')}</span>
      <span class="ways">
        {#each [t('brands.fromSite'), t('brands.fromPdf'), t('brands.fromDeck')] as way (way)}
          <span class="way">{way}</span>
        {/each}
      </span>
    </span>
  </button>

  <section class="sheet idea">
    <h2 class="new-title">{t('brands.ideaTitle')}</h2>
    <p class="new-body">{t('brands.ideaBody')}</p>
    <ol class="steps">
      <li><b>1</b>{t('brands.idea1')}</li>
      <li><b>2</b>{t('brands.idea2')}</li>
      <li><b>3</b>{t('brands.idea3')}</li>
    </ol>
  </section>
</div>

<style>
  .preview {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    margin: 28px 0 16px;
    font-size: 13.5px;
    color: var(--muted);
  }
  .preview span {
    padding: 2px 10px;
    border-radius: 999px;
    background: var(--warn-soft);
    color: var(--warn);
    font-size: 11.5px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .new,
  .idea {
    display: grid;
    gap: 22px;
    align-items: center;
    padding: 22px 24px;
    text-align: left;
  }
  @media (min-width: 640px) {
    .new {
      grid-template-columns: 200px 1fr;
    }
  }
  .new {
    border-style: dashed;
    border-color: color-mix(in oklab, var(--accent) 40%, var(--hairline));
    background: color-mix(in oklab, var(--accent) 4%, var(--plate-strong));
  }
  .blank-fan {
    position: relative;
    display: block;
    height: 124px;
  }
  .blank {
    position: absolute;
    left: calc(6px + var(--i) * 24px);
    top: calc(28px - var(--i) * 10px);
    display: flex;
    align-items: center;
    justify-content: center;
    width: 146px;
    aspect-ratio: 16 / 9;
    border-radius: 7px;
    border: 1.5px dashed color-mix(in oklab, var(--accent) 50%, var(--hairline));
    background: var(--ground);
    color: var(--accent-deep);
    transform: rotate(calc(-7deg + var(--i) * 6deg));
    transition:
      transform 360ms var(--motion-ease),
      border-color 360ms var(--motion-ease),
      background-color 360ms var(--motion-ease);
    transition-delay: calc(var(--i) * 40ms);
  }
  @media (hover: hover) {
    .new:hover .blank {
      transform: rotate(calc(-13deg + var(--i) * 12deg)) translateY(calc(-4px - var(--i) * 3px));
      border-style: solid;
      background: color-mix(in oklab, var(--accent) calc(6% + var(--i) * 5%), var(--ground));
    }
  }
  .new-copy {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  }
  .new-title {
    font-family: var(--display);
    font-weight: 400;
    font-size: 20px;
    line-height: 1.2;
    letter-spacing: -0.01em;
  }
  .new-body {
    font-size: 14px;
    line-height: 1.5;
    color: var(--muted);
  }
  .ways {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 2px;
  }
  .way {
    padding: 3px 10px;
    border-radius: 7px;
    border: 1px solid var(--hairline);
    background: var(--plate-strong);
    font-size: 12.5px;
    color: var(--ink-soft);
  }
  .idea {
    gap: 10px;
    align-content: center;
  }
  .steps {
    display: grid;
    gap: 9px;
    margin-top: 6px;
    font-size: 14px;
    color: var(--ink-soft);
  }
  .steps li {
    display: flex;
    gap: 12px;
    align-items: baseline;
  }
  .steps b {
    flex: none;
    width: 22px;
    font-family: var(--display);
    font-weight: 300;
    font-size: 20px;
    color: var(--accent-deep);
  }
</style>
