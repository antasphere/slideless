<!-- The drawing on an app's card on the Apps page, in the hand of the
     brand's line figures: ink at low opacity, boxes filled with the bar's
     paper, the ringed dot as the focal marker, the accent used ONCE,
     on what carries the meaning. One literal picture per known tool: the
     ledger and its coin (finance), three seats narrowing into one (hiring),
     the clock and the day sheet (meet), two contact cards tied by a line
     (crm), a tree of three boxes and its key (steward), concentric rings with
     a seat on the outer one (the account, `hub`); this tool's own card, when
     its slug is none of those, draws this tool's concept (`here`: in the
     template the items, three named sheets and the project that holds them;
     a tool born from the template redraws it); any other slug gets a plate
     with its first letter in the display serif. -->
<script lang="ts">
  interface Props {
    slug: string;
    /** The name the monogram reads its letter from, for an unknown slug. */
    name?: string;
    /** This very tool: an unknown slug draws this tool's own concept rather than a monogram. */
    current?: boolean;
  }

  let { slug, name = '', current = false }: Props = $props();

  const KNOWN = new Set(['finance', 'hiring', 'meet', 'crm', 'steward', 'hub', 'account']);
  const kind = $derived(KNOWN.has(slug) ? (slug === 'account' ? 'hub' : slug) : current ? 'here' : 'other');
  const letter = $derived((name.trim() || slug).charAt(0).toUpperCase());

  // the hub's seat sits on the outer ring, up and to the right
  const SEAT_ANGLE = (-40 * Math.PI) / 180;
  const seatX = 120 + 40 * Math.cos(SEAT_ANGLE);
  const seatY = 58 + 40 * Math.sin(SEAT_ANGLE);
</script>

<svg viewBox="0 0 240 116" class="drawing" aria-hidden="true">
  <!-- the ground every drawing stands on -->
  <line class="ln ln--thin" x1="14" y1="106" x2="226" y2="106" />

  {#if kind === 'finance'}
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
  {:else if kind === 'hiring'}
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
  {:else if kind === 'meet'}
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
  {:else if kind === 'crm'}
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
  {:else if kind === 'steward'}
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
  {:else if kind === 'hub'}
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
  {:else if kind === 'here'}
    <!-- this tool: three named sheets in the project that holds them -->
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
