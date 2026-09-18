<script lang="ts">
  /* The brand AS A DECK: its first five pages, drawn small with the brand's
     own parameters. A cover, its colours, its faces, its voice, a layout. */
  import BrandSlide from './BrandSlide.svelte';
  import { BRAND_DECK_PAGES, type DeckBrand } from '$lib/brands-demo';

  let { brand }: { brand: DeckBrand } = $props();
  const c = $derived(brand.colors);
  const r = $derived(Math.min(brand.shape.radius, 8));
  const display = $derived(
    `font-family: '${brand.fonts.display.family}', serif; font-weight: ${brand.fonts.display.weight}; font-style: ${brand.fonts.display.italic ? 'italic' : 'normal'}`
  );
</script>

<div class="strip">
  {#each BRAND_DECK_PAGES as name, i (name)}
    <figure class="page" style="--i: {i}">
      {#if name === 'Cover'}
        <BrandSlide {brand} small />
      {:else}
        <div class="sheet-page" style="background: {c.ground}; color: {c.ink}; border-radius: {r}px">
          {#if name === 'Colours'}
            <div class="cols">
              {#each [c.accent, c.accent2, c.ink, c.muted, c.hairline, c.surface] as hex, k (k)}
                <span style="background: {hex}; border-radius: {r / 2}px"></span>
              {/each}
            </div>
          {:else if name === 'Type'}
            <span class="aa" style={display}>Aa</span>
            <span class="bb" style="font-family: '{brand.fonts.body.family}', sans-serif; color: {c.muted}"
              >{brand.fonts.display.family} · {brand.fonts.body.family}</span
            >
          {:else if name === 'Voice'}
            <span class="quote" style="{display}; color: {c.accent}">“</span>
            <span class="say" style={display}>{brand.voice.tone.join(', ')}.</span>
          {:else}
            <div class="grid" style="--line: {c.hairline}; --acc: {c.accent}; border-radius: {r / 2}px">
              <span></span><span></span><span></span>
            </div>
          {/if}
        </div>
      {/if}
      <figcaption>{name}</figcaption>
    </figure>
  {/each}
</div>

<style>
  .strip {
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: 8px;
  }
  .page {
    min-width: 0;
    transition: transform 320ms var(--motion-ease);
    transition-delay: calc(var(--i) * 30ms);
  }
  :global(.brand:hover) .page {
    transform: translateY(-3px);
  }
  .sheet-page {
    position: relative;
    aspect-ratio: 16 / 9;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    justify-content: center;
    padding: 10%;
    container-type: inline-size;
    border: 1px solid rgb(0 0 0 / 0.06);
  }
  figcaption {
    margin-top: 5px;
    font-size: 10.5px;
    letter-spacing: 0.04em;
    color: var(--muted);
    text-align: center;
  }
  .cols {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 6%;
    height: 100%;
  }
  .aa {
    font-size: 34cqw;
    line-height: 0.9;
  }
  .bb {
    margin-top: 4cqw;
    font-size: 6.5cqw;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .quote {
    font-size: 30cqw;
    line-height: 0.6;
  }
  .say {
    font-size: 9cqw;
    line-height: 1.15;
  }
  .grid {
    display: grid;
    grid-template-columns: 1.4fr 1fr;
    grid-template-rows: 1fr 1fr;
    gap: 6%;
    height: 100%;
  }
  .grid span {
    border: 1px solid var(--line);
    border-radius: inherit;
  }
  .grid span:first-child {
    grid-row: span 2;
    background: color-mix(in oklab, var(--acc) 16%, transparent);
    border-color: transparent;
  }
</style>
