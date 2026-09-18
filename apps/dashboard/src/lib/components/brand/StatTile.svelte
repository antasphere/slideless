<script lang="ts">
  /* A figure on the overview and the brands page. The number leads, in the
     display serif; its name sits under it in plain words; the card's own
     drawing, large and in the card's own colour, runs off the corner like a
     watermark and ripples while the card is under the pointer. */
  import StatGlyph from './StatGlyph.svelte';
  import ArrowUpRight from '@lucide/svelte/icons/arrow-up-right';

  interface Props {
    label: string;
    value: string | null;
    hint?: string;
    href?: string;
    form: 'circle' | 'square' | 'diamond' | 'arc';
    color: string;
  }
  let { label, value, hint, href, form, color }: Props = $props();
  let played = $state(false);
</script>

<svelte:element
  this={href ? 'a' : 'div'}
  {href}
  class="sheet stat"
  class:tile={!!href}
  style="--c: {color}"
  role={href ? undefined : 'group'}
  onpointerenter={() => (played = true)}
  onpointerleave={() => (played = false)}
  onfocus={() => (played = true)}
  onblur={() => (played = false)}
>
  <span class="wash"></span>
  <span class="glyph"><StatGlyph {form} {color} active={played} /></span>
  <p class="figure value">{value ?? '—'}</p>
  <p class="name">{label}</p>
  {#if hint}
    <p class="hint">
      {hint}{#if href}<ArrowUpRight class="arrow" />{/if}
    </p>
  {/if}
</svelte:element>

<style>
  .stat {
    position: relative;
    display: block;
    min-height: 148px;
    padding: 20px 20px 16px;
    overflow: hidden;
    isolation: isolate;
  }
  .wash {
    position: absolute;
    inset: 0;
    z-index: -1;
    background:
      var(--grain),
      radial-gradient(80% 110% at 100% 100%, color-mix(in oklab, var(--c) 20%, transparent), transparent 68%);
    background-blend-mode: overlay, normal;
  }
  .glyph {
    position: absolute;
    right: -38px;
    bottom: -46px;
    z-index: -1;
    width: 168px;
    height: 168px;
    opacity: 0.5;
    transition:
      opacity 320ms var(--motion-ease),
      transform 520ms var(--motion-ease);
  }
  .stat:hover .glyph,
  .stat:focus-visible .glyph {
    opacity: 0.85;
    transform: scale(1.06) rotate(-4deg);
  }
  .value {
    font-size: clamp(40px, 8vw, 52px);
  }
  .name {
    margin-top: 10px;
    font-size: 14.5px;
    font-weight: 550;
    color: var(--ink);
  }
  .hint {
    display: flex;
    align-items: center;
    gap: 3px;
    margin-top: 2px;
    max-width: 75%;
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
  @media (prefers-reduced-motion: reduce) {
    .stat:hover .glyph {
      transform: none;
    }
  }
</style>
