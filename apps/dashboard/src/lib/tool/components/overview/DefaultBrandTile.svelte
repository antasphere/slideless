<!-- The workspace's brand: the default brand, or the invitation to make one -->
<script lang="ts">
  import Palette from '@lucide/svelte/icons/palette';
  import OverviewTile from '$lib/components/shell/OverviewTile.svelte';
  import { descriptionOf } from '$lib/tool/references';
  import { t } from '$lib/i18n';
  import type { DeckOverview } from '$lib/tool/overview.svelte';

  let { model }: { model: DeckOverview } = $props();

  const brand = $derived(model.brand);
  const copy = $derived(
    brand
      ? {
          eyebrow: t('overview.defaultBrandTitle'),
          title: brand.title,
          body: descriptionOf(brand.reference) || t('overview.defaultBrandBody')
        }
      : brand === null
        ? { title: t('overview.noBrandTitle'), body: t('overview.noBrandBody') }
        : { title: t('overview.defaultBrandTitle'), body: t('overview.defaultBrandBody') }
  );
</script>

{#if !model.isGuest}
  <OverviewTile
    href="/brands"
    testid="default-brand"
    eyebrow={copy.eyebrow}
    title={copy.title}
    body={copy.body}
    cta={t('overview.brandsCta')}
  >
    {#snippet art()}
      <div class="fan" aria-hidden="true">
        {#if model.brandSwatches.length}
          {#each model.brandSwatches as swatch, i (swatch.name + swatch.hex)}
            <div class="fan-slide" style="--i: {i}; background: {swatch.hex}"></div>
          {/each}
        {:else}
          <div class="fan-slide fan-empty" style="--i: 0"><Palette class="size-6" strokeWidth={1.5} /></div>
        {/if}
      </div>
    {/snippet}
  </OverviewTile>
{/if}

<style>
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
  @media (hover: hover) {
    :global(.lower:hover) .fan-slide {
      transform: rotate(calc(-13deg + var(--i) * 7deg)) translateY(calc(var(--i) * -2px));
    }
  }
</style>
