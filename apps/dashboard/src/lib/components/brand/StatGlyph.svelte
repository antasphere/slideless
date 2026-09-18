<script lang="ts">
  /* The small drawing on a figure's card: one family (four concentric forms,
     the presentations' ringed dot grown up), one form and one colour per card.
     At rest it is still; while its card is under the pointer the rings go out
     one after the other, like a sonar. Pure SVG and CSS: nothing to paint,
     nothing to leak, and a reader who asked for no motion gets the still form. */
  interface Props {
    form: 'circle' | 'square' | 'diamond' | 'arc';
    color: string;
    active?: boolean;
  }

  let { form, color, active = false }: Props = $props();

  const steps = [1, 2, 3, 4];
</script>

<svg viewBox="0 0 64 64" class="glyph" class:active style="--c: {color}" aria-hidden="true">
  {#each steps as n (n)}
    {@const r = 5 + n * 6}
    <g class="ring" style="--i: {n}">
      {#if form === 'circle'}
        <circle cx="32" cy="32" {r} />
      {:else if form === 'square'}
        <rect x={32 - r} y={32 - r} width={r * 2} height={r * 2} rx={r * 0.34} />
      {:else if form === 'diamond'}
        <rect
          x={32 - r * 0.8}
          y={32 - r * 0.8}
          width={r * 1.6}
          height={r * 1.6}
          rx={r * 0.22}
          transform="rotate(45 32 32)"
        />
      {:else}
        <path d="M {32 - r} 40 A {r} {r} 0 0 1 {32 + r} 40" stroke-linecap="round" />
      {/if}
    </g>
  {/each}
  {#if form === 'arc'}
    <circle class="dot" cx="32" cy="40" r="3" />
  {:else}
    <circle class="dot" cx="32" cy="32" r="3" />
  {/if}
</svg>

<style>
  .glyph {
    display: block;
    width: 100%;
    height: 100%;
    overflow: visible;
  }
  .ring {
    fill: none;
    stroke: var(--c);
    stroke-width: 1.2;
    opacity: calc(0.8 - var(--i) * 0.15);
    transform-origin: 32px 32px;
  }
  .dot {
    fill: var(--c);
  }
  .active .ring {
    animation: sonar 1.8s var(--motion-ease) infinite;
    animation-delay: calc(var(--i) * 0.16s);
  }
  @keyframes sonar {
    0% {
      transform: scale(0.92);
    }
    45% {
      transform: scale(1.1);
      opacity: calc(0.95 - var(--i) * 0.12);
    }
    100% {
      transform: scale(0.92);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .active .ring {
      animation: none;
    }
  }
</style>
