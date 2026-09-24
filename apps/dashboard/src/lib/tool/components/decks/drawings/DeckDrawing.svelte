<script lang="ts" module>
  export type DeckDrawingKind =
    'preview' | 'details' | 'links' | 'projects' | 'collaborators' | 'annotations' | 'forms' | 'versions';
</script>

<script lang="ts">
  /* The drawing at the head of a deck page section, in the hand of the
     presentations' figures: three stroke weights (1, 1.2 and one emphasised
     1.6), ink at low opacity, boxes filled with a breath of paper, dots
     filled, and the accent used ONCE per drawing, on the element that carries
     the meaning. Each one is literal: a slide in its sandbox, a slide and its
     readers, people writing on a slide, a pinned note, a form, a wall of
     versions with the next brick on its way. Ink comes from the tokens, so
     the dark set just works. The movement is CSS only: the accent line is
     drawn once when the section arrives, one element shifts under the
     pointer, and a reader who asked for no motion gets the still drawing. */
  interface Props {
    kind: DeckDrawingKind;
  }
  let { kind }: Props = $props();
</script>

<svg viewBox="0 0 96 96" class="drawing" aria-hidden="true">
  {#if kind === 'preview'}
    <!-- a slide inside its sandbox: the dashed frame is the isolation -->
    <rect class="ln ln--soft" x="7" y="15" width="82" height="66" rx="8" />
    <rect class="bx" x="18" y="26" width="60" height="44" rx="5" />
    <line class="ln ln--thin" x1="25" y1="35" x2="39" y2="35" />
    <circle class="ring" cx="48" cy="50" r="11.5" />
    <g class="shift shift-x">
      <path class="ln ln--c draw" pathLength="1" d="M44.5,43.8 L55,50 L44.5,56.2 Z" />
    </g>
  {:else if kind === 'details'}
    <!-- the deck's own words about itself: a sheet with its folded corner
         (the briefing an agent reads), and the label tied to it (the
         metadata), the tag the one accent -->
    <path class="bx" d="M14,12 H52 L64,24 V84 H14 Z" />
    <path class="ln ln--thin" d="M52,12 V24 H64" />
    <line class="ln" x1="22" y1="32" x2="44" y2="32" />
    <line class="ln ln--thin" x1="22" y1="41" x2="54" y2="41" />
    <line class="ln ln--thin" x1="22" y1="48" x2="50" y2="48" />
    <line class="ln ln--thin" x1="22" y1="55" x2="54" y2="55" />
    <line class="ln ln--soft" x1="22" y1="66" x2="42" y2="66" />
    <path class="ln ln--thin" d="M58,62 C64,62 66,58 70,54" />
    <g class="shift shift-y">
      <path class="bx bx--front" d="M66,44 H84 Q88,44 88,48 V58 Q88,62 84,62 H66 L60,53 Z" />
      <circle class="ring" cx="68" cy="53" r="2.2" />
      <line class="ln ln--c draw" pathLength="1" x1="74" y1="53" x2="83" y2="53" />
    </g>
  {:else if kind === 'links'}
    <!-- a slide and the readers its links reach: one reading now, one who
         read, one whose link is gone -->
    <rect class="bx" x="6" y="31" width="40" height="30" rx="4.5" />
    <line class="ln" x1="13" y1="41" x2="26" y2="41" />
    <line class="ln ln--thin" x1="13" y1="48" x2="38" y2="48" />
    <line class="ln ln--thin" x1="13" y1="54" x2="31" y2="54" />
    <path class="ln ln--thin" d="M46,40 C60,38 64,22 75,19.5" />
    <path class="ln ln--soft" d="M46,52 C60,54 64,72 74,76" />
    <path class="ln ln--c draw" pathLength="1" d="M46,46 C58,46 66,47 73,47.5" />
    <circle class="dot" cx="80" cy="18" r="3.2" />
    <circle class="ring" cx="79" cy="78" r="3.4" />
    <g class="shift shift-x">
      <circle class="ring ring--c" cx="83" cy="48" r="8" />
      <circle class="dot dot--c" cx="83" cy="48" r="3.6" />
    </g>
  {:else if kind === 'projects'}
    <!-- a folder, and the slide that goes into it -->
    <path class="ln ln--soft" d="M12,34 V27 Q12,23 16,23 H33 L39,30 H50" />
    <rect class="bx" x="12" y="34" width="72" height="46" rx="5" />
    <line class="ln ln--thin" x1="21" y1="70" x2="47" y2="70" />
    <g class="shift shift-y">
      <rect class="bx bx--front" x="40" y="16" width="38" height="28" rx="4" />
      <line class="ln ln--thin" x1="47" y1="25" x2="60" y2="25" />
      <line class="ln ln--c draw" pathLength="1" x1="47" y1="33" x2="70" y2="33" />
    </g>
  {:else if kind === 'collaborators'}
    <!-- people joined to one slide; one of them holds the pen -->
    <rect class="bx" x="44" y="27" width="46" height="36" rx="4.5" />
    <line class="ln ln--thin" x1="51" y1="37" x2="66" y2="37" />
    <line class="ln ln--thin" x1="51" y1="44" x2="82" y2="44" />
    <line class="ln ln--c draw" pathLength="1" x1="51" y1="54" x2="69" y2="54" />
    <g class="ln ln--soft">
      <path d="M19,22 C30,24 36,32 43,36" />
      <path d="M17,49 H43" />
      <path d="M21,78 C31,74 37,64 43,58" />
    </g>
    <circle class="ring" cx="12" cy="20" r="6.5" />
    <circle class="dot" cx="12" cy="20" r="3" />
    <circle class="ring" cx="10" cy="49" r="6.5" />
    <circle class="dot" cx="10" cy="49" r="3" />
    <circle class="ring" cx="14" cy="80" r="6.5" />
    <circle class="dot" cx="14" cy="80" r="3" />
    <!-- the pen, resting on the line it just wrote -->
    <g class="shift shift-pen">
      <path class="ln" d="M70.5,53 L73,47.5 L84,31 L88,33.8 L77,50.2 Z" />
      <line class="ln ln--thin" x1="81.6" y1="34.6" x2="85.6" y2="37.4" />
    </g>
  {:else if kind === 'annotations'}
    <!-- a slide, the spot a reader marked, and the note pinned to it -->
    <rect class="bx" x="7" y="33" width="66" height="46" rx="5" />
    <line class="ln" x1="15" y1="44" x2="31" y2="44" />
    <line class="ln ln--thin" x1="15" y1="52" x2="46" y2="52" />
    <line class="ln ln--thin" x1="15" y1="59" x2="25" y2="59" />
    <path class="ln ln--soft" d="M42,60 C48,50 55,42 63,33" />
    <circle class="ring ring--c" cx="37" cy="66" r="7.5" />
    <circle class="dot dot--c" cx="37" cy="66" r="3.4" />
    <g class="shift shift-y">
      <rect class="bx" x="56" y="6" width="35" height="25" rx="4" />
      <line class="ln ln--thin" x1="62" y1="14" x2="76" y2="14" />
      <line class="ln ln--thin" x1="62" y1="20.5" x2="71" y2="20.5" />
      <path class="ln draw" pathLength="1" d="M75.5,22 L79,25.5 L85.5,17.5" />
    </g>
  {:else if kind === 'forms'}
    <!-- a slide carrying a form: choices as boxes, one ticked, a field, a button -->
    <rect class="bx" x="9" y="15" width="78" height="66" rx="5.5" />
    <rect class="ln ln--thin" x="18" y="25" width="10" height="10" rx="2.5" />
    <line class="ln ln--thin" x1="34" y1="30" x2="62" y2="30" />
    <rect class="ln ln--thin" x="18" y="41" width="10" height="10" rx="2.5" />
    <line class="ln ln--thin" x1="34" y1="46" x2="54" y2="46" />
    <path class="ln ln--c draw" pathLength="1" d="M20.2,45.8 L22.8,48.6 L27.6,42.6" />
    <rect class="ln ln--thin" x="18" y="59" width="40" height="13" rx="3.5" />
    <line class="ln ln--soft" x1="23" y1="65.5" x2="40" y2="65.5" />
    <g class="shift shift-x">
      <rect class="bx bx--front" x="63" y="59" width="16" height="13" rx="3.5" />
      <path class="ln" d="M68.5,65.5 H73.5 M71.5,63 L74,65.5 L71.5,68" />
    </g>
  {:else}
    <!-- the versions as a wall in running bond: the top course unfinished,
         one brick dotted in its slot and the next one floating above it -->
    <defs>
      <pattern
        id="deck-drawing-hatch"
        width="5"
        height="5"
        patternUnits="userSpaceOnUse"
        patternTransform="rotate(45)"
      >
        <line class="hatch" x1="0" y1="0" x2="0" y2="5" />
      </pattern>
    </defs>
    <g class="brick">
      <rect x="9" y="70" width="37" height="15" rx="2.5" />
      <rect x="50" y="70" width="37" height="15" rx="2.5" />
      <rect x="9" y="51" width="16.5" height="15" rx="2.5" />
      <rect x="29.5" y="51" width="37" height="15" rx="2.5" />
      <rect x="70.5" y="51" width="16.5" height="15" rx="2.5" />
      <rect x="9" y="32" width="37" height="15" rx="2.5" />
    </g>
    <rect class="ln ln--soft" x="50" y="32" width="37" height="15" rx="2.5" />
    <g class="shift shift-brick">
      <rect class="bx bx--front" x="50" y="8" width="37" height="15" rx="2.5" />
      <rect class="ln ln--c draw" pathLength="1" x="50" y="8" width="37" height="15" rx="2.5" />
      <line class="ln ln--thin" x1="56" y1="15.5" x2="68" y2="15.5" />
    </g>
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
  .drawing :is(.ln, .bx, .ring, .brick) {
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
  .ln--thin {
    stroke: color-mix(in oklab, var(--ink) 30%, transparent);
    stroke-width: 1;
  }
  .bx {
    fill: color-mix(in oklab, var(--ground) 40%, transparent);
    stroke: color-mix(in oklab, var(--ink) 40%, transparent);
    stroke-width: 1;
  }
  /* the box in front hides what is behind it, the way paper does */
  .bx--front {
    fill: var(--plate-strong);
  }
  .brick > rect {
    fill: url(#deck-drawing-hatch);
    stroke: color-mix(in oklab, var(--ink) 40%, transparent);
    stroke-width: 1;
  }
  .hatch {
    stroke: color-mix(in oklab, var(--ink) 16%, transparent);
    stroke-width: 1;
  }
  .dot {
    fill: color-mix(in oklab, var(--ink) 78%, transparent);
  }
  .ring {
    fill: none;
    stroke: color-mix(in oklab, var(--ink) 42%, transparent);
    stroke-width: 1;
  }
  /* the one place the accent goes */
  .ln--c {
    stroke: var(--accent);
    stroke-width: 1.6;
  }
  .dot--c {
    fill: var(--accent);
  }
  .ring--c {
    stroke: var(--accent);
  }

  /* what moves */
  .shift {
    transition: transform 460ms var(--motion-ease);
    transform-box: fill-box;
    transform-origin: center;
  }
  .shift-brick {
    transform: rotate(-9deg);
  }
  .draw {
    stroke-dasharray: 1;
    stroke-dashoffset: 0;
  }

  @media (prefers-reduced-motion: no-preference) {
    /* the accent line is drawn once, when the section arrives */
    .draw {
      animation: draw 900ms var(--motion-ease) 240ms 1 backwards;
    }
    :global(.deck-head:hover) .shift-x {
      transform: translateX(2.5px);
    }
    :global(.deck-head:hover) .shift-y {
      transform: translateY(-2.5px);
    }
    :global(.deck-head:hover) .shift-pen {
      transform: translate(3px, -1px) rotate(4deg);
    }
    /* the next version comes down toward its slot */
    :global(.deck-head:hover) .shift-brick {
      transform: translateY(7px) rotate(-3deg);
    }
  }
  @keyframes draw {
    from {
      stroke-dashoffset: 1;
    }
    to {
      stroke-dashoffset: 0;
    }
  }
</style>
