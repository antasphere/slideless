<script lang="ts">
  import type { Snippet } from 'svelte';

  /* What sits in a dialog's drawing panel: a drawing in the hand of the
     presentations' figures, and under it a line in the display serif that
     says what the dialog is for. The panel itself is decoration (the surface
     hides it from assistive technology), so nothing here may carry a fact
     the form does not also say. */
  let {
    eyebrow,
    caption,
    children
  }: {
    eyebrow?: string;
    caption?: string;
    children: Snippet;
  } = $props();
</script>

<div class="illustration">
  <div class="drawing">
    {@render children()}
  </div>
  {#if eyebrow || caption}
    <div class="words">
      {#if eyebrow}<span class="eyebrow">{eyebrow}</span>{/if}
      {#if caption}<p class="caption">{caption}</p>{/if}
    </div>
  {/if}
</div>

<style>
  .illustration {
    display: flex;
    min-height: 0;
    flex: 1 1 auto;
    flex-direction: column;
    justify-content: space-between;
    gap: 12px;
    padding: 26px 26px 24px;
  }
  .drawing {
    display: flex;
    min-height: 0;
    flex: 1 1 auto;
    align-items: center;
    justify-content: center;
  }
  .drawing :global(svg) {
    display: block;
    width: 100%;
    height: auto;
    max-height: 100%;
    overflow: visible;
  }
  .words {
    display: grid;
    flex: none;
    gap: 8px;
  }
  .caption {
    font-family: var(--display);
    font-weight: 300;
    font-size: 19px;
    line-height: 1.3;
    letter-spacing: -0.01em;
    color: var(--ink-soft);
    text-wrap: balance;
  }
  /* a short window keeps the drawing and lets the words go */
  @media (max-height: 560px) {
    .words {
      display: none;
    }
  }
</style>
