<!-- The drawing on an app's card on the Apps page, in the hand of the
     brand's line figures: ink at low opacity, boxes filled with the bar's
     paper, the ringed dot as the focal marker, the accent used ONCE, on what
     carries the meaning. One literal picture per name of the contract's
     TOOL_DRAWINGS list (PRDCT-3493), chosen by the tool's registry
     descriptor: the ledger and its coin (ledger), three seats narrowing into
     one (funnel), the clock and the day sheet (clock-sheet), two contact cards
     tied by a line (cards), a tree of three boxes and its key (tree-key),
     concentric rings with a seat on the outer one (rings: the account), three
     named sheets in the project that holds them (sheets: the template's own
     concept), two envelopes and a thread (envelopes), a sheet and the stroke
     across its line (signature), three lanes meeting at one merge (lanes), a
     deck of three slides, the front one lit (slides), three steps and the cup
     (podium). This tool's own card with no drawing declared draws `sheets`
     (a tool born from the template names its own in the registry); any other
     tool with none gets a plate with its first letter in the display serif. -->
<script lang="ts" module>
  import type { ToolDrawing } from '@antasphere/chassis-contract';

  /** The names this file draws; a test pins the list equal to the contract's TOOL_DRAWINGS. */
  export const DRAWN_KINDS: readonly ToolDrawing[] = [
    'ledger',
    'funnel',
    'clock-sheet',
    'cards',
    'tree-key',
    'rings',
    'sheets',
    'envelopes',
    'signature',
    'lanes',
    'slides',
    'podium'
  ];
</script>

<script lang="ts">
  interface Props {
    /** The registry's drawing name; absent for a tool that declares none. */
    drawing?: string | null;
    /** The name the monogram reads its letter from, for a tool with no drawing. */
    name?: string;
    /** This very tool: with no drawing declared, it draws the template's own concept rather than a monogram. */
    current?: boolean;
  }

  let { drawing = null, name = '', current = false }: Props = $props();

  const known = new Set<string>(DRAWN_KINDS);
  const kind = $derived(drawing && known.has(drawing) ? drawing : current ? 'sheets' : 'other');
  const letter = $derived((name.trim() || '?').charAt(0).toUpperCase());

  // the account's seat sits on the outer ring, up and to the right
  const SEAT_ANGLE = (-40 * Math.PI) / 180;
  const seatX = 120 + 40 * Math.cos(SEAT_ANGLE);
  const seatY = 58 + 40 * Math.sin(SEAT_ANGLE);
</script>

<svg viewBox="0 0 240 116" class="drawing" aria-hidden="true" data-drawing={kind}>
  <!-- the ground every drawing stands on -->
  <line class="ln ln--thin" x1="14" y1="106" x2="226" y2="106" />

  {#if kind === 'ledger'}
    <!-- the ledger: a ruled sheet, its column of figures, one coin beside it -->
    <rect class="bx" x="44" y="14" width="112" height="84" rx="6" />
    {#each [32, 44, 56, 68, 80] as y (y)}
      <line class="ln ln--thin" x1="54" y1={y} x2="146" y2={y} />
    {/each}
    <line class="ln ln--soft" x1="112" y1="24" x2="112" y2="90" />
    <line class="ln" x1="58" y1="26" x2="92" y2="26" />
    {#each [[38, 140], [50, 134], [62, 142], [74, 130]] as [y, x2] (y)}
      <line class="ln" x1="120" y1={y} {x2} y2={y} />
    {/each}
    <line class="ln title" x1="120" y1="88" x2="142" y2="88" />
    <circle class="bx" cx="186" cy="80" r="15" />
    <circle class="bx" cx="180" cy="72" r="15" />
    <circle class="ring ring--c" cx="180" cy="72" r="10" />
    <circle class="seat" cx="180" cy="72" r="2.6" />
  {:else if kind === 'funnel'}
    <!-- three seats narrowing into one: the funnel of a hire -->
    <path class="ln ln--soft" d="M46,16 C70,40 98,62 110,90" />
    <path class="ln ln--soft" d="M194,16 C170,40 142,62 130,90" />
    {#each [72, 120, 168] as x (x)}
      <path class="ln ln--thin" d="M{x},34 C{x},58 120,62 120,84" />
      <circle class="bx" cx={x} cy="26" r="10" />
      <circle class="ring" cx={x} cy="26" r="6" />
      <circle class="seat" cx={x} cy="26" r="2.4" />
    {/each}
    <circle class="bx" cx="120" cy="90" r="12" />
    <circle class="ring ring--c" cx="120" cy="90" r="8" />
    <circle class="seat seat--on" cx="120" cy="90" r="3.4" />
  {:else if kind === 'clock-sheet'}
    <!-- the clock the hours come from, and the day sheet they land on -->
    <rect class="bx" x="102" y="14" width="104" height="86" rx="6" />
    <line class="ln title" x1="114" y1="27" x2="150" y2="27" />
    {#each [42, 56, 70, 84] as y (y)}
      <line class="ln ln--thin" x1="114" y1={y} x2="194" y2={y} />
    {/each}
    <rect class="slot" x="128" y="58" width="58" height="10" rx="3" />
    <circle class="bx" cx="72" cy="62" r="28" />
    <circle class="ring" cx="72" cy="62" r="20" />
    <line class="ln" x1="72" y1="62" x2="72" y2="49" />
    <line class="ln" x1="72" y1="62" x2="82" y2="67" />
    <circle class="seat seat--on" cx="72" cy="62" r="2.6" />
  {:else if kind === 'cards'}
    <!-- two contact cards, tied by a line -->
    <path class="ln ln--c" d="M106,52 C122,46 124,72 138,68" />
    {#each [[26, 26], [138, 44]] as [x, y] (x)}
      <rect class="bx" {x} {y} width="80" height="50" rx="7" />
      <circle class="ring" cx={x + 18} cy={y + 18} r="8" />
      <circle class="seat" cx={x + 18} cy={y + 18} r="2.6" />
      <line class="ln title" x1={x + 32} y1={y + 15} x2={x + 66} y2={y + 15} />
      <line class="ln ln--thin" x1={x + 32} y1={y + 24} x2={x + 58} y2={y + 24} />
      <line class="ln ln--thin" x1={x + 10} y1={y + 38} x2={x + 62} y2={y + 38} />
    {/each}
  {:else if kind === 'tree-key'}
    <!-- a tree of three boxes, and the key that opens it -->
    <path class="ln" d="M120,36 L120,48 M66,60 L66,48 L174,48 L174,60" />
    <rect class="bx" x="94" y="12" width="52" height="24" rx="5" />
    <line class="ln title" x1="104" y1="24" x2="130" y2="24" />
    {#each [40, 148] as x (x)}
      <rect class="bx" {x} y="60" width="52" height="24" rx="5" />
      <line class="ln ln--thin" x1={x + 10} y1="72" x2={x + 36} y2="72" />
    {/each}
    <g class="key">
      <circle class="ring ring--c" cx="112" cy="84" r="7" />
      <path class="ln ln--c" d="M119,84 L140,84 M134,84 L134,90 M139,84 L139,89" />
    </g>
  {:else if kind === 'rings'}
    <!-- concentric rings, a seat on the outer one: the account and its people -->
    <circle class="ring" cx="120" cy="58" r="40" />
    <circle class="ring ring--soft" cx="120" cy="58" r="27" />
    <circle class="bx" cx="120" cy="58" r="14" />
    <circle class="seat seat--on" cx="120" cy="58" r="3.4" />
    {#each [150, 205] as deg (deg)}
      <circle
        class="seat"
        cx={120 + 40 * Math.cos((deg * Math.PI) / 180)}
        cy={58 + 40 * Math.sin((deg * Math.PI) / 180)}
        r="2.6"
      />
    {/each}
    <circle class="bx" cx={seatX} cy={seatY} r="8" />
    <circle class="ring ring--c" cx={seatX} cy={seatY} r="5" />
  {:else if kind === 'sheets'}
    <!-- three named sheets in the project that holds them -->
    <path class="ln ln--soft" d="M30,96 L30,30 L84,30 L92,38 L210,38 L210,96" />
    {#each [[48, 52], [100, 46], [152, 56]] as [x, y], i (x)}
      <rect class="bx" {x} {y} width="42" height="44" rx="5" />
      <line class={i === 1 ? 'ln title' : 'ln'} x1={x + 8} y1={y + 12} x2={x + 30} y2={y + 12} />
      <line class="ln ln--thin" x1={x + 8} y1={y + 22} x2={x + 34} y2={y + 22} />
      <line class="ln ln--thin" x1={x + 8} y1={y + 30} x2={x + 26} y2={y + 30} />
    {/each}
    <circle class="bx" cx="142" cy="46" r="8" />
    <circle class="ring ring--c" cx="142" cy="46" r="5" />
    <circle class="seat seat--on" cx="142" cy="46" r="2.2" />
  {:else if kind === 'envelopes'}
    <!-- two envelopes, the front one open, and the thread that ties a reply to its mail -->
    <rect class="bx" x="36" y="30" width="96" height="58" rx="5" />
    <path class="ln ln--thin" d="M36,34 L84,66 L132,34" />
    <rect class="bx" x="98" y="44" width="106" height="56" rx="5" />
    <path class="ln" d="M98,48 L151,82 L204,48" />
    <path class="ln ln--c" d="M151,82 L151,100 M151,100 L163,100" />
    <circle class="bx" cx="196" cy="34" r="9" />
    <circle class="ring ring--c" cx="196" cy="34" r="5.5" />
    <circle class="seat seat--on" cx="196" cy="34" r="2.2" />
  {:else if kind === 'signature'}
    <!-- a sheet, its lines, and the stroke across the line where the name goes -->
    <rect class="bx" x="62" y="12" width="116" height="90" rx="6" />
    <line class="ln title" x1="76" y1="28" x2="124" y2="28" />
    {#each [40, 50, 60] as y (y)}
      <line class="ln ln--thin" x1="76" y1={y} x2="164" y2={y} />
    {/each}
    <line class="ln ln--thin" x1="76" y1="88" x2="164" y2="88" />
    <path class="ln ln--c" d="M80,86 C92,70 98,70 104,84 C110,96 116,78 126,76 C136,74 140,88 158,80" />
    <circle class="ring ring--c" cx="164" cy="76" r="4.5" />
    <circle class="seat seat--on" cx="164" cy="76" r="2" />
  {:else if kind === 'lanes'}
    <!-- three lanes running side by side, meeting at one merge -->
    {#each [30, 58, 86] as y (y)}
      <line class="ln ln--thin" x1="26" y1={y} x2="150" y2={y} />
      <circle class="bx" cx="52" cy={y} r="6" />
      <circle class="seat" cx="52" cy={y} r="2.2" />
      <circle class="bx" cx="104" cy={y} r="6" />
      <circle class="seat" cx="104" cy={y} r="2.2" />
    {/each}
    <path class="ln ln--soft" d="M150,30 C170,30 176,58 190,58" />
    <path class="ln ln--soft" d="M150,86 C170,86 176,58 190,58" />
    <line class="ln" x1="150" y1="58" x2="190" y2="58" />
    <line class="ln ln--c" x1="190" y1="58" x2="216" y2="58" />
    <circle class="bx" cx="190" cy="58" r="9" />
    <circle class="ring ring--c" cx="190" cy="58" r="5.5" />
    <circle class="seat seat--on" cx="190" cy="58" r="2.4" />
  {:else if kind === 'slides'}
    <!-- a deck of three slides, the front one lit -->
    <rect class="bx" x="72" y="14" width="112" height="66" rx="5" />
    <rect class="bx" x="60" y="22" width="112" height="66" rx="5" />
    <rect class="bx" x="48" y="30" width="112" height="66" rx="5" />
    <line class="ln title" x1="62" y1="48" x2="118" y2="48" />
    <line class="ln ln--thin" x1="62" y1="60" x2="138" y2="60" />
    <line class="ln ln--thin" x1="62" y1="70" x2="128" y2="70" />
    <rect class="slot" x="62" y="80" width="30" height="8" rx="2" />
    <circle class="ring ring--c" cx="146" cy="44" r="5" />
    <circle class="seat seat--on" cx="146" cy="44" r="2.2" />
  {:else if kind === 'podium'}
    <!-- three steps, and the cup on the highest -->
    <rect class="bx" x="40" y="68" width="52" height="38" rx="3" />
    <rect class="bx" x="94" y="48" width="52" height="58" rx="3" />
    <rect class="bx" x="148" y="80" width="52" height="26" rx="3" />
    <line class="ln ln--thin" x1="58" y1="88" x2="74" y2="88" />
    <line class="ln ln--thin" x1="112" y1="80" x2="128" y2="80" />
    <line class="ln ln--thin" x1="166" y1="94" x2="182" y2="94" />
    <path class="ln ln--c" d="M108,20 L132,20 L129,34 C128,40 112,40 111,34 Z" />
    <path class="ln ln--c" d="M120,40 L120,46 M113,46 L127,46" />
    <circle class="ring ring--c" cx="120" cy="30" r="3.5" />
  {:else}
    <!-- any other tool: a plate with its first letter -->
    <rect class="bx" x="88" y="16" width="64" height="74" rx="12" />
    <text class="monogram" x="120" y="66" text-anchor="middle">{letter}</text>
    <line class="ln ln--c" x1="108" y1="78" x2="132" y2="78" />
  {/if}
</svg>

<style>
  .drawing {
    display: block;
    width: 100%;
    max-width: 240px;
    height: auto;
    overflow: visible;
  }
  .drawing :is(.ln, .bx, .ring, .slot) {
    vector-effect: non-scaling-stroke;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .ln {
    fill: none;
    stroke: color-mix(in oklab, var(--ink) 45%, transparent);
    stroke-width: 1.2;
  }
  .ln--soft {
    stroke: color-mix(in oklab, var(--ink) 30%, transparent);
    stroke-dasharray: 4 5;
  }
  .ln--thin {
    stroke: color-mix(in oklab, var(--ink) 30%, transparent);
    stroke-width: 1;
  }
  .title {
    stroke: color-mix(in oklab, var(--ink) 62%, transparent);
    stroke-width: 1.6;
  }
  .bx {
    fill: var(--bar);
    stroke: color-mix(in oklab, var(--ink) 40%, transparent);
    stroke-width: 1;
  }
  .ring {
    fill: none;
    stroke: color-mix(in oklab, var(--ink) 42%, transparent);
    stroke-width: 1;
  }
  .ring--soft {
    stroke-dasharray: 3 4;
  }
  .seat {
    fill: color-mix(in oklab, var(--ink) 30%, transparent);
  }
  .seat--on {
    fill: color-mix(in oklab, var(--ink) 78%, transparent);
  }
  /* the one place the accent goes, per drawing */
  .ln--c {
    stroke: var(--accent);
    stroke-width: 1.7;
  }
  .ring--c {
    stroke: var(--accent);
    stroke-width: 1.6;
  }
  .slot {
    fill: color-mix(in oklab, var(--accent) 14%, transparent);
    stroke: var(--accent);
    stroke-width: 1.4;
  }
  .monogram {
    font-family: var(--display);
    font-size: 40px;
    fill: color-mix(in oklab, var(--ink) 70%, transparent);
  }
</style>
