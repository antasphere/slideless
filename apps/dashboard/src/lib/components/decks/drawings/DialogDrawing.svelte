<script lang="ts" module>
  export type DialogDrawingKind =
    'share' | 'shared' | 'invite' | 'invited' | 'key' | 'member' | 'membered' | 'push' | 'workspace';
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
     - key: a key, and the scopes that leave it as tags; the accent is the
       one a caller reaches for first, the others wait on dashed lines.
     - member / membered: the people already in the workspace, and an
       envelope whose link travels to the one who joins; the link carries
       its chain glyph once it exists.
     - push: a terminal prompt sending a folder of slides up to the deck,
       where it lands as the new version.
     - workspace: the space, rings around a centre on its ground, its people
       on the outer ring each tied to the centre; the accent is the ring
       closing around them (the hub's organization drawing).

     The accent line is drawn once when the dialog opens; a reader who asked
     for no motion gets the still drawing. Ink comes from the tokens, so the
     dark set just works. */
  interface Props {
    kind: DialogDrawingKind;
    /**
     * A walk's shape, for the `workspace` drawing: how many steps it has and how
     * many are behind the person. The outer ring is divided into that many
     * arcs, one seat per step on the divisions, and the accent travels
     * around as the walk advances — it does not restart at each step.
     */
    steps?: number;
    done?: number;
  }
  let { kind, steps = 3, done = 0 }: Props = $props();

  /* The ring's geometry, computed rather than drawn: the seats sit on the
     divisions between arcs, so three steps give three seats and four give
     four. Angles start at the top and run clockwise. */
  const C = { x: 120, y: 126, r: 84 };
  const polar = (angle: number, radius: number) => ({
    x: C.x + radius * Math.cos(((angle - 90) * Math.PI) / 180),
    y: C.y + radius * Math.sin(((angle - 90) * Math.PI) / 180)
  });
  const seats = $derived(
    Array.from({ length: steps }, (_, i) => {
      const angle = (360 / steps) * i;
      return { angle, ...polar(angle, C.r), inner: polar(angle, 30), stop: polar(angle, C.r - 14) };
    })
  );
  /**
   * How far round the walk has gone, in seats: 0 at the first step, `steps`
   * once the walk is over. The accent is ONE fixed circle revealed by its dash
   * offset, measured in the ring's REAL length: a normalised `pathLength`
   * under `non-scaling-stroke` is dashed in screen units, which showed a
   * sliver before the start and overshot every stop. Each step advances the
   * accent by one division, so it always stops on a seat.
   */
  const reached = $derived(Math.max(0, Math.min(done, steps)));
  const LENGTH = 2 * Math.PI * C.r;
  const offset = $derived(LENGTH * (1 - reached / steps));
  /** A circle drawn from the top, clockwise, as two half arcs (one arc cannot close a circle). */
  const RING = `M${C.x},${C.y - C.r} A${C.r},${C.r} 0 0 1 ${C.x},${C.y + C.r} A${C.r},${C.r} 0 0 1 ${C.x},${C.y - C.r}`;

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
    <radialGradient id="{uid}-wash">
      <stop class="wash-stop wash-stop--in" offset="0.35" />
      <stop class="wash-stop wash-stop--out" offset="1" />
    </radialGradient>
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
  {:else if kind === 'key'}
    <!-- the scopes that wait: tags on dashed lines -->
    <path class="ln ln--soft" d="M84,176 C104,150 122,124 146,102" />
    <path class="ln ln--soft" d="M92,186 C112,172 126,158 138,150" />
    <g>
      <rect class="bx bx--front" x="148" y="80" width="72" height="24" rx="7" />
      <circle class="ring" cx="161" cy="92" r="3.5" />
      <line class="ln ln--thin" x1="170" y1="92" x2="192" y2="92" />
      <line class="ln ln--thin" x1="200" y1="80" x2="200" y2="104" />
    </g>
    <g>
      <rect class="bx bx--front" x="140" y="126" width="84" height="24" rx="7" />
      <circle class="ring" cx="153" cy="138" r="3.5" />
      <line class="ln ln--thin" x1="162" y1="138" x2="194" y2="138" />
      <line class="ln ln--thin" x1="204" y1="126" x2="204" y2="150" />
    </g>

    <!-- the key: its bow, its blade and the teeth cut into it -->
    <line class="ln ln--thin" x1="10" y1="232" x2="190" y2="232" />
    <path class="bx bx--front" d="M78,184 H178 V196 H168 V210 H158 V196 H148 V204 H138 V196 H78 Z" />
    <circle class="bx bx--front" cx="58" cy="190" r="26" />
    <circle class="ring" cx="58" cy="190" r="9" />
    <circle class="dot" cx="58" cy="190" r="3.5" />

    <!-- the scope a caller reaches for first -->
    <path
      class="ln ln--c draw"
      pathLength="1"
      d="M66,164 C74,118 96,72 128,50"
      marker-end="url(#{uid}-arrow-c)"
    />
    <g>
      <rect class="bx bx--front" x="132" y="30" width="90" height="24" rx="7" />
      <circle class="ring" cx="145" cy="42" r="3.5" />
      <circle class="ring ring--pulse" cx="145" cy="42" r="3.5" />
      <line class="ln" x1="154" y1="42" x2="192" y2="42" />
      <line class="ln ln--thin" x1="202" y1="30" x2="202" y2="54" />
    </g>
  {:else if kind === 'member' || kind === 'membered'}
    <!-- the people already in the workspace, tied to one another -->
    <path class="ln ln--thin" d="M58,62 C76,50 92,42 106,38" />
    <path class="ln ln--soft" d="M128,36 C150,38 164,46 178,54" />
    <circle class="ring" cx="46" cy="68" r="13" />
    <circle class="dot" cx="46" cy="68" r="4.5" />
    <circle class="ring" cx="117" cy="36" r="10" />
    <circle class="dot" cx="117" cy="36" r="3.5" />

    <!-- the invitation: an envelope, its flap closed -->
    <line class="ln ln--thin" x1="10" y1="232" x2="150" y2="232" />
    <rect class="bx bx--front" x="22" y="150" width="108" height="72" rx="7" />
    <path class="ln" d="M24,158 L76,194 L128,158" />
    <path class="ln ln--thin" d="M24,218 L58,184 M128,218 L94,184" />

    <!-- its link, on the way to the one who joins -->
    <path
      class="ln ln--c draw"
      pathLength="1"
      d="M132,172 C174,164 198,134 198,90"
      marker-end="url(#{uid}-arrow-c)"
    />
    {#if kind === 'membered'}
      <g class="chain" transform="translate(180 142) rotate(-52)">
        <rect class="bx bx--front" x="-13" y="-5" width="16" height="10" rx="5" />
        <rect class="bx bx--front" x="-3" y="-5" width="16" height="10" rx="5" />
      </g>
    {/if}
    <circle class="ring" cx="198" cy="64" r="18" />
    <circle class="ring ring--pulse" cx="198" cy="64" r="18" />
    <circle class="dot" cx="198" cy="64" r="6" />
  {:else if kind === 'workspace'}
    <!-- the end effect's wash: a breath of the accent that swells out of the
         closed ring and fades as it goes -->
    <circle
      class="wash"
      class:wash--go={reached >= steps}
      cx={C.x}
      cy={C.y}
      r={C.r}
      fill="url(#{uid}-wash)"
    />

    <g class="space" class:space--closed={reached >= steps}>
      <!-- the space: the ring the walk goes round, on its ground -->
      <line class="ln ln--thin" x1="10" y1="232" x2="230" y2="232" />
      <circle class="ring" cx={C.x} cy={C.y} r={C.r} />
      <circle class="ln ln--soft" cx={C.x} cy={C.y} r="46" />

      <!-- how far the walk has gone: the accent, one fixed path revealed
           further at each step. It sits UNDER the seats, so its tip always
           ends behind the seat it has reached -->
      <path
        class="ln ln--c travel"
        d={RING}
        stroke-dasharray="{LENGTH} {LENGTH}"
        stroke-dashoffset={offset}
      />

      <!-- one seat per step, on the ring's divisions, each tied to the centre;
           a seat the walk has reached is filled, the ones ahead stay open -->
      {#each seats as seat, i (i)}
        <path class="ln ln--thin" d="M{seat.inner.x},{seat.inner.y} L{seat.stop.x},{seat.stop.y}" />
        <circle class="bx bx--front" cx={seat.x} cy={seat.y} r="12" />
        <circle class="dot seat-dot" class:dot--ahead={i > reached} cx={seat.x} cy={seat.y} r="4" />
      {/each}

      <!-- the centre -->
      <circle class="bx bx--front" cx={C.x} cy={C.y} r="22" />
      <circle class="ring" cx={C.x} cy={C.y} r="9" />
      <circle class="ring ring--pulse" cx={C.x} cy={C.y} r="9" />
      <circle class="dot" cx={C.x} cy={C.y} r="3.5" />
    </g>
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
  .fan-up {
    transform-origin: 164px 140px;
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
  /* the walk's arc: one path, revealed further at each step. Only the dash
     offset moves, so the line grows along the ring and nothing re-lays out.
     It scales with the drawing (no non-scaling-stroke): its dashes must be
     measured in the same units as its length. */
  .drawing {
    --travel: calc(var(--motion-duration) * 3.4);
  }
  .drawing .travel {
    vector-effect: none;
    transition: stroke-dashoffset var(--travel) cubic-bezier(0.65, 0, 0.35, 1);
  }
  /* a seat lights when the accent arrives, not when it leaves */
  .seat-dot {
    transition: fill var(--motion-duration) var(--motion-ease) var(--travel);
  }
  /* a seat the walk has not reached: present, not yet lit */
  .dot--ahead {
    fill: color-mix(in oklab, var(--ink) 26%, transparent);
    transition-delay: 0ms;
  }
  /* the end effect: once the ring has closed, the space gathers itself and
     lets go like a droplet, leaving a wash of the accent behind it */
  .space,
  .wash {
    transform-box: view-box;
    transform-origin: 120px 126px;
  }
  .wash {
    opacity: 0;
  }
  .wash-stop {
    stop-color: var(--accent);
  }
  .wash-stop--in {
    stop-opacity: 0.32;
  }
  .wash-stop--out {
    stop-opacity: 0;
  }
  @media (prefers-reduced-motion: reduce) {
    .drawing .travel,
    .seat-dot {
      transition: none;
    }
    .space--closed {
      opacity: 0;
    }
  }
  @media (prefers-reduced-motion: no-preference) {
    .space--closed {
      animation: space-release 560ms var(--travel) 1 forwards;
    }
    .wash--go {
      animation: space-wash 1100ms cubic-bezier(0.16, 1, 0.3, 1) calc(var(--travel) + 200ms) 1 both;
    }
  }
  @keyframes space-release {
    0% {
      transform: scale(1);
      opacity: 1;
      animation-timing-function: cubic-bezier(0.5, 0, 0.75, 0);
    }
    42% {
      transform: scale(0.86);
      opacity: 1;
      animation-timing-function: cubic-bezier(0.16, 1, 0.3, 1);
    }
    100% {
      transform: scale(1.22);
      opacity: 0;
    }
  }
  @keyframes space-wash {
    0% {
      opacity: 0;
      transform: scale(0.7);
    }
    25% {
      opacity: 1;
    }
    100% {
      opacity: 0;
      transform: scale(1.7);
    }
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
