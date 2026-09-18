<script lang="ts">
  /* A slide drawn with a brand's own parameters: its ground and what sits on
     it, its voices, its accent, its corners, and a sentence in its tone. */
  import type { DeckBrand } from '$lib/brands-demo';

  interface Props {
    brand: DeckBrand;
    /** A small slide shows the eyebrow and the title only. */
    small?: boolean;
  }
  let { brand, small = false }: Props = $props();

  const c = $derived(brand.colors);
  const ground = $derived(
    brand.background.kind === 'field'
      ? `radial-gradient(60% 80% at 88% 12%, ${c.accent}38, transparent 70%), radial-gradient(55% 70% at 8% 96%, ${c.accent2}26, transparent 72%), ${c.ground}`
      : brand.background.kind === 'gradient'
        ? `radial-gradient(70% 90% at 100% 0%, ${c.accent2}40, transparent 65%), radial-gradient(60% 80% at 0% 100%, ${c.accent}22, transparent 70%), linear-gradient(160deg, ${c.surface}, ${c.ground})`
        : c.ground
  );
</script>

<div
  class="slide"
  class:small
  style="background: {ground}; color: {c.ink}; border-radius: {Math.min(
    brand.shape.radius,
    10
  )}px; --hair: {c.hairline}; --acc: {c.accent}"
>
  {#if brand.background.grain > 0}
    <span class="grain" style="opacity: {brand.background.grain * 0.6}"></span>
  {/if}
  <span class="mark" style="border-radius: {brand.shape.radius / 2}px; border-width: {brand.shape.stroke}px">
    <span
      style="font-family: '{brand.fonts.display.family}', serif; font-style: {brand.fonts.display.italic
        ? 'italic'
        : 'normal'}">{brand.name.slice(0, 1)}</span
    >
  </span>
  <div class="copy">
    <p
      class="eyebrow"
      style="font-family: '{brand.fonts.label.family}', sans-serif; letter-spacing: {brand.fonts.label
        .track}; text-transform: {brand.fonts.label.upper ? 'uppercase' : 'none'}; color: {c.accent}"
    >
      {brand.voice.eyebrow}
    </p>
    <p
      class="title"
      style="font-family: '{brand.fonts.display.family}', serif; font-weight: {brand.fonts.display
        .weight}; font-style: {brand.fonts.display.italic ? 'italic' : 'normal'}; letter-spacing: {brand.fonts
        .display.track}"
    >
      {brand.voice.title}
    </p>
    {#if !small}
      <p
        class="body"
        style="font-family: '{brand.fonts.body.family}', sans-serif; font-weight: {brand.fonts.body
          .weight}; color: {c.muted}"
      >
        {brand.voice.body}
      </p>
    {/if}
  </div>
  <span class="rule" style="height: {brand.shape.stroke}px"></span>
</div>

<style>
  .slide {
    position: relative;
    aspect-ratio: 16 / 9;
    overflow: hidden;
    display: flex;
    align-items: flex-end;
    padding: 7% 8%;
    container-type: inline-size;
  }
  .grain {
    position: absolute;
    inset: 0;
    background-image: var(--grain);
    mix-blend-mode: overlay;
    pointer-events: none;
  }
  .mark {
    position: absolute;
    top: 7%;
    right: 6%;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 9cqw;
    height: 9cqw;
    border-style: solid;
    border-color: currentColor;
    font-size: 5.2cqw;
    line-height: 1;
    opacity: 0.85;
  }
  .copy {
    position: relative;
    max-width: 82%;
  }
  .eyebrow {
    font-size: 2.6cqw;
  }
  .title {
    margin-top: 1.6cqw;
    font-size: 7.6cqw;
    line-height: 1.04;
  }
  .small .title {
    font-size: 9cqw;
  }
  .small .eyebrow {
    font-size: 3.4cqw;
  }
  .body {
    margin-top: 2.4cqw;
    font-size: 3cqw;
    line-height: 1.45;
    max-width: 46ch;
  }
  .rule {
    position: absolute;
    left: 8%;
    right: 8%;
    top: 22%;
    background: var(--hair);
    opacity: 0;
  }
</style>
