<script lang="ts">
  /* A PREVIEW OF AN IDEA, entirely made up (see $lib/brands-demo.ts): what
     brands could look like in Slideless. Nothing on this page is saved on the
     server or applied to a deck; the default is remembered in this browser so
     the page behaves, and that is all. */
  import PageHeader from '$lib/components/shared/PageHeader.svelte';
  import BrandCard from '$lib/components/brands/BrandCard.svelte';
  import Plus from '@lucide/svelte/icons/plus';
  import { BRAND_FONTS_HREF, DEMO_BRANDS, brandFile } from '$lib/brands-demo';
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
</script>

<svelte:head>
  <title>{t('brands.title')} · {data.instance.name}</title>
  <link rel="stylesheet" href={BRAND_FONTS_HREF} />
</svelte:head>

<PageHeader title={t('brands.title')} description={t('brands.description')} />

<p class="preview"><span>{t('brands.preview')}</span>{t('brands.previewNote')}</p>

<div class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
  {#each DEMO_BRANDS as brand (brand.id)}
    <BrandCard {brand} selected={brand.id === chosen} onSelect={() => choose(brand.id)} />
  {/each}
</div>

<div class="mt-4 grid gap-4 lg:grid-cols-[1fr_1.2fr]">
  <div class="new">
    <span class="plus"><Plus class="size-5" strokeWidth={1.6} /></span>
    <p class="font-display text-[18px]">{t('brands.newTitle')}</p>
    <p class="max-w-xs text-center text-[13.5px] leading-snug text-muted-foreground">{t('brands.newBody')}</p>
  </div>

  <section class="sheet p-5">
    <h2 class="font-display text-[18px] font-normal">{t('brands.fileTitle')}</h2>
    <p class="mt-1 text-[13.5px] text-muted-foreground">{t('brands.fileBody', { brand: current.name })}</p>
    <pre class="code mt-4">slideless push ./deck --brand {current.id}</pre>
    <pre class="code mt-2">{brandFile(current)}</pre>
  </section>
</div>

<style>
  .preview {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    margin: -12px 0 22px;
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
  .new {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    min-height: 220px;
    padding: 24px;
    border: 1px dashed color-mix(in oklab, var(--accent) 45%, var(--hairline));
    border-radius: var(--r-lg);
    background: color-mix(in oklab, var(--accent) 4%, transparent);
  }
  .plus {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 44px;
    border-radius: 999px;
    background: var(--accent-soft);
    color: var(--accent-deep);
  }
  .code {
    overflow-x: auto;
    padding: 12px 14px;
    border: 1px solid var(--hairline);
    border-radius: var(--r);
    background: var(--ground-2);
    font-family: var(--mono);
    font-size: 12px;
    line-height: 1.55;
  }
</style>
