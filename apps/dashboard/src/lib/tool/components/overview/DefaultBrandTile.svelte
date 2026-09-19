<!-- The workspace's brand: the default brand, or the invitation to make one.
     The first of the overview's two lower tiles; the second, the team, is the
     shell's (routes/(app)/+page.svelte). Each half writes its tile in place with
     its own scoped `.lower` rules, as the hub's overview does: keep the two in step. -->
<script lang="ts">
  import Palette from '@lucide/svelte/icons/palette';
  import ArrowRight from '@lucide/svelte/icons/arrow-right';
  import { descriptionOf } from '$lib/tool/references';
  import { t } from '$lib/i18n';
  import type { DeckOverview } from '$lib/tool/overview.svelte';

  let { model }: { model: DeckOverview } = $props();

  const brand = $derived(model.brand);
</script>

{#if !model.isGuest}
  <a href="/brands" class="sheet tile lower" data-testid="default-brand">
    <div class="fan" aria-hidden="true">
      {#if model.brandSwatches.length}
        {#each model.brandSwatches as swatch, i (swatch.name + swatch.hex)}
          <div class="fan-slide" style="--i: {i}; background: {swatch.hex}"></div>
        {/each}
      {:else}
        <div class="fan-slide fan-empty" style="--i: 0"><Palette class="size-6" strokeWidth={1.5} /></div>
      {/if}
    </div>
    <div class="lower-copy">
      {#if brand}
        <p class="hero-eyebrow lower-eyebrow">{t('overview.defaultBrandTitle')}</p>
        <h2 class="lower-title">{brand.title}</h2>
        <p class="lower-body">{descriptionOf(brand.reference) || t('overview.defaultBrandBody')}</p>
      {:else if brand === null}
        <h2 class="lower-title">{t('overview.noBrandTitle')}</h2>
        <p class="lower-body">{t('overview.noBrandBody')}</p>
      {:else}
        <h2 class="lower-title">{t('overview.defaultBrandTitle')}</h2>
        <p class="lower-body">{t('overview.defaultBrandBody')}</p>
      {/if}
      <span class="lower-cta">{t('overview.brandsCta')}<ArrowRight class="size-3.5" /></span>
    </div>
  </a>
{/if}

<style>
  .lower {
    display: grid;
    grid-template-columns: 1fr;
    gap: 18px;
    align-items: center;
    padding: 20px;
    overflow: hidden;
  }
  @media (min-width: 640px) {
    .lower {
      grid-template-columns: 210px 1fr;
      gap: 24px;
      padding: 22px 24px;
    }
  }
  .lower-copy {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  }
  .lower-title {
    font-family: var(--display);
    font-weight: 400;
    font-size: 20px;
    line-height: 1.2;
    letter-spacing: -0.01em;
  }
  .lower-body {
    font-size: 14px;
    line-height: 1.5;
    color: var(--muted);
  }
  .lower:hover .lower-cta :global(svg) {
    transform: translateX(3px);
  }
  .lower-cta :global(svg) {
    transition: transform var(--motion-duration) var(--motion-ease);
  }
  .lower-cta {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    margin-top: 2px;
    font-size: 13.5px;
    color: var(--accent-deep);
  }
  /* the brand's colours as slides, fanned like the Slideless mark */
  .fan {
    position: relative;
    height: 128px;
  }
  .fan-slide {
    position: absolute;
    left: calc(8px + var(--i) * 18px);
    top: calc(26px - var(--i) * 7px);
    width: 120px;
    aspect-ratio: 16 / 9;
    transform: rotate(calc(-9deg + var(--i) * 4.5deg));
    box-shadow: var(--shadow-md);
    border: 1px solid var(--plate-edge);
    border-radius: 6px;
    transition: transform 320ms var(--motion-ease);
  }
  .fan-empty {
    display: flex;
    align-items: center;
    justify-content: center;
    left: 30px;
    width: 150px;
    border: 1.5px dashed color-mix(in oklab, var(--accent) 50%, var(--hairline));
    background: var(--ground);
    color: var(--accent-deep);
    transform: rotate(-4deg);
  }
  .lower-eyebrow {
    margin-bottom: -2px;
  }
  @media (hover: hover) {
    .lower:hover .fan-slide {
      transform: rotate(calc(-13deg + var(--i) * 7deg)) translateY(calc(var(--i) * -2px));
    }
  }
</style>
