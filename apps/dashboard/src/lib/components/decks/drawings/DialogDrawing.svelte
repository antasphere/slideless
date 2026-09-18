<script lang="ts" module>
  export type DialogDrawingKind = 'share' | 'shared' | 'invite' | 'invited';
</script>

<script lang="ts">
  /* The drawing in a dialog's side panel, in the hand of the presentations'
     figures (the vocabulary DeckDrawing and StatDrawing already speak): ink
     at low opacity, boxes filled with a breath of paper, the ringed dot as
     the focal marker, and the accent used ONCE, on the element that carries
     the meaning. Each one is literal:

     - share / shared: a deck, and the one link that leaves it toward one
       reader; the faint seats are the other readers, each owed a link of
       their own. Once the link exists it carries its chain glyph.
     - invite / invited: people around one slide; the accent is the person
       being invited, reached by a dashed line until they claim it.

     The accent line is drawn once when the dialog opens; a reader who asked
     for no motion gets the still drawing. Ink comes from the tokens, so the
     dark set just works. */
  interface Props {
    kind: DialogDrawingKind;
  }
  let { kind }: Props = $props();

  const uid = $props.id();
</script>

<svg viewBox="0 0 240 250" class="drawing" aria-hidden="true">
  <defs>
    <marker
      id="{uid}-arrow"
      viewBox="0 0 10 10"
      refX="8"
      refY="5"
      markerWidth="9"
      markerHeight="9"
      orient="auto-start-reverse"
      markerUnits="userSpaceOnUse"
    >
      <path class="head" d="M1.5,1.5 L8,5 L1.5,8.5" />
    </marker>
    <marker
      id="{uid}-arrow-c"
      viewBox="0 0 10 10"
      refX="8"
      refY="5"
      markerWidth="10"
      markerHeight="10"
      orient="auto-start-reverse"
      markerUnits="userSpaceOnUse"
    >
      <path class="head head--c" d="M1.5,1.5 L8,5 L1.5,8.5" />
    </marker>
  </defs>

  {#if kind === 'share' || kind === 'shared'}
    <!-- the other readers: seats, each waiting for a link of its own -->
    <g class="ln ln--soft">
      <path d="M62,142 C56,116 50,92 49,70" />
      <path d="M92,140 C100,104 110,70 114,46" />
    </g>
    <circle class="ring" cx="48" cy="58" r="9" />
    <circle class="ring" cx="116" cy="34" r="9" />

    <!-- the deck: three slides fanned from one corner -->
    <line class="ln ln--thin" x1="10" y1="232" x2="150" y2="232" />
    <rect class="bx fan fan-l" x="22" y="150" width="106" height="68" rx="7" />
    <rect class="bx fan fan-r" x="22" y="150" width="106" height="68" rx="7" />
    <rect class="bx bx--front" x="22" y="150" width="106" height="68" rx="7" />
    <line class="ln" x1="36" y1="170" x2="66" y2="170" />
    <line class="ln ln--thin" x1="36" y1="184" x2="108" y2="184" />
    <line class="ln ln--thin" x1="36" y1="197" x2="90" y2="197" />

    <!-- the link, leaving the deck toward its one reader -->
    <path
      class="ln ln--c draw"
      pathLength="1"
      d="M130,170 C172,162 198,132 198,88"
      marker-end="url(#{uid}-arrow-c)"
    />
    {#if kind === 'shared'}
      <g class="chain" transform="translate(179 141) rotate(-52)">
        <rect class="bx bx--front" x="-13" y="-5" width="16" height="10" rx="5" />
        <rect class="bx bx--front" x="-3" y="-5" width="16" height="10" rx="5" />
      </g>
    {/if}

    <!-- the reader: the ringed dot -->
    <circle class="ring" cx="198" cy="62" r="19" />
    <circle class="ring ring--pulse" cx="198" cy="62" r="19" />
    <circle class="dot" cx="198" cy="62" r="6" />
  {:else}
    <!-- one slide, and the people who work on it -->
    <rect class="bx" x="52" y="140" width="136" height="88" rx="8" />
    <line class="ln" x1="68" y1="162" x2="110" y2="162" />
    <line class="ln ln--thin" x1="68" y1="180" x2="166" y2="180" />
    <line class="ln ln--thin" x1="68" y1="196" x2="140" y2="196" />
    <line class="ln ln--thin" x1="68" y1="212" x2="122" y2="212" />

    <!-- the owner and a collaborator already there -->
    <path class="ln" d="M52,80 C60,104 72,122 84,138" />
    <path class="ln ln--thin" d="M120,60 V138" />
    <circle class="ring" cx="46" cy="64" r="14" />
    <circle class="dot" cx="46" cy="64" r="5" />
    <circle class="ring" cx="120" cy="44" r="11" />
    <circle class="dot" cx="120" cy="44" r="4" />

    <!-- the invitation on its way: dashed until it is claimed -->
    <path class="ln ln--soft" d="M158,138 C170,120 184,100 191,84" marker-end="url(#{uid}-arrow)" />
    {#if kind === 'invited'}
      <g class="chain" transform="translate(175 112) rotate(-56)">
        <rect class="bx bx--front" x="-13" y="-5" width="16" height="10" rx="5" />
        <rect class="bx bx--front" x="-3" y="-5" width="16" height="10" rx="5" />
      </g>
    {/if}
    <circle class="ring ring--c" cx="198" cy="64" r="16" />
    <circle class="ring ring--c ring--pulse" cx="198" cy="64" r="16" />
    <circle class="dot dot--c" cx="198" cy="64" r="5.5" />
  {/if}
</svg>

<style>
  .drawing {
    display: block;
    width: 100%;
    max-width: 260px;
    height: auto;
    overflow: visible;
  }
  .drawing :is(.ln, .bx, .ring, .head) {
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
    stroke-dasharray: 4 5;
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
    fill: var(--bar);
  }
  .dot {
    fill: color-mix(in oklab, var(--ink) 78%, transparent);
  }
  .ring {
    fill: none;
    stroke: color-mix(in oklab, var(--ink) 42%, transparent);
    stroke-width: 1;
  }
  .head {
    fill: none;
    stroke: color-mix(in oklab, var(--ink) 55%, transparent);
    stroke-width: 1.1;
  }
  /* the one place the accent goes */
  .ln--c {
    stroke: var(--accent);
    stroke-width: 1.7;
  }
  .head--c {
    stroke: var(--accent);
    stroke-width: 1.5;
  }
  .dot--c {
    fill: var(--accent);
  }
  .ring--c {
    stroke: var(--accent);
  }

  .fan {
    transform-origin: 75px 262px;
  }
  .fan-l {
    transform: rotate(-9deg);
  }
  .fan-r {
    transform: rotate(9deg);
  }
  .ring--pulse {
    opacity: 0;
    transform-box: fill-box;
    transform-origin: center;
  }
  .draw {
    stroke-dasharray: 1;
    stroke-dashoffset: 0;
  }

  @media (prefers-reduced-motion: no-preference) {
    .draw {
      animation: dialog-draw 900ms var(--motion-ease) 260ms 1 backwards;
    }
    .ring--pulse {
      animation: dialog-pulse 1400ms var(--motion-ease) 1000ms 1;
    }
    .chain {
      animation: dialog-arrive 500ms var(--motion-ease) 700ms 1 backwards;
    }
  }
  @keyframes dialog-draw {
    from {
      stroke-dashoffset: 1;
    }
  }
  @keyframes dialog-pulse {
    from {
      opacity: 0.7;
      transform: scale(1);
    }
    to {
      opacity: 0;
      transform: scale(1.7);
    }
  }
  @keyframes dialog-arrive {
    from {
      opacity: 0;
    }
  }
</style>
