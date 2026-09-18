<script lang="ts" module>
  export type StatDrawingKind = 'decks' | 'opens' | 'members' | 'files' | 'brands' | 'worn' | 'fresh';
</script>

<script lang="ts">
  /* The small drawing on a figure's card, in the hand of the presentations'
     figures: three stroke weights (1, 1.2 and one emphasised 1.6), ink at low
     opacity, boxes filled with a breath of paper, dots filled, and the card's
     colour used ONCE, on the element that carries the meaning. Each drawing is
     literal: a fan of slides, an eye, people around a hub, a pile of sheets.
     The movement under the pointer belongs to the card (it sets `.stat:hover`),
     plays once, and is CSS only; a reader who asked for no motion gets the
     still drawing. Ink comes from the tokens, so the dark set just works. */
  interface Props {
    kind: StatDrawingKind;
  }
  let { kind }: Props = $props();

  // people around the hub: where each one sits, and whether the seat is taken
  const HUB = { x: 48, y: 50, r: 9 };
  const people = [
    { x: 19, y: 23, here: true },
    { x: 77, y: 19, here: true },
    { x: 87, y: 56, here: true },
    { x: 61, y: 86, here: false },
    { x: 15, y: 71, here: true }
  ].map((p) => {
    // a link leaves the hub's ring and stops short of the person
    const d = Math.hypot(p.x - HUB.x, p.y - HUB.y);
    const ux = (p.x - HUB.x) / d;
    const uy = (p.y - HUB.y) / d;
    return {
      ...p,
      x1: HUB.x + ux * (HUB.r + 3),
      y1: HUB.y + uy * (HUB.r + 3),
      x2: p.x - ux * 7,
      y2: p.y - uy * 7
    };
  });
</script>

<svg viewBox="0 0 96 96" class="drawing" aria-hidden="true">
  {#if kind === 'decks'}
    <!-- the Slideless mark, literally: three slides fanned from one corner -->
    <rect class="bx fan fan-l" x="21" y="36" width="54" height="34" rx="5" />
    <rect class="bx fan fan-r" x="21" y="36" width="54" height="34" rx="5" />
    <g class="front">
      <rect class="bx bx--front" x="21" y="36" width="54" height="34" rx="5" />
      <line class="ln ln--c" x1="29" y1="47" x2="42" y2="47" />
      <line class="ln ln--thin" x1="29" y1="54.5" x2="62" y2="54.5" />
      <line class="ln ln--thin" x1="29" y1="61" x2="52" y2="61" />
    </g>
  {:else if kind === 'opens'}
    <!-- an eye on the deck: two arcs and the presentations' ringed dot -->
    <g class="ln ln--thin">
      <line x1="48" y1="26" x2="48" y2="18" />
      <line x1="29" y1="31" x2="25.5" y2="24" />
      <line x1="67" y1="31" x2="70.5" y2="24" />
    </g>
    <g class="eye">
      <path class="ln" d="M10,50 Q48,14 86,50" />
      <path class="ln" d="M10,50 Q48,86 86,50" />
      <circle class="ring" cx="48" cy="50" r="12.5" />
      <circle class="ring ring--c pulse" cx="48" cy="50" r="5" />
      <circle class="dot dot--c" cx="48" cy="50" r="4.5" />
    </g>
  {:else if kind === 'members'}
    <!-- people around a hub; the empty ring is a seat still to fill -->
    {#each people as p, i (i)}
      <g class="spoke" style="--i: {i}">
        <line class="ln ln--soft" x1={p.x1} y1={p.y1} x2={p.x2} y2={p.y2} />
        {#if p.here}
          <circle class="dot dot--c" cx={p.x} cy={p.y} r="3.6" />
        {:else}
          <circle class="ring" cx={p.x} cy={p.y} r="3.6" />
        {/if}
      </g>
    {/each}
    <circle class="ring" cx={HUB.x} cy={HUB.y} r={HUB.r} />
    <circle class="dot" cx={HUB.x} cy={HUB.y} r="3.2" />
  {:else if kind === 'files'}
    <!-- a short pile of sheets, the top one with its corner folded -->
    <rect class="bx pile pile-l" x="29" y="22" width="38" height="52" rx="4" />
    <rect class="bx pile pile-r" x="29" y="22" width="38" height="52" rx="4" />
    <g class="front">
      <path
        class="bx bx--front"
        d="M29,26 a4,4 0 0 1 4,-4 H55 L67,34 V70 a4,4 0 0 1 -4,4 H33 a4,4 0 0 1 -4,-4 Z"
      />
      <path class="ln ln--c" d="M55,22 V30 a4,4 0 0 0 4,4 H67" />
      <line class="ln ln--thin write" style="--i: 0" x1="37" y1="47" x2="59" y2="47" />
      <line class="ln ln--thin write" style="--i: 1" x1="37" y1="54" x2="59" y2="54" />
      <line class="ln ln--thin write" style="--i: 2" x1="37" y1="61" x2="50" y2="61" />
    </g>
  {:else if kind === 'brands'}
    <!-- a slide with its mark, and the row of colours under it -->
    <rect class="bx" x="14" y="16" width="68" height="43" rx="5" />
    <rect class="ln ln--thin" x="66" y="23" width="9" height="9" rx="2" />
    <line class="ln" x1="22" y1="43" x2="50" y2="43" />
    <line class="ln ln--thin" x1="22" y1="50" x2="42" y2="50" />
    <g class="row">
      <circle class="ring hop" style="--i: 0" cx="28" cy="77" r="4.2" />
      <circle class="ring hop" style="--i: 1" cx="41.5" cy="77" r="4.2" />
      <circle class="ring hop" style="--i: 2" cx="55" cy="77" r="4.2" />
      <circle class="dot dot--c hop" style="--i: 3" cx="68.5" cy="77" r="4.2" />
    </g>
  {:else if kind === 'worn'}
    <!-- a brand, handed to a deck -->
    <circle class="ring" cx="17" cy="50" r="9.5" />
    <circle class="ring ring--c pulse" cx="17" cy="50" r="4" />
    <circle class="dot dot--c" cx="17" cy="50" r="3.6" />
    <g class="hand">
      <line class="ln" x1="31" y1="50" x2="43" y2="50" />
      <path class="ln" d="M39.5,46.2 L44,50 L39.5,53.8" />
    </g>
    <rect class="bx" x="55" y="31" width="35" height="24" rx="4" />
    <rect class="bx bx--front" x="49" y="40" width="35" height="24" rx="4" />
    <line class="ln ln--thin" x1="55" y1="48" x2="69" y2="48" />
    <line class="ln ln--thin" x1="55" y1="54" x2="76" y2="54" />
  {:else}
    <!-- versions along a line; the last one is where the brand stands today -->
    <line class="ln" x1="8" y1="58" x2="88" y2="58" />
    <g class="ln ln--soft">
      <path d="M18.5,52 Q26.5,31 34.5,52" />
      <path d="M39.5,52 Q47.5,31 55.5,52" />
      <path d="M60.5,52 Q68,31 74.5,49" />
    </g>
    <circle class="dot" cx="16" cy="58" r="2.8" />
    <circle class="dot" cx="37" cy="58" r="2.8" />
    <circle class="dot" cx="58" cy="58" r="2.8" />
    <circle class="ring" cx="79" cy="58" r="9" />
    <circle class="ring ring--c pulse" cx="79" cy="58" r="4" />
    <circle class="dot dot--c" cx="79" cy="58" r="3.8" />
  {/if}
</svg>

<style>
  .drawing {
    display: block;
    width: 100%;
    height: 100%;
    overflow: visible;
  }
  /* the vocabulary (the presentations' svg classes, on tokens) */
  .drawing :is(.ln, .bx, .ring) {
    vector-effect: non-scaling-stroke;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .ln {
    fill: none;
    stroke: color-mix(in oklab, var(--ink) 45%, transparent);
    stroke-width: 1.2;
  }
  .ln--soft,
  .ln--soft > * {
    stroke: color-mix(in oklab, var(--ink) 34%, transparent);
    stroke-dasharray: 3 4;
  }
  .ln--thin,
  .ln--thin > * {
    stroke: color-mix(in oklab, var(--ink) 30%, transparent);
    stroke-width: 1;
  }
  .bx {
    fill: color-mix(in oklab, var(--ground) 40%, transparent);
    stroke: color-mix(in oklab, var(--ink) 40%, transparent);
    stroke-width: 1;
  }
  /* the box in front hides what is behind it, the way paper does: opaque,
     and the tone of the card it sits on (the plate itself is translucent) */
  .bx--front {
    fill: color-mix(in oklab, var(--ground), white 55%);
  }
  :global(:root.dark) .bx--front {
    fill: var(--ground-3);
  }
  .dot {
    fill: color-mix(in oklab, var(--ink) 78%, transparent);
  }
  .ring {
    fill: none;
    stroke: color-mix(in oklab, var(--ink) 42%, transparent);
    stroke-width: 1;
  }
  /* the one place the card's colour goes */
  .ln--c {
    stroke: var(--c);
    stroke-width: 1.6;
  }
  .dot--c {
    fill: var(--c);
  }
  .ring--c {
    stroke: var(--c);
  }
  .pulse {
    opacity: 0;
    transform-box: fill-box;
    transform-origin: center;
  }

  /* what moves, and from where */
  .fan,
  .pile,
  .front,
  .hand {
    transition: transform 460ms var(--motion-ease);
  }
  /* the pivot sits under the slides, so a turn also spreads them sideways */
  .fan {
    transform-origin: 48px 96px;
  }
  .fan-l {
    transform: rotate(-16deg);
  }
  .fan-r {
    transform: rotate(16deg);
  }
  .pile {
    transform-origin: 48px 70px;
  }
  .pile-l {
    transform: rotate(-8deg);
  }
  .pile-r {
    transform: rotate(7deg);
  }
  .eye {
    transform-origin: 48px 50px;
  }
  .spoke {
    transform-origin: 48px 50px;
  }
  .write {
    transform-box: fill-box;
    transform-origin: left center;
  }
  .hop {
    transform-box: fill-box;
    transform-origin: center;
  }

  @media (prefers-reduced-motion: no-preference) {
    /* the slides fan a little wider and the front one lifts */
    :global(.stat:is(:hover, :focus-visible)) .fan-l {
      transform: rotate(-22deg);
    }
    :global(.stat:is(:hover, :focus-visible)) .fan-r {
      transform: rotate(22deg);
    }
    :global(.stat:is(:hover, :focus-visible)) .pile-l {
      transform: rotate(-14deg);
    }
    :global(.stat:is(:hover, :focus-visible)) .pile-r {
      transform: rotate(13deg);
    }
    :global(.stat:is(:hover, :focus-visible)) .front {
      transform: translateY(-2.5px);
    }
    :global(.stat:is(:hover, :focus-visible)) .hand {
      transform: translateX(3px);
    }
    /* the eye blinks once, then the dot answers */
    :global(.stat:is(:hover, :focus-visible)) .eye {
      animation: blink 520ms var(--motion-ease) 1;
    }
    :global(.stat:is(:hover, :focus-visible)) .pulse {
      animation: pulse 900ms var(--motion-ease) 1;
    }
    :global(.stat:is(:hover, :focus-visible)) .eye .pulse {
      animation-delay: 420ms;
    }
    /* the people arrive one after the other, along their links */
    :global(.stat:is(:hover, :focus-visible)) .spoke {
      animation: arrive 620ms var(--motion-ease) 1 backwards;
      animation-delay: calc(var(--i) * 70ms);
    }
    /* the lines of the top sheet are written again */
    :global(.stat:is(:hover, :focus-visible)) .write {
      animation: write 520ms var(--motion-ease) 1 backwards;
      animation-delay: calc(120ms + var(--i) * 90ms);
    }
    /* the colours hop in a row */
    :global(.stat:is(:hover, :focus-visible)) .hop {
      animation: hop 520ms var(--motion-ease) 1;
      animation-delay: calc(var(--i) * 70ms);
    }
  }
  @keyframes blink {
    0%,
    100% {
      transform: scaleY(1);
    }
    45% {
      transform: scaleY(0.08);
    }
  }
  @keyframes pulse {
    0% {
      opacity: 0.8;
      transform: scale(1);
    }
    100% {
      opacity: 0;
      transform: scale(3.4);
    }
  }
  @keyframes arrive {
    0% {
      opacity: 0;
      transform: scale(0.5);
    }
    100% {
      opacity: 1;
      transform: scale(1);
    }
  }
  @keyframes write {
    0% {
      transform: scaleX(0);
    }
    100% {
      transform: scaleX(1);
    }
  }
  @keyframes hop {
    0%,
    100% {
      transform: translateY(0);
    }
    40% {
      transform: translateY(-4px);
    }
  }
</style>
