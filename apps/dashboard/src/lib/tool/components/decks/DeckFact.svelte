<script lang="ts">
  /* One fact about a deck, on its own small card under the banner: the
     value first, in the display serif (or as the tags it is), its name
     under it in plain words, and at the right a small line drawing of the
     thing (StatDrawing, the overview's vocabulary) with the accent as its
     one colour. Quieter than the overview's StatTile: no cap, no wash,
     nothing moves. All five on a desk; on a phone the kind alone on the
     first line, then two to a line. */
  import type { Snippet } from 'svelte';
  import StatDrawing, { type StatDrawingKind } from '$lib/components/brand/StatDrawing.svelte';

  interface Props {
    label: string;
    /** The value as text, set in the display serif. */
    value?: string;
    /** A figure (a count, a version): larger, in tabular figures. */
    figure?: boolean;
    /** A quiet value (nothing yet): the muted ink. */
    muted?: boolean;
    /** The value's full form, behind the pointer (a date behind "9h ago"). */
    title?: string;
    drawing: StatDrawingKind;
    /** The value as elements (tags) in place of `value`. */
    children?: Snippet;
  }
  let { label, value, figure = false, muted = false, title, drawing, children }: Props = $props();
</script>

<div class="sheet fact" role="group" aria-label={label}>
  <div class="words">
    <!-- SECURITY: `value` may be user text (an owner's email): escaped text
         interpolation only, never {@html}. -->
    {#if children}
      <div class="value tags">{@render children()}</div>
    {:else}
      <div class="value" class:figure class:muted {title}>{value}</div>
    {/if}
    <div class="name">{label}</div>
  </div>
  <div class="art" aria-hidden="true"><StatDrawing kind={drawing} /></div>
</div>

<style>
  .fact {
    --c: var(--accent);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-height: 82px;
    padding: 14px 14px 13px 16px;
  }
  .words {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }
  .value {
    font-family: var(--display);
    font-weight: 300;
    font-size: 19px;
    line-height: 1.15;
    letter-spacing: -0.01em;
    color: var(--ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .value.figure {
    font-size: 26px;
    line-height: 1;
    font-variant-numeric: lining-nums tabular-nums;
  }
  .value.muted {
    color: var(--muted);
    font-size: 16px;
  }
  .tags {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    white-space: normal;
    overflow: visible;
    min-height: 24px;
    align-items: center;
  }
  .name {
    font-size: 12.5px;
    line-height: 1.2;
    color: var(--muted);
  }
  .art {
    flex: none;
    width: 46px;
    height: 46px;
    opacity: 0.85;
  }
</style>
