<script lang="ts">
  /* A figure on the overview and the brands page. The number leads, in the
     display serif; its name sits under it in plain words; beside it, a small
     line drawing of the thing counted (StatDrawing). The card's colour is a
     whisper: one element of the drawing, a short cap on the top edge, and a
     faint wash that comes up under the pointer. The hint has a row of its
     own, so on a narrow card it never runs under the drawing. */
  import StatDrawing, { type StatDrawingKind } from './StatDrawing.svelte';
  import ArrowUpRight from '@lucide/svelte/icons/arrow-up-right';

  interface Props {
    label: string;
    value: string | null;
    hint?: string;
    href?: string;
    drawing: StatDrawingKind;
    color: string;
  }
  let { label, value, hint, href, drawing, color }: Props = $props();
</script>

<svelte:element
  this={href ? 'a' : 'div'}
  {href}
  class="sheet stat"
  class:tile={!!href}
  style="--c: {color}"
  role={href ? undefined : 'group'}
>
  <span class="wash"></span>
  <span class="cap"></span>
  <!-- the card is the container the layout measures itself against -->
  <span class="lay">
    <span class="art"><StatDrawing kind={drawing} /></span>
    <span class="figure value">{value ?? '—'}</span>
    <span class="name">{label}</span>
    {#if hint}
      <span class="hint">
        {hint}{#if href}<ArrowUpRight class="arrow" />{/if}
      </span>
    {/if}
  </span>
</svelte:element>

<style>
  .stat {
    position: relative;
    display: block;
    min-height: 148px;
    overflow: hidden;
    isolation: isolate;
    container-type: inline-size;
  }
  .lay {
    --art: 92px;
    display: grid;
    grid-template-columns: minmax(0, 1fr) var(--art);
    grid-template-rows: auto auto 1fr;
    column-gap: 10px;
    padding: 20px 18px 16px 20px;
  }
  .wash {
    position: absolute;
    inset: 0;
    z-index: -1;
    background: radial-gradient(
      70% 90% at 100% 0%,
      color-mix(in oklab, var(--c) 9%, transparent),
      transparent 70%
    );
    opacity: 0.55;
    transition: opacity 320ms var(--motion-ease);
  }
  .stat:is(:hover, :focus-visible) .wash {
    opacity: 1;
  }
  /* the coloured cap of the presentations' outlined bars, on the card's edge */
  .cap {
    position: absolute;
    top: -1px;
    left: 20px;
    width: 26px;
    height: 2px;
    border-radius: 0 0 2px 2px;
    background: var(--c);
    opacity: 0.85;
    transition: width 320ms var(--motion-ease);
  }
  .stat:is(:hover, :focus-visible) .cap {
    width: 44px;
  }
  .art {
    grid-column: 2;
    grid-row: 1 / span 2;
    align-self: start;
    width: var(--art);
    height: var(--art);
    margin-top: -6px;
    z-index: -1;
  }
  .value {
    grid-column: 1;
    grid-row: 1;
    font-size: clamp(40px, 8vw, 52px);
    white-space: nowrap;
  }
  .name {
    grid-column: 1;
    grid-row: 2;
    margin-top: 10px;
    font-size: 14.5px;
    font-weight: 550;
    line-height: 1.25;
    color: var(--ink);
  }
  .hint {
    grid-column: 1 / -1;
    grid-row: 3;
    display: flex;
    align-items: center;
    align-self: start;
    gap: 3px;
    margin-top: 3px;
    font-size: 12.5px;
    line-height: 1.35;
    color: var(--muted);
  }
  .hint :global(.arrow) {
    flex: none;
    width: 13px;
    height: 13px;
    opacity: 0;
    transform: translate(-3px, 3px);
    transition:
      opacity var(--motion-duration) var(--motion-ease),
      transform var(--motion-duration) var(--motion-ease);
  }
  .stat:hover .hint :global(.arrow) {
    opacity: 1;
    transform: none;
  }
  /* a narrow card (two to a row on a phone): a smaller drawing, tighter sides */
  @container (max-width: 230px) {
    .lay {
      --art: 52px;
      column-gap: 6px;
      padding: 18px 14px 14px 16px;
    }
    /* the drawing keeps to the number's row, so a long name has the whole width */
    .art {
      grid-row: 1;
      margin-top: -4px;
    }
    .name {
      grid-column: 1 / -1;
    }
    .cap {
      left: 16px;
    }
  }
</style>
